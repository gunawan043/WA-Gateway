import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';
import { RoleAssignment } from './entities/role-assignment.entity';
import {
  BRIDGE_LEVELS,
  GLOBAL_ADMIN_ROLES,
  LEGACY_ROLE_TO_ROLE,
  ROLE_BRIDGE_LEVEL,
  ROLE_PERMISSIONS,
  isPermission,
  type Permission,
  type RoleName,
} from './permissions';

/** How long one key's resolved authority is reused. See the invalidation notes in docs/35 §35.5.4. */
export const ACCESS_CACHE_TTL_MS = 15_000;

/** The scope sets a list endpoint filters by. `null` means "everything". */
export interface ListScope {
  sessionIds: Set<string> | null;
  divisionIds: Set<string> | null;
  chatIds: Set<string> | null;
}

/** The object a permission is asked about. Any field the caller knows narrows the answer. */
export interface ResourceRef {
  sessionId?: string;
  divisionId?: string | null;
  chatId?: string;
}

export interface EffectiveAccess {
  roles: Set<RoleName>;
  permissions: Set<Permission>;
  scope: {
    global: boolean;
    sessionIds: Set<string>;
    divisionIds: Set<string>;
    chatIds: Set<string>;
  };
  /**
   * False when the key has no assignment and the answer came from `api_keys.role`. The bridge uses
   * it to keep the legacy level exact; a key with assignments never falls back to that column.
   */
  fromAssignments: boolean;
}

interface CacheEntry {
  access: EffectiveAccess;
  /** The key row the entry was built from, so a legacy role change is noticed immediately. */
  role: ApiKeyRole;
  authzVersion: number;
  expiresAt: number;
}

/**
 * Resolves what an API key may do (docs/35 §35.5).
 *
 * The answer is a union over the key's active assignments: their permissions, and the merge of
 * their scopes. A key with no assignment at all falls back to `api_keys.role`, which is the
 * compatibility path for machine keys and for a key created before Fase 1.
 *
 * Nothing here widens a credential fence: `allowedSessions` and `allowedChats` are enforced by
 * ApiKeyGuard before any of this runs, and `scope()` intersects them so a list filter cannot show a
 * session or chat the credential itself excludes.
 */
@Injectable()
export class PermissionService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    @InjectRepository(RoleAssignment, 'main')
    private readonly assignments: Repository<RoleAssignment>,
  ) {}

  /** Every assignment of a key whose validity window contains `now`, newest first. */
  async activeAssignments(apiKeyId: string, now = new Date()): Promise<RoleAssignment[]> {
    const rows = await this.assignments.find({ where: { apiKeyId }, order: { createdAt: 'ASC' } });
    return rows.filter(row => isActiveAt(row, now));
  }

  async effective(apiKey: ApiKey, now = new Date()): Promise<EffectiveAccess> {
    const cached = this.cache.get(apiKey.id);
    if (
      cached &&
      cached.expiresAt > now.getTime() &&
      cached.role === apiKey.role &&
      cached.authzVersion === (apiKey.authzVersion ?? 0)
    ) {
      return cached.access;
    }

    const rows = await this.activeAssignments(apiKey.id, now);
    const access = rows.length > 0 ? accessFromAssignments(rows) : accessFromLegacyRole(apiKey.role);

    // `validTo` bounds the cache, not the other way round: an entry must never outlive the earliest
    // assignment it was built from, even by one evaluation.
    let expiresAt = now.getTime() + ACCESS_CACHE_TTL_MS;
    for (const row of rows) {
      const validTo = row.validTo ? new Date(row.validTo).getTime() : null;
      if (validTo !== null && Number.isFinite(validTo)) expiresAt = Math.min(expiresAt, validTo - 1);
    }

    this.cache.set(apiKey.id, {
      access,
      role: apiKey.role,
      authzVersion: apiKey.authzVersion ?? 0,
      expiresAt,
    });
    return access;
  }

  async can(apiKey: ApiKey, permission: Permission, resource?: ResourceRef): Promise<boolean> {
    const access = await this.effective(apiKey);
    return allows(access, permission, resource);
  }

  /** Throws a 403 that names the missing permission, never the role that would have granted it. */
  async assert(apiKey: ApiKey, permissions: readonly Permission[], resource?: ResourceRef): Promise<void> {
    const access = await this.effective(apiKey);
    const missing = permissions.filter(permission => !allows(access, permission, resource));
    if (missing.length > 0) {
      throw new ForbiddenException(`Missing permission: ${missing.join(', ')}`);
    }
  }

  async permissionsOf(apiKey: ApiKey): Promise<Permission[]> {
    const access = await this.effective(apiKey);
    return [...access.permissions].sort();
  }

  async rolesOf(apiKey: ApiKey): Promise<RoleName[]> {
    const access = await this.effective(apiKey);
    return [...access.roles].sort();
  }

  /**
   * The level `@RequireRole` sees. A key with assignments never consults `api_keys.role`; a scoped
   * assignment is capped at OPERATOR so it cannot reach an ADMIN route through the bridge
   * (35.4.3, 35.9.2 decision 3).
   */
  async bridgeLevel(apiKey: ApiKey): Promise<ApiKeyRole> {
    const access = await this.effective(apiKey);
    if (!access.fromAssignments) return apiKey.role;

    let level = 0;
    for (const role of access.roles) {
      level = Math.max(level, BRIDGE_LEVELS[ROLE_BRIDGE_LEVEL[role]]);
    }
    const globalAdmin = access.scope.global && [...access.roles].some(role => GLOBAL_ADMIN_ROLES.has(role));
    if (!globalAdmin) level = Math.min(level, BRIDGE_LEVELS[ApiKeyRole.OPERATOR]);

    if (level >= BRIDGE_LEVELS[ApiKeyRole.ADMIN]) return ApiKeyRole.ADMIN;
    if (level >= BRIDGE_LEVELS[ApiKeyRole.OPERATOR]) return ApiKeyRole.OPERATOR;
    return ApiKeyRole.VIEWER;
  }

  /**
   * The scope a list endpoint filters by, already intersected with the key's own fences. A `null`
   * set means "no restriction on this dimension".
   */
  async scope(apiKey: ApiKey): Promise<ListScope> {
    const access = await this.effective(apiKey);
    const sessions = access.scope.global ? null : access.scope.sessionIds;
    const divisions = access.scope.global ? null : access.scope.divisionIds;
    const chats = access.scope.global ? null : access.scope.chatIds;

    return {
      sessionIds: intersectWithFence(sessions, apiKey.allowedSessions),
      divisionIds: divisions,
      chatIds: intersectWithFence(chats, apiKey.allowedChats),
    };
  }

  /** Drops a key's cached authority. Called in the same transaction as the assignment write. */
  invalidate(apiKeyId: string): void {
    this.cache.delete(apiKeyId);
  }

  /** Test seam: the cache is per-process and must not leak between cases. */
  clearCache(): void {
    this.cache.clear();
  }
}

export function isActiveAt(row: RoleAssignment, now: Date): boolean {
  const at = now.getTime();
  if (row.validFrom) {
    const from = new Date(row.validFrom).getTime();
    if (Number.isFinite(from) && from > at) return false;
  }
  if (row.validTo) {
    const to = new Date(row.validTo).getTime();
    // An unparseable expiry is treated as already over, never as "never expires".
    if (!Number.isFinite(to) || to <= at) return false;
  }
  return true;
}

function accessFromLegacyRole(role: ApiKeyRole): EffectiveAccess {
  const mapped = LEGACY_ROLE_TO_ROLE[role] ?? 'analyst';
  return {
    roles: new Set([mapped]),
    permissions: new Set(ROLE_PERMISSIONS[mapped]),
    scope: { global: true, sessionIds: new Set(), divisionIds: new Set(), chatIds: new Set() },
    fromAssignments: false,
  };
}

function accessFromAssignments(rows: RoleAssignment[]): EffectiveAccess {
  const roles = new Set<RoleName>();
  const permissions = new Set<Permission>();
  const sessionIds = new Set<string>();
  const divisionIds = new Set<string>();
  const chatIds = new Set<string>();
  let global = false;

  for (const row of rows) {
    const role = row.role as RoleName;
    // A row naming a role this release does not know is skipped rather than granted everything: an
    // unknown value must never be read as "the highest role".
    if (!ROLE_PERMISSIONS[role]) continue;
    roles.add(role);
    for (const permission of ROLE_PERMISSIONS[role]) permissions.add(permission);

    switch (row.scopeType) {
      case 'global':
        global = true;
        break;
      case 'session':
        if (row.scopeId) sessionIds.add(row.scopeId);
        break;
      case 'team':
        if (row.scopeId) divisionIds.add(row.scopeId);
        break;
      case 'object':
        if (row.scopeId) chatIds.add(row.scopeId);
        break;
      default:
        break;
    }
  }

  return {
    roles,
    permissions,
    scope: { global, sessionIds, divisionIds, chatIds },
    fromAssignments: true,
  };
}

function allows(access: EffectiveAccess, permission: Permission, resource?: ResourceRef): boolean {
  if (!isPermission(permission)) return false;
  if (!access.permissions.has(permission)) return false;
  if (access.scope.global) return true;
  // Without a resource the question is only "may this key perform this kind of action"; the list
  // it reads must still be filtered through scope() by the service (35.5.2).
  if (!resource) return true;

  if (resource.chatId && access.scope.chatIds.has(resource.chatId)) return true;
  if (resource.sessionId && access.scope.sessionIds.has(resource.sessionId)) return true;
  if (resource.divisionId && access.scope.divisionIds.has(resource.divisionId)) return true;
  return false;
}

/** `null` fence = unrestricted; otherwise only the ids both lists agree on survive. */
function intersectWithFence(ids: Set<string> | null, fence: string[] | null | undefined): Set<string> | null {
  const allow = (fence ?? []).filter(entry => entry.length > 0);
  if (allow.length === 0) return ids;
  const allowed = new Set(allow);
  if (ids === null) return allowed;
  return new Set([...ids].filter(id => allowed.has(id)));
}
