import { ApiKeyRole } from './entities/api-key.entity';

/**
 * The permission catalogue of Fase 1 (docs/35-rbac-and-teams-design.md, section 35.3).
 *
 * A permission is a `resource.action` string a route may demand with `@RequirePermission`. It is a
 * vocabulary, not a role: the same permission is granted to several roles, and a grant is still
 * bounded by the assignment's scope. Nothing here is enforced until a handler carries the
 * decorator, so the catalogue can land (and be tested) before the routes are converted.
 */
export const PERMISSIONS = [
  // 35.3.1 Identity and configuration
  'user.read',
  'user.manage',
  'apikey.read',
  'apikey.manage',
  'role.read',
  'role.assign',
  'settings.write',
  'infra.read',
  'infra.write',
  'plugin.manage',
  'audit.read',
  // 35.3.2 Integrations and webhooks
  'integration.read',
  'integration.write',
  'webhook.read',
  'webhook.write',
  // 35.3.3 Sessions and channels
  'session.read',
  'session.write',
  'session.control',
  'session.delete',
  'session.proxy.write',
  // 35.3.4 Messages, contacts, chats
  'message.read',
  'message.send',
  'message.delete',
  'message.bulk',
  'chat.read',
  'chat.write',
  'contact.read',
  'contact.write',
  'group.read',
  'group.write',
  'label.read',
  'label.write',
  'profile.read',
  'profile.write',
  'status.read',
  'status.write',
  // 35.3.5 Inbox and teams
  'inbox.read',
  'inbox.assign',
  'inbox.status',
  'inbox.note',
  'inbox.note.delete',
  'inbox.report.read',
  'team.read',
  'team.manage',
  'team.member.manage',
  'team.availability.manage',
  // 35.3.6 CRM, campaigns, templates, automation
  'crm.read',
  'crm.write',
  'crm.delete',
  'crm.stage.write',
  'campaign.read',
  'campaign.write',
  'campaign.run',
  'campaign.delete',
  'template.read',
  'template.write',
  'automation.read',
  'automation.write',
  // 35.3.7 Analytics
  'stats.read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Permissions reserved for a later phase (35.3.8). They exist in the vocabulary so a route added in
 * that phase cannot invent a second spelling, but no role holds them and no Fase 1 route demands
 * them, so the coverage gate must not count them as unwired.
 */
export const RESERVED_PERMISSIONS = ['ticket.read', 'ticket.write', 'quality.evaluate', 'report.export'] as const;

export type ReservedPermission = (typeof RESERVED_PERMISSIONS)[number];

export const ALL_PERMISSIONS: ReadonlySet<string> = new Set<string>([...PERMISSIONS, ...RESERVED_PERMISSIONS]);

export const isPermission = (value: string): value is Permission => (PERMISSIONS as readonly string[]).includes(value);

/** The eight roles of Fase 1. They live only in `role_assignments.role`; `api_keys.role` stays three. */
export const ROLE_NAMES = [
  'system_admin',
  'connect_admin',
  'supervisor',
  'team_leader',
  'agent',
  'quality_evaluator',
  'campaign_manager',
  'analyst',
] as const;

export type RoleName = (typeof ROLE_NAMES)[number];

export const isRoleName = (value: string): value is RoleName => (ROLE_NAMES as readonly string[]).includes(value);

/** The scopes Fase 1 understands. `unit` is deferred to Fase 4 (35.9.2 decision 1). */
export const SCOPE_TYPES = ['global', 'session', 'team', 'object'] as const;

export type ScopeType = (typeof SCOPE_TYPES)[number];

export const isScopeType = (value: string): value is ScopeType => (SCOPE_TYPES as readonly string[]).includes(value);

/**
 * The role a key without any assignment is treated as. This is the compatibility bridge: the
 * backfill writes the same mapping into `role_assignments`, so a backfilled key and a machine key
 * on the legacy path evaluate identically (docs/35 §35.4).
 */
export const LEGACY_ROLE_TO_ROLE: Record<ApiKeyRole, RoleName> = {
  [ApiKeyRole.ADMIN]: 'system_admin',
  [ApiKeyRole.OPERATOR]: 'agent',
  [ApiKeyRole.VIEWER]: 'analyst',
};

/**
 * The `@RequireRole` bridge level of a role. A scoped assignment is capped at OPERATOR no matter
 * which role it names, so a team-scoped `system_admin` cannot reach an ADMIN route through the
 * compatibility bridge while that route still uses `@RequireRole` (35.4.3).
 */
export const ROLE_BRIDGE_LEVEL: Record<RoleName, ApiKeyRole> = {
  system_admin: ApiKeyRole.ADMIN,
  connect_admin: ApiKeyRole.ADMIN,
  supervisor: ApiKeyRole.OPERATOR,
  team_leader: ApiKeyRole.OPERATOR,
  agent: ApiKeyRole.OPERATOR,
  quality_evaluator: ApiKeyRole.VIEWER,
  campaign_manager: ApiKeyRole.OPERATOR,
  analyst: ApiKeyRole.VIEWER,
};

/** The role hierarchy the bridge compares, unchanged from `AuthService.hasPermission`. */
export const BRIDGE_LEVELS: Record<ApiKeyRole, number> = {
  [ApiKeyRole.VIEWER]: 1,
  [ApiKeyRole.OPERATOR]: 2,
  [ApiKeyRole.ADMIN]: 3,
};

/** Roles whose assignment grants the ADMIN bridge level — only when the scope is global. */
export const GLOBAL_ADMIN_ROLES: ReadonlySet<RoleName> = new Set<RoleName>(['system_admin', 'connect_admin']);

/**
 * The permission matrix of 35.3, transcribed role by role. `S` in the document means "granted, but
 * only inside the assignment's scope"; the permission set is therefore identical to `✓` and the
 * scope is applied at evaluation time.
 */
const ROLE_PERMISSION_LIST: Record<RoleName, readonly Permission[]> = {
  system_admin: PERMISSIONS,
  connect_admin: [
    'user.read',
    'user.manage',
    'apikey.read',
    'apikey.manage',
    'role.read',
    'role.assign',
    'settings.write',
    'infra.read',
    'audit.read',
    'integration.read',
    'integration.write',
    'webhook.read',
    'webhook.write',
    'session.read',
    'session.write',
    'session.control',
    'message.read',
    'message.send',
    'message.delete',
    'message.bulk',
    'chat.read',
    'chat.write',
    'contact.read',
    'contact.write',
    'group.read',
    'group.write',
    'label.read',
    'label.write',
    'profile.read',
    'profile.write',
    'status.read',
    'status.write',
    'inbox.read',
    'inbox.assign',
    'inbox.status',
    'inbox.note',
    'inbox.note.delete',
    'inbox.report.read',
    'team.read',
    'team.manage',
    'team.member.manage',
    'team.availability.manage',
    'crm.read',
    'crm.write',
    'crm.delete',
    'crm.stage.write',
    'campaign.read',
    'campaign.write',
    'campaign.run',
    'campaign.delete',
    'template.read',
    'template.write',
    'automation.read',
    'automation.write',
    'stats.read',
  ],
  supervisor: [
    'user.read',
    'role.read',
    'audit.read',
    'webhook.read',
    'session.read',
    'message.read',
    'message.send',
    'message.delete',
    'chat.read',
    'chat.write',
    'contact.read',
    'contact.write',
    'group.read',
    'label.read',
    'label.write',
    'profile.read',
    'status.read',
    'inbox.read',
    'inbox.assign',
    'inbox.status',
    'inbox.note',
    'inbox.note.delete',
    'inbox.report.read',
    'team.read',
    'team.member.manage',
    'team.availability.manage',
    'crm.read',
    'crm.write',
    'campaign.read',
    'template.read',
    'automation.read',
    'stats.read',
  ],
  team_leader: [
    'session.read',
    'message.read',
    'message.send',
    'chat.read',
    'chat.write',
    'contact.read',
    'contact.write',
    'group.read',
    'label.read',
    'label.write',
    'profile.read',
    'status.read',
    'inbox.read',
    'inbox.assign',
    'inbox.status',
    'inbox.note',
    'inbox.note.delete',
    'inbox.report.read',
    'team.read',
    'team.member.manage',
    'team.availability.manage',
    'crm.read',
    'crm.write',
    'campaign.read',
    'template.read',
    'automation.read',
    'stats.read',
  ],
  agent: [
    'session.read',
    'message.read',
    'message.send',
    'chat.read',
    'chat.write',
    'contact.read',
    'contact.write',
    'group.read',
    'label.read',
    'label.write',
    'profile.read',
    'status.read',
    'inbox.read',
    'inbox.assign',
    'inbox.status',
    'inbox.note',
    'team.read',
    'crm.read',
    'crm.write',
  ],
  quality_evaluator: [
    'session.read',
    'message.read',
    'chat.read',
    'contact.read',
    'label.read',
    'inbox.read',
    'inbox.note',
    'inbox.report.read',
    'team.read',
    'stats.read',
  ],
  campaign_manager: [
    'session.read',
    'message.read',
    'chat.read',
    'contact.read',
    'label.read',
    'status.read',
    'inbox.read',
    'team.read',
    'crm.read',
    'campaign.read',
    'campaign.write',
    'campaign.run',
    'template.read',
    'template.write',
    'stats.read',
  ],
  analyst: [
    'audit.read',
    'session.read',
    'message.read',
    'chat.read',
    'contact.read',
    'group.read',
    'label.read',
    'profile.read',
    'status.read',
    'inbox.read',
    'inbox.report.read',
    'team.read',
    'crm.read',
    'campaign.read',
    'template.read',
    'stats.read',
  ],
};

export const ROLE_PERMISSIONS: Record<RoleName, ReadonlySet<Permission>> = Object.fromEntries(
  ROLE_NAMES.map(role => [role, new Set(ROLE_PERMISSION_LIST[role])]),
) as unknown as Record<RoleName, ReadonlySet<Permission>>;

/** The union of several roles' permissions, sorted. Used to describe an account's authority. */
export function permissionsOfRoles(roles: Iterable<RoleName>): Permission[] {
  const out = new Set<Permission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role] ?? []) out.add(permission);
  }
  return [...out].sort();
}
