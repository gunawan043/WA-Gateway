import { ConflictException, Injectable, NotFoundException, Optional, UnauthorizedException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import { User } from './entities/user.entity';
import { UserSession } from './entities/user-session.entity';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';
import { hashApiKey } from './api-key-hash';
import { dummyPasswordHash, hashPassword, verifyPassword } from './password-hash';
import { SessionAuthService } from './session-auth.service';
import { AuthService } from './auth.service';
import { AssignmentsService, type AssignmentSpec } from './assignments.service';
import { createLogger } from '../../common/services/logger.service';

export interface CreateUserInput {
  email: string;
  name: string;
  role: ApiKeyRole;
  password: string;
  /**
   * The grants the account receives. Required by `POST /auth/users`: a new account never gets
   * global access implicitly (docs/35 §35.4.1). An empty list is refused before the row is written.
   */
  assignments?: AssignmentSpec[];
  /** The key that created the account, recorded on each assignment it grants. */
  grantedByKeyId?: string | null;
}

export interface UpdateUserInput {
  name?: string;
  role?: ApiKeyRole;
  isActive?: boolean;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Dashboard accounts.
 *
 * Every account owns one `api_keys` row, created and updated here and never handed out: a password
 * login resolves to that row, which is what every other part of the gateway already understands. The
 * two rows are written in one `main` transaction so a failed insert cannot leave a key with no owner
 * (or an owner with no key).
 */
@Injectable()
export class UsersService {
  private readonly logger = createLogger('UsersService');

  constructor(
    @InjectRepository(User, 'main')
    private readonly userRepository: Repository<User>,
    @InjectRepository(ApiKey, 'main')
    private readonly apiKeyRepository: Repository<ApiKey>,
    @InjectDataSource('main')
    private readonly dataSource: DataSource,
    private readonly sessions: SessionAuthService,
    // Optional so a spec can build the service without the assignments table; the grants are then
    // simply not written, which is only reachable from a test.
    @Optional() private readonly assignments?: AssignmentsService,
  ) {}

  async findAll(): Promise<User[]> {
    return this.userRepository.find({ order: { createdAt: 'DESC' } });
  }

  async findOne(id: string): Promise<User> {
    const user = await this.userRepository.findOne({ where: { id } });
    if (!user) throw new NotFoundException(`User with id '${id}' not found`);
    return user;
  }

  async count(): Promise<number> {
    return this.userRepository.count();
  }

  /**
   * The account behind an email/password pair, or null.
   *
   * An unknown email still pays for one scrypt verification (against a dummy hash) and an inactive
   * account answers exactly like a wrong password: the route must not become an oracle for which
   * addresses exist or which of them were disabled.
   */
  async authenticate(email: string, password: string): Promise<User | null> {
    const user = await this.userRepository.findOne({ where: { email: normalizeEmail(email) } });
    if (!user || !user.isActive) {
      await verifyPassword(password, await dummyPasswordHash());
      return null;
    }
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) return null;
    await this.userRepository.update({ id: user.id }, { lastLoginAt: new Date() });
    return user;
  }

  async create(input: CreateUserInput): Promise<User> {
    const email = normalizeEmail(input.email);
    if (await this.userRepository.findOne({ where: { email } })) {
      throw new ConflictException('A user with that email already exists');
    }

    const passwordHash = await hashPassword(input.password);
    const rawKey = `owa_k1_${randomBytes(32).toString('hex')}`;
    const grants = input.assignments ?? [];

    const saved = await this.dataSource.transaction(async manager => {
      const key = manager.create(ApiKey, {
        name: input.name,
        keyHash: hashApiKey(rawKey, process.env.API_KEY_PEPPER),
        keyPrefix: rawKey.substring(0, 12),
        role: input.role,
        allowedIps: null,
        allowedSessions: null,
        allowedChats: null,
        expiresAt: null,
      });
      const savedKey = await manager.save(key);

      const user = manager.create(User, {
        email,
        name: input.name,
        passwordHash,
        role: input.role,
        isActive: true,
        apiKeyId: savedKey.id,
        lastLoginAt: null,
      });
      const savedUser = await manager.save(user);

      // Same transaction as the key and the account: an account can never exist without the grants
      // that make it usable, and a grant can never point at a half-written account.
      if (grants.length > 0 && this.assignments) {
        await this.assignments.insertForNewUser(manager, {
          apiKeyId: savedKey.id,
          userId: savedUser.id,
          specs: grants,
          grantedByKeyId: input.grantedByKeyId ?? null,
        });
      }
      return savedUser;
    });

    this.logger.log(`User created: ${saved.email}`, {
      userId: saved.id,
      role: saved.role,
      action: 'user_created',
    });
    return saved;
  }

  async update(id: string, input: UpdateUserInput): Promise<User> {
    const user = await this.findOne(id);
    const nextRole = input.role ?? user.role;
    const nextActive = input.isActive ?? user.isActive;

    const losesAdmin = user.role === ApiKeyRole.ADMIN && (nextRole !== ApiKeyRole.ADMIN || !nextActive);
    if (losesAdmin) {
      await this.assertAnotherUsableAdmin(user.apiKeyId);
    }

    const patch: Partial<User> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.role !== undefined) patch.role = input.role;
    if (input.isActive !== undefined) patch.isActive = input.isActive;

    const saved = await this.dataSource.transaction(async manager => {
      if (Object.keys(patch).length > 0) {
        await manager.update(User, { id }, patch);
      }
      const keyPatch: Partial<ApiKey> = {};
      if (input.name !== undefined) keyPatch.name = input.name;
      if (input.role !== undefined) keyPatch.role = input.role;
      if (input.isActive !== undefined) keyPatch.isActive = input.isActive;
      if (Object.keys(keyPatch).length > 0) {
        await manager.update(ApiKey, { id: user.apiKeyId }, keyPatch);
      }
      return manager.findOneOrFail(User, { where: { id } });
    });

    // A disabled account must stop working now, not when its token happens to expire.
    if (input.isActive === false) {
      await this.sessions.revokeAllForUser(id);
    }

    this.logger.log(`User updated: ${saved.email}`, { userId: saved.id, action: 'user_updated' });
    return saved;
  }

  async remove(id: string): Promise<User> {
    const user = await this.findOne(id);
    if (user.role === ApiKeyRole.ADMIN) {
      await this.assertAnotherUsableAdmin(user.apiKeyId);
    }

    await this.dataSource.transaction(async manager => {
      await manager.delete(UserSession, { userId: id });
      await manager.delete(User, { id });
      await manager.delete(ApiKey, { id: user.apiKeyId });
    });

    this.logger.log(`User deleted: ${user.email}`, { userId: id, action: 'user_deleted' });
    return user;
  }

  /** Sets a new password and cuts every live session, including the one that asked. */
  async resetPassword(id: string, password: string): Promise<User> {
    const user = await this.findOne(id);
    await this.userRepository.update({ id }, { passwordHash: await hashPassword(password) });
    await this.sessions.revokeAllForUser(id);
    this.logger.log(`Password reset: ${user.email}`, { userId: id, action: 'user_password_reset' });
    return this.findOne(id);
  }

  /**
   * Self-service change: the current password is proof of possession, so a stolen session token
   * alone cannot take the account over. Other sessions are cut; this one keeps working.
   */
  async changeOwnPassword(
    id: string,
    currentPassword: string,
    newPassword: string,
    keepSessionId?: string,
  ): Promise<void> {
    const user = await this.findOne(id);
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    await this.userRepository.update({ id }, { passwordHash: await hashPassword(newPassword) });
    await this.sessions.revokeAllForUser(id, keepSessionId);
    this.logger.log(`Password changed: ${user.email}`, { userId: id, action: 'user_password_changed' });
  }

  /**
   * The admin lockout guard, judged on the keys rather than the users: the linked key of every user
   * lives in `api_keys`, so "another usable admin key that is not this account's" covers a second
   * dashboard admin and a hand-minted API admin alike.
   *
   * From Fase 1 the survivor must be able to manage keys as the design defines it: a global
   * `system_admin` assignment, or a legacy ADMIN key that has no assignment at all (35.4.4). The
   * legacy query below is the fallback for a service built without the assignment tables.
   */
  private async assertAnotherUsableAdmin(excludingKeyId: string): Promise<void> {
    if (this.assignments) {
      if ((await this.assignments.countGlobalAdmins({ apiKeyId: excludingKeyId })) === 0) {
        throw new ConflictException('Cannot remove the last admin: create another admin user or admin API key first');
      }
      return;
    }

    const survivors = await this.apiKeyRepository
      .createQueryBuilder('key')
      .where('key.id != :id', { id: excludingKeyId })
      .andWhere('key.role = :role', { role: ApiKeyRole.ADMIN })
      .andWhere('key.isActive = 1')
      .andWhere('(key.expiresAt IS NULL OR key.expiresAt > :now)', { now: AuthService.guardNowParam() })
      .andWhere("(key.allowedSessions IS NULL OR key.allowedSessions = '')")
      .andWhere("(key.allowedChats IS NULL OR key.allowedChats = '')")
      .getCount();

    if (survivors === 0) {
      throw new ConflictException('Cannot remove the last admin: create another admin user or admin API key first');
    }
  }
}
