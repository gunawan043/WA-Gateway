import 'reflect-metadata';
import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';
import { User } from './entities/user.entity';
import { UserSession } from './entities/user-session.entity';
import { AuthService } from './auth.service';
import { ApiKeyUsageTracker } from './api-key-usage-tracker.service';
import { SessionAuthService } from './session-auth.service';
import { UsersService, normalizeEmail } from './users.service';
import { verifyPassword } from './password-hash';

/**
 * A real in-memory DataSource: the transaction that creates the account and its key is the thing
 * under test, and a mocked manager would not show whether both rows actually land.
 */
describe('UsersService', () => {
  let ds: DataSource;
  let users: Repository<User>;
  let keys: Repository<ApiKey>;
  let sessions: Repository<UserSession>;
  let service: UsersService;

  const PASSWORD = 'first-password-1234';

  beforeAll(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [ApiKey, User, UserSession],
      synchronize: true,
    });
    await ds.initialize();
    users = ds.getRepository(User);
    keys = ds.getRepository(ApiKey);
    sessions = ds.getRepository(UserSession);

    const tracker = { record: jest.fn(), forget: jest.fn() } as unknown as ApiKeyUsageTracker;
    const authService = new AuthService(keys, tracker, { get: () => undefined } as never);
    const sessionAuth = new SessionAuthService(users, sessions, keys, authService, {
      get: (_key: string, fallback?: unknown) => fallback,
    } as never);
    service = new UsersService(users, keys, ds, sessionAuth);
  });

  afterAll(async () => {
    await ds.destroy();
  });

  beforeEach(async () => {
    await sessions.clear();
    await users.clear();
    await keys.clear();
  });

  const makeUser = async (email: string, role = ApiKeyRole.OPERATOR): Promise<User> =>
    service.create({ email, name: `Name of ${email}`, role, password: PASSWORD });

  describe('normalizeEmail', () => {
    it('trims and lowercases, so the unique index is the identity', () => {
      expect(normalizeEmail('  Admin@Example.COM ')).toBe('admin@example.com');
    });
  });

  describe('create', () => {
    it('writes the account and its linked key together', async () => {
      const user = await service.create({
        email: '  Owner@Example.com ',
        name: 'Owner',
        role: ApiKeyRole.ADMIN,
        password: PASSWORD,
      });

      expect(user.email).toBe('owner@example.com');
      expect(user.role).toBe(ApiKeyRole.ADMIN);
      expect(user.isActive).toBe(true);

      const key = await keys.findOneByOrFail({ id: user.apiKeyId });
      expect(key.name).toBe('Owner');
      expect(key.role).toBe(ApiKeyRole.ADMIN);
      expect(key.isActive).toBe(true);
      // The plaintext key is generated and dropped: only its hash and a display prefix remain.
      expect(key.keyHash).toMatch(/^[0-9a-f]{64}$/);
      expect(key.keyPrefix).toHaveLength(12);
      expect(key.keyPrefix.startsWith('owa_k1_')).toBe(true);
      expect(key.allowedSessions).toBeNull();
      expect(key.allowedChats).toBeNull();
      expect(key.allowedIps).toBeNull();
      expect(key.expiresAt).toBeNull();
    });

    it('stores a scrypt hash, never the password', async () => {
      const user = await makeUser('hash@example.com');
      expect(user.passwordHash).not.toContain(PASSWORD);
      expect(user.passwordHash.startsWith('scrypt$')).toBe(true);
      expect(await verifyPassword(PASSWORD, user.passwordHash)).toBe(true);
    });

    it('refuses a second account with the same email, whatever the case', async () => {
      await makeUser('dup@example.com');
      await expect(makeUser('DUP@example.com')).rejects.toBeInstanceOf(ConflictException);
      await expect(users.count()).resolves.toBe(1);
      await expect(keys.count()).resolves.toBe(1);
    });

    it('leaves no key behind when the insert fails', async () => {
      // Fail the second write of the transaction: the key is already inserted at that point, so this
      // asserts the rollback rather than the happy path's ordering.
      const realTransaction = ds.transaction.bind(ds);
      jest.spyOn(ds, 'transaction').mockImplementationOnce(((run: (manager: EntityManager) => Promise<unknown>) =>
        realTransaction(manager => {
          const target = manager as { save: (...args: unknown[]) => unknown };
          const realSave = target.save.bind(manager);
          target.save = (entity: unknown, value: unknown) => {
            // save() takes either (entity) or (target, entity); both spellings are used here.
            const isUserWrite = entity === User || entity instanceof User;
            if (isUserWrite) throw new Error('disk full');
            return realSave(entity, value);
          };
          return run(manager);
        })) as never);

      await expect(makeUser('atomic@example.com')).rejects.toThrow('disk full');
      await expect(keys.count()).resolves.toBe(0);
      await expect(users.count()).resolves.toBe(0);
    });
  });

  describe('authenticate', () => {
    it('returns the account and stamps lastLoginAt', async () => {
      const created = await makeUser('login@example.com');
      const user = await service.authenticate('  LOGIN@example.com ', PASSWORD);
      expect(user?.id).toBe(created.id);
      expect((await users.findOneByOrFail({ id: created.id })).lastLoginAt).not.toBeNull();
    });

    it('returns null for a wrong password, an unknown email and a disabled account', async () => {
      const created = await makeUser('nope@example.com');
      await expect(service.authenticate('nope@example.com', 'wrong-password-000')).resolves.toBeNull();
      await expect(service.authenticate('missing@example.com', PASSWORD)).resolves.toBeNull();
      await users.update({ id: created.id }, { isActive: false });
      await expect(service.authenticate('nope@example.com', PASSWORD)).resolves.toBeNull();
    });
  });

  describe('update', () => {
    it('mirrors name, role and isActive onto the linked key', async () => {
      const user = await makeUser('mirror@example.com');
      await service.update(user.id, { name: 'Renamed', role: ApiKeyRole.VIEWER, isActive: false });

      const key = await keys.findOneByOrFail({ id: user.apiKeyId });
      expect(key).toMatchObject({ name: 'Renamed', role: ApiKeyRole.VIEWER, isActive: false });
      expect(await users.findOneByOrFail({ id: user.id })).toMatchObject({
        name: 'Renamed',
        role: ApiKeyRole.VIEWER,
        isActive: false,
      });
    });

    it('revokes every session when the account is disabled', async () => {
      const user = await makeUser('disable@example.com');
      const authService = new AuthService(
        keys,
        { record: jest.fn(), forget: jest.fn() } as never,
        {
          get: () => undefined,
        } as never,
      );
      const sessionAuth = new SessionAuthService(users, sessions, keys, authService, {
        get: (_key: string, fallback?: unknown) => fallback,
      } as never);
      await sessionAuth.issue(user);
      await service.update(user.id, { isActive: false });

      // Revoking keeps the row (the WebSocket sweep re-reads it); it marks it, it does not delete it.
      const rows = await sessions.find();
      expect(rows).toHaveLength(1);
      expect(rows[0].revokedAt).not.toBeNull();
    });

    it('404s an unknown id', async () => {
      await expect(service.update('00000000-0000-0000-0000-000000000000', { name: 'x' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('refuses to demote or disable the last admin', async () => {
      const admin = await makeUser('sole-admin@example.com', ApiKeyRole.ADMIN);
      await expect(service.update(admin.id, { role: ApiKeyRole.OPERATOR })).rejects.toBeInstanceOf(ConflictException);
      await expect(service.update(admin.id, { isActive: false })).rejects.toBeInstanceOf(ConflictException);
      expect(await users.findOneByOrFail({ id: admin.id })).toMatchObject({ role: ApiKeyRole.ADMIN, isActive: true });
    });

    it('counts a hand-minted admin key as a surviving admin', async () => {
      const admin = await makeUser('with-backup@example.com', ApiKeyRole.ADMIN);
      await keys.save(
        keys.create({
          name: 'CI admin',
          keyPrefix: 'owa_k1_backup',
          keyHash: 'b'.repeat(64),
          role: ApiKeyRole.ADMIN,
          isActive: true,
          expiresAt: null,
          allowedIps: null,
          allowedSessions: null,
          allowedChats: null,
        }),
      );
      await expect(service.update(admin.id, { role: ApiKeyRole.OPERATOR })).resolves.toMatchObject({
        role: ApiKeyRole.OPERATOR,
      });
    });
  });

  describe('remove', () => {
    it('deletes the account, its sessions and its key', async () => {
      const user = await makeUser('delete@example.com');
      const keyId = user.apiKeyId;
      const authService = new AuthService(
        keys,
        { record: jest.fn(), forget: jest.fn() } as never,
        {
          get: () => undefined,
        } as never,
      );
      const sessionAuth = new SessionAuthService(users, sessions, keys, authService, {
        get: (_key: string, fallback?: unknown) => fallback,
      } as never);
      await sessionAuth.issue(user);

      await service.remove(user.id);
      await expect(users.findOneBy({ id: user.id })).resolves.toBeNull();
      await expect(keys.findOneBy({ id: keyId })).resolves.toBeNull();
      await expect(sessions.count()).resolves.toBe(0);
    });

    it('refuses to remove the last admin', async () => {
      const admin = await makeUser('last@example.com', ApiKeyRole.ADMIN);
      await expect(service.remove(admin.id)).rejects.toBeInstanceOf(ConflictException);
      await expect(users.findOneBy({ id: admin.id })).resolves.not.toBeNull();
    });
  });

  describe('passwords', () => {
    it('resetPassword sets a new hash and cuts every session', async () => {
      const user = await makeUser('reset@example.com');
      const authService = new AuthService(
        keys,
        { record: jest.fn(), forget: jest.fn() } as never,
        {
          get: () => undefined,
        } as never,
      );
      const sessionAuth = new SessionAuthService(users, sessions, keys, authService, {
        get: (_key: string, fallback?: unknown) => fallback,
      } as never);
      await sessionAuth.issue(user);

      await service.resetPassword(user.id, 'brand-new-password-99');
      const stored = await users.findOneByOrFail({ id: user.id });
      expect(await verifyPassword('brand-new-password-99', stored.passwordHash)).toBe(true);
      expect(await verifyPassword(PASSWORD, stored.passwordHash)).toBe(false);
      const rows = await sessions.find();
      expect(rows).toHaveLength(1);
      expect(rows[0].revokedAt).not.toBeNull();
    });

    it('changeOwnPassword requires the current password', async () => {
      const user = await makeUser('self@example.com');
      await expect(service.changeOwnPassword(user.id, 'not-the-password', 'new-password-1234')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(await verifyPassword(PASSWORD, (await users.findOneByOrFail({ id: user.id })).passwordHash)).toBe(true);
    });

    it('changeOwnPassword cuts the other sessions and keeps the caller', async () => {
      const user = await makeUser('keep@example.com');
      const authService = new AuthService(
        keys,
        { record: jest.fn(), forget: jest.fn() } as never,
        {
          get: () => undefined,
        } as never,
      );
      const sessionAuth = new SessionAuthService(users, sessions, keys, authService, {
        get: (_key: string, fallback?: unknown) => fallback,
      } as never);
      const other = await sessionAuth.issue(user);
      const caller = await sessionAuth.issue(user);

      await service.changeOwnPassword(user.id, PASSWORD, 'new-password-1234', caller.session.id);
      await expect(sessionAuth.resolve(other.token)).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(sessionAuth.resolve(caller.token)).resolves.toBeDefined();
      expect(
        await verifyPassword('new-password-1234', (await users.findOneByOrFail({ id: user.id })).passwordHash),
      ).toBe(true);
    });
  });

  describe('queries', () => {
    it('lists accounts newest first and counts them', async () => {
      const first = await makeUser('one@example.com');
      const second = await makeUser('two@example.com');
      await users.update({ id: first.id }, { createdAt: new Date(Date.now() - 60_000) });

      const all = await service.findAll();
      expect(all.map(user => user.id)).toEqual([second.id, first.id]);
      await expect(service.count()).resolves.toBe(2);
      await expect(service.findOne(first.id)).resolves.toMatchObject({ email: 'one@example.com' });
    });

    it('404s an unknown account', async () => {
      await expect(service.findOne('00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  /**
   * The SSO handoff maps `core_user_id` to an existing account and refuses to guess. These tests pin
   * the mapping rules the handoff relies on: one Core person to at most one account, no account
   * created by an unmapped id, and a mapping that can be cleared but never silently stolen.
   */
  describe('ALIM Core identity mapping', () => {
    it('finds the account by its Core id, trimming what Core sent', async () => {
      const user = await service.create({
        email: 'mapped@example.com',
        name: 'Mapped',
        role: ApiKeyRole.OPERATOR,
        password: PASSWORD,
        coreUserId: 'core-123',
      });

      await expect(service.findByCoreUserId('  core-123  ')).resolves.toMatchObject({ id: user.id });
      await expect(service.findByCoreUserId('core-999')).resolves.toBeNull();
    });

    it('treats a blank or missing Core id as no mapping, without a query', async () => {
      const findOne = jest.spyOn(users, 'findOne');

      await expect(service.findByCoreUserId('   ')).resolves.toBeNull();
      await expect(service.findByCoreUserId('')).resolves.toBeNull();
      expect(findOne).not.toHaveBeenCalled();
      findOne.mockRestore();
    });

    it('stores no mapping when the account is created without one', async () => {
      const user = await makeUser('unmapped@example.com');
      expect(user.coreUserId ?? null).toBeNull();
      await expect(service.findByCoreUserId('core-123')).resolves.toBeNull();
    });

    it('refuses to map one Core person to a second account', async () => {
      await service.create({
        email: 'first@example.com',
        name: 'First',
        role: ApiKeyRole.OPERATOR,
        password: PASSWORD,
        coreUserId: 'core-shared',
      });

      await expect(
        service.create({
          email: 'second@example.com',
          name: 'Second',
          role: ApiKeyRole.OPERATOR,
          password: PASSWORD,
          coreUserId: 'core-shared',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(users.count()).resolves.toBe(1);
    });

    it('moves a mapping, allows re-saving it, and clears it with null or a blank string', async () => {
      const target = await service.create({
        email: 'target@example.com',
        name: 'Target',
        role: ApiKeyRole.OPERATOR,
        password: PASSWORD,
      });
      const other = await service.create({
        email: 'other@example.com',
        name: 'Other',
        role: ApiKeyRole.OPERATOR,
        password: PASSWORD,
        coreUserId: 'core-other',
      });

      // A second account cannot claim a mapping that belongs to someone else.
      await expect(service.update(target.id, { coreUserId: 'core-other' })).rejects.toBeInstanceOf(ConflictException);
      // Re-saving the same value on the account that owns it is not a conflict.
      await expect(service.update(other.id, { coreUserId: 'core-other' })).resolves.toMatchObject({
        coreUserId: 'core-other',
      });

      await service.update(other.id, { coreUserId: null });
      await expect(service.findByCoreUserId('core-other')).resolves.toBeNull();
      await service.update(other.id, { coreUserId: 'core-again' });
      await service.update(other.id, { coreUserId: '   ' });
      await expect(service.findByCoreUserId('core-again')).resolves.toBeNull();
    });
  });
});
