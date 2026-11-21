import { BRIDGE_LEVELS, GLOBAL_ADMIN_ROLES, ROLE_BRIDGE_LEVEL, isRoleName } from './permissions';
import { ApiKeyRole } from './entities/api-key.entity';

/**
 * The comparison `npm run rbac:verify` performs before the behaviour-changing stage is enabled
 * (docs/35 §35.7.2). Pure and read-only: the script feeds it rows, the migration test feeds it a
 * fixture, and both get the same verdict.
 *
 * It answers one question: for every key that already existed before Fase 1, does the assignment the
 * backfill wrote authorize exactly what `api_keys.role` authorized before? A key with NO assignment
 * is on the legacy path by definition and cannot mismatch; a key whose grants changed after the
 * backfill (a later manual grant) legitimately can, and the report names it.
 */
export interface VerifyKeyRow {
  id: string;
  name: string;
  role: string;
  isActive: boolean | number;
}

export interface VerifyAssignmentRow {
  apiKeyId: string;
  role: string;
  scopeType: string;
  scopeId: string;
  validFrom?: Date | string | null;
  validTo?: Date | string | null;
}

export interface LevelMismatch {
  keyId: string;
  keyName: string;
  legacyRole: string;
  legacyLevel: ApiKeyRole;
  assignmentLevel: ApiKeyRole;
  roles: string[];
  global: boolean;
}

export interface VerifyReport {
  ok: boolean;
  mismatches: LevelMismatch[];
  keys: {
    total: number;
    withAssignments: number;
    legacyPath: number;
    byRole: Record<string, number>;
  };
  assignments: {
    total: number;
    byScope: Record<string, number>;
  };
}

const LEVEL_NAME: Record<number, ApiKeyRole> = {
  [BRIDGE_LEVELS[ApiKeyRole.VIEWER]]: ApiKeyRole.VIEWER,
  [BRIDGE_LEVELS[ApiKeyRole.OPERATOR]]: ApiKeyRole.OPERATOR,
  [BRIDGE_LEVELS[ApiKeyRole.ADMIN]]: ApiKeyRole.ADMIN,
};

function active(row: VerifyAssignmentRow, now: Date): boolean {
  const at = now.getTime();
  if (row.validFrom) {
    const from = new Date(row.validFrom).getTime();
    if (Number.isFinite(from) && from > at) return false;
  }
  if (row.validTo) {
    const to = new Date(row.validTo).getTime();
    if (!Number.isFinite(to) || to <= at) return false;
  }
  return true;
}

/** The same arithmetic `PermissionService.bridgeLevel` applies to a key with assignments. */
function assignmentLevel(rows: readonly VerifyAssignmentRow[]): {
  level: ApiKeyRole;
  roles: string[];
  global: boolean;
} {
  const roles = new Set<string>();
  let global = false;
  let level = 0;
  for (const row of rows) {
    if (!isRoleName(row.role)) continue;
    roles.add(row.role);
    level = Math.max(level, BRIDGE_LEVELS[ROLE_BRIDGE_LEVEL[row.role]]);
    if (row.scopeType === 'global') global = true;
  }
  const globalAdmin = global && [...roles].some(role => GLOBAL_ADMIN_ROLES.has(role as never));
  if (!globalAdmin) level = Math.min(level, BRIDGE_LEVELS[ApiKeyRole.OPERATOR]);
  return { level: LEVEL_NAME[level] ?? ApiKeyRole.VIEWER, roles: [...roles].sort(), global };
}

export function verifyBackfill(
  keys: readonly VerifyKeyRow[],
  assignments: readonly VerifyAssignmentRow[],
  now = new Date(),
): VerifyReport {
  const byKey = new Map<string, VerifyAssignmentRow[]>();
  const byScope: Record<string, number> = {};

  for (const row of assignments) {
    byScope[row.scopeType] = (byScope[row.scopeType] ?? 0) + 1;
    if (!active(row, now)) continue;
    const list = byKey.get(row.apiKeyId);
    if (list) list.push(row);
    else byKey.set(row.apiKeyId, [row]);
  }

  const byRole: Record<string, number> = {};
  const mismatches: LevelMismatch[] = [];
  let withAssignments = 0;
  let legacyPath = 0;

  for (const key of keys) {
    byRole[key.role] = (byRole[key.role] ?? 0) + 1;
    const rows = byKey.get(key.id) ?? [];
    if (rows.length === 0) {
      legacyPath += 1;
      continue;
    }
    withAssignments += 1;
    const legacyLevel = LEVEL_NAME[BRIDGE_LEVELS[key.role as ApiKeyRole]] ?? null;
    const computed = assignmentLevel(rows);
    // An unknown legacy role authorized nothing, so any grant is a widening — reported, not ignored.
    if (legacyLevel === null || legacyLevel !== computed.level) {
      mismatches.push({
        keyId: key.id,
        keyName: key.name,
        legacyRole: key.role,
        legacyLevel: legacyLevel ?? ApiKeyRole.VIEWER,
        assignmentLevel: computed.level,
        roles: computed.roles,
        global: computed.global,
      });
    }
  }

  return {
    ok: mismatches.length === 0,
    mismatches,
    keys: { total: keys.length, withAssignments, legacyPath, byRole },
    assignments: { total: assignments.length, byScope },
  };
}

/** Human-readable report, shared by the script and its test. */
export function formatVerifyReport(report: VerifyReport): string {
  const lines: string[] = [];
  lines.push(
    `keys: ${report.keys.total} (${report.keys.withAssignments} with assignments, ${report.keys.legacyPath} on the legacy path)`,
  );
  lines.push(
    `assignments: ${report.assignments.total} (${
      Object.entries(report.assignments.byScope)
        .map(([scope, n]) => `${scope} ${n}`)
        .join(', ') || 'none'
    })`,
  );
  lines.push(
    `keys by legacy role: ${
      Object.entries(report.keys.byRole)
        .map(([role, n]) => `${role} ${n}`)
        .join(', ') || 'none'
    }`,
  );
  if (report.ok) {
    lines.push('OK: every key with assignments authorizes exactly as its legacy role did.');
    return lines.join('\n');
  }
  lines.push(`MISMATCH: ${report.mismatches.length} key(s) authorize differently from their legacy role:`);
  for (const m of report.mismatches) {
    lines.push(
      `  ${m.keyId} (${m.keyName}): legacy ${m.legacyRole} -> ${m.legacyLevel}, assignments [${m.roles.join(', ')}]` +
        `${m.global ? ' global' : ' scoped'} -> ${m.assignmentLevel}`,
    );
  }
  return lines.join('\n');
}
