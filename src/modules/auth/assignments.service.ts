import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';
import { RoleAssignment } from './entities/role-assignment.entity';
import { User } from './entities/user.entity';
import { Session } from '../session/entities/session.entity';
import { Division } from '../division/entities/division.entity';
import { AuthService } from './auth.service';
import { PermissionService } from './permission.service';
import { ROLE_NAMES, SCOPE_TYPES, isRoleName, isScopeType, type RoleName, type ScopeType } from './permissions';
import type { AssignmentInputDto, UpdateAssignmentDto } from './dto';

/** A validated grant, ready to be written. */
export interface AssignmentSpec {
  role: RoleName;
  scopeType: ScopeType;
  scopeId: string;
  validFrom: Date | null;
  validTo: Date | null;
}

/** The chat-id shapes the object scope accepts. A bare number or group id is refused. */
const CHAT_ID = /^[^\s@]+@(g\.us|c\.us|lid|s\.whatsapp\.net|broadcast|newsletter)$/;

/**
 * Writes and reads `role_assignments` (docs/35 §35.5.6).
 *
 * Every write runs in one `main` transaction: the rows and the `api_keys.authzVersion` bump commit
 * together, so a reader never sees a grant whose cache marker has not moved. The cache and the live
 * sockets are invalidated only AFTER the commit, so a rolled-back write cannot disconnect a client
 * or drop a cached authority that is still correct.
 *
 * Scope existence is checked against the `data` connection; `main` holds no foreign keys.
 */
@Injectable()
export class AssignmentsService {
  constructor(
    @InjectRepository(RoleAssignment, 'main')
    private readonly assignments: Repository<RoleAssignment>,
    @InjectRepository(ApiKey, 'main')
    private readonly apiKeys: Repository<ApiKey>,
    @InjectRepository(User, 'main')
    private readonly users: Repository<User>,
    @InjectRepository(Session, 'data')
    private readonly sessions: Repository<Session>,
    @InjectRepository(Division, 'data')
    private readonly divisions: Repository<Division>,
    @InjectDataSource('main')
    private readonly dataSource: DataSource,
    private readonly permissions: PermissionService,
    private readonly auth: AuthService,
  ) {}

  async list(apiKeyId: string): Promise<RoleAssignment[]> {
    if (!(await this.apiKeys.count({ where: { id: apiKeyId } }))) {
      throw new NotFoundException(`API key with id '${apiKeyId}' not found`);
    }
    return this.assignments.find({ where: { apiKeyId }, order: { createdAt: 'ASC' } });
  }

  async findOne(id: string): Promise<RoleAssignment> {
    const row = await this.assignments.findOne({ where: { id } });
    if (!row) throw new NotFoundException(`Assignment with id '${id}' not found`);
    return row;
  }

  /** Every assignment of a set of keys, in one statement — the account list's N+1 guard. */
  async listForKeys(apiKeyIds: readonly string[]): Promise<RoleAssignment[]> {
    if (apiKeyIds.length === 0) return [];
    return this.assignments.find({ where: { apiKeyId: In([...apiKeyIds]) }, order: { createdAt: 'ASC' } });
  }

  /** Validates one input into a spec: role, scope, scope id shape and the validity window. */
  specFrom(input: AssignmentInputDto, now = new Date()): AssignmentSpec {
    if (!isRoleName(input.role)) {
      throw new BadRequestException(`role must be one of: ${ROLE_NAMES.join(', ')}`);
    }
    if (input.scopeType === 'unit') {
      throw new BadRequestException(
        "scopeType 'unit' is reserved for Fase 4; use global, session, team or object in Fase 1",
      );
    }
    if (!isScopeType(input.scopeType)) {
      throw new BadRequestException(`scopeType must be one of: ${SCOPE_TYPES.join(', ')}`);
    }
    const window = windowOrder(input.validFrom, input.validTo, now);
    return {
      role: input.role,
      scopeType: input.scopeType,
      scopeId: this.scopeIdFor(input.scopeType, input.scopeId),
      validFrom: window.validFrom,
      validTo: window.validTo,
    };
  }

  /** The `data`-side existence checks a grant must pass before it is written. */
  async assertScopeExists(spec: AssignmentSpec): Promise<void> {
    if (spec.scopeType === 'session') {
      if (!(await this.sessions.count({ where: { id: spec.scopeId } }))) {
        throw new BadRequestException(`No session with id '${spec.scopeId}'`);
      }
      return;
    }
    if (spec.scopeType === 'team') {
      if (!(await this.divisions.count({ where: { id: spec.scopeId } }))) {
        throw new BadRequestException(`No division with id '${spec.scopeId}'`);
      }
    }
    // `object` needs a well-formed chat id only: a chat is a WhatsApp identifier, not a row here.
  }

  /**
   * No escalation by granting: a key may only hand out a scope it can itself reach, and only a
   * globally scoped key may grant `global` (35.5.6).
   */
  async assertGrantable(actor: ApiKey, specs: readonly AssignmentSpec[]): Promise<void> {
    const access = await this.permissions.effective(actor);
    if (access.scope.global) return;

    for (const spec of specs) {
      if (spec.scopeType === 'global') {
        throw new ForbiddenException('Only a globally scoped key may grant global scope');
      }
      const reachable =
        spec.scopeType === 'session'
          ? access.scope.sessionIds
          : spec.scopeType === 'team'
            ? access.scope.divisionIds
            : access.scope.chatIds;
      if (!reachable.has(spec.scopeId)) {
        throw new ForbiddenException('Cannot grant a scope outside your own');
      }
    }
  }

  async create(input: AssignmentInputDto & { apiKeyId: string }, actor: ApiKey): Promise<RoleAssignment> {
    const apiKey = await this.apiKeys.findOne({ where: { id: input.apiKeyId } });
    if (!apiKey) throw new NotFoundException(`API key with id '${input.apiKeyId}' not found`);

    const spec = this.specFrom(input);
    await this.assertScopeExists(spec);
    await this.assertGrantable(actor, [spec]);

    const owner = await this.users.findOne({ where: { apiKeyId: apiKey.id } });

    let saved: RoleAssignment;
    try {
      saved = await this.dataSource.transaction(async manager => {
        const row = manager.create(RoleAssignment, {
          apiKeyId: apiKey.id,
          userId: owner?.id ?? null,
          role: spec.role,
          scopeType: spec.scopeType,
          scopeId: spec.scopeId,
          source: 'local',
          externalId: null,
          validFrom: spec.validFrom,
          validTo: spec.validTo,
          grantedByKeyId: actor.id,
        });
        const written = await manager.save(row);
        await manager.increment(ApiKey, { id: apiKey.id }, 'authzVersion', 1);
        return written;
      });
    } catch (err) {
      throw this.asConflict(err, 'That assignment already exists');
    }

    this.auth.invalidateAuthorization(apiKey.id);
    return saved;
  }

  async update(id: string, input: UpdateAssignmentDto, actor: ApiKey): Promise<RoleAssignment> {
    const row = await this.findOne(id);

    const spec = this.specFrom({
      role: input.role ?? row.role,
      scopeType: input.scopeType ?? row.scopeType,
      scopeId: input.scopeId ?? row.scopeId,
      validFrom:
        input.validFrom === undefined ? (row.validFrom?.toISOString() ?? undefined) : (input.validFrom ?? undefined),
      validTo: input.validTo === undefined ? (row.validTo?.toISOString() ?? undefined) : (input.validTo ?? undefined),
    });
    await this.assertScopeExists(spec);
    await this.assertGrantable(actor, [spec]);

    if (isGlobalSystemAdmin(row) && !(spec.role === 'system_admin' && spec.scopeType === 'global')) {
      await this.assertAnotherGlobalAdmin(row.id);
    }

    let saved: RoleAssignment;
    try {
      saved = await this.dataSource.transaction(async manager => {
        await manager.update(
          RoleAssignment,
          { id },
          {
            role: spec.role,
            scopeType: spec.scopeType,
            scopeId: spec.scopeId,
            validFrom: spec.validFrom,
            validTo: spec.validTo,
          },
        );
        await manager.increment(ApiKey, { id: row.apiKeyId }, 'authzVersion', 1);
        return manager.findOneOrFail(RoleAssignment, { where: { id } });
      });
    } catch (err) {
      throw this.asConflict(err, 'That assignment already exists');
    }

    this.auth.invalidateAuthorization(row.apiKeyId);
    return saved;
  }

  async remove(id: string): Promise<RoleAssignment> {
    const row = await this.findOne(id);
    if (isGlobalSystemAdmin(row)) {
      await this.assertAnotherGlobalAdmin(row.id);
    }

    await this.dataSource.transaction(async manager => {
      await manager.delete(RoleAssignment, { id });
      await manager.increment(ApiKey, { id: row.apiKeyId }, 'authzVersion', 1);
    });

    this.auth.invalidateAuthorization(row.apiKeyId);
    return row;
  }

  /** Normalises the grants of a new account. Existence is checked; the actor check is separate. */
  async prepareForNewUser(inputs: readonly AssignmentInputDto[]): Promise<AssignmentSpec[]> {
    if (inputs.length === 0) {
      throw new BadRequestException('assignments is required: a new account never gets global access implicitly');
    }
    const specs = inputs.map(input => this.specFrom(input));
    for (const spec of specs) await this.assertScopeExists(spec);
    return specs;
  }

  /** Writes the grants of a new account inside the caller's transaction. */
  async insertForNewUser(
    manager: EntityManager,
    args: { apiKeyId: string; userId: string; specs: readonly AssignmentSpec[]; grantedByKeyId: string | null },
  ): Promise<void> {
    for (const spec of args.specs) {
      await manager.save(
        manager.create(RoleAssignment, {
          apiKeyId: args.apiKeyId,
          userId: args.userId,
          role: spec.role,
          scopeType: spec.scopeType,
          scopeId: spec.scopeId,
          source: 'local',
          externalId: null,
          validFrom: spec.validFrom,
          validTo: spec.validTo,
          grantedByKeyId: args.grantedByKeyId,
        }),
      );
    }
  }

  /**
   * How many keys can still manage the deployment, ignoring one assignment or one key (35.4.4).
   *
   * A survivor is an active, unexpired, unscoped key holding a global `system_admin` assignment,
   * or — during the transition — an active unscoped ADMIN key that has no assignment at all and so
   * still authorizes through the legacy column. A session- or chat-scoped key is not counted: the
   * key-lifecycle routes are fenced behind `@RequireUnscopedKey`, so it could not manage keys even
   * if it held the role.
   */
  async countGlobalAdmins(exclude: { assignmentId?: string; apiKeyId?: string } = {}): Promise<number> {
    const now = AuthService.guardNowParam();

    const assigned = this.assignments
      .createQueryBuilder('ra')
      .innerJoin(ApiKey, 'key', 'key.id = ra.apiKeyId')
      .where('ra.role = :role', { role: 'system_admin' })
      .andWhere("ra.scopeType = 'global'")
      .andWhere('(ra.validFrom IS NULL OR ra.validFrom <= :now)', { now })
      .andWhere('(ra.validTo IS NULL OR ra.validTo > :now)', { now })
      .andWhere('key.isActive = 1')
      .andWhere('(key.expiresAt IS NULL OR key.expiresAt > :now)', { now })
      .andWhere("(key.allowedSessions IS NULL OR key.allowedSessions = '')")
      .andWhere("(key.allowedChats IS NULL OR key.allowedChats = '')");
    if (exclude.assignmentId)
      assigned.andWhere('ra.id != :excludedAssignment', { excludedAssignment: exclude.assignmentId });
    if (exclude.apiKeyId) assigned.andWhere('ra.apiKeyId != :excludedKey', { excludedKey: exclude.apiKeyId });

    const legacy = this.apiKeys
      .createQueryBuilder('key')
      .where('key.role = :role', { role: ApiKeyRole.ADMIN })
      .andWhere('key.isActive = 1')
      .andWhere('(key.expiresAt IS NULL OR key.expiresAt > :now)', { now })
      .andWhere("(key.allowedSessions IS NULL OR key.allowedSessions = '')")
      .andWhere("(key.allowedChats IS NULL OR key.allowedChats = '')")
      .andWhere('NOT EXISTS (SELECT 1 FROM "role_assignments" "ra" WHERE "ra"."apiKeyId" = "key"."id")');
    if (exclude.apiKeyId) legacy.andWhere('key.id != :excludedKey', { excludedKey: exclude.apiKeyId });

    return (await assigned.getCount()) + (await legacy.getCount());
  }

  private async assertAnotherGlobalAdmin(excludedAssignmentId: string): Promise<void> {
    if ((await this.countGlobalAdmins({ assignmentId: excludedAssignmentId })) === 0) {
      throw new ConflictException(
        'Cannot remove the last global administrator: grant system_admin globally to another active account first',
      );
    }
  }

  private scopeIdFor(scopeType: ScopeType, raw: string | undefined): string {
    const scopeId = (raw ?? '').trim();
    if (scopeType === 'global') return '';
    if (scopeId.length === 0) {
      throw new BadRequestException(`scopeId is required for scopeType '${scopeType}'`);
    }
    if (scopeType === 'object' && !CHAT_ID.test(scopeId)) {
      throw new BadRequestException(`scopeId must be a chat id (e.g. '123@g.us' or '62812@c.us')`);
    }
    return scopeId;
  }

  private asConflict(err: unknown, message: string): unknown {
    const text = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed|duplicate key value/i.test(text)) return new ConflictException(message);
    return err;
  }
}

function isGlobalSystemAdmin(row: RoleAssignment): boolean {
  return row.role === 'system_admin' && row.scopeType === 'global';
}

function parseWindow(value: string | null | undefined, field: string): Date | null {
  if (value === undefined || value === null || value === '') return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) throw new BadRequestException(`${field} is not a parseable date`);
  return at;
}

function windowOrder(
  from: string | undefined,
  to: string | undefined,
  now: Date,
): { validFrom: Date | null; validTo: Date | null } {
  const validFrom = parseWindow(from, 'validFrom');
  const validTo = parseWindow(to, 'validTo');
  if (validFrom && validTo && validTo <= validFrom) {
    throw new BadRequestException('validTo must be after validFrom');
  }
  // A grant that has already ended would be created invisible; refuse it instead of storing a row
  // that never applies and looks like a bug in the UI.
  if (validTo && validTo <= now) {
    throw new BadRequestException('validTo is in the past');
  }
  return { validFrom, validTo };
}
