import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import type { Repository } from 'typeorm';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';
import type { RoleAssignment } from './entities/role-assignment.entity';
import { PermissionService } from './permission.service';
import { CreateAuthAuditTables1779900000000 } from '../../database/migrations-main/1779900000000-CreateAuthAuditTables';
import { AddUsersAndSessions1786700000000 } from '../../database/migrations-main/1786700000000-AddUsersAndSessions';
import { CreateRoleAssignments1787000000000 } from '../../database/migrations-main/1787000000000-CreateRoleAssignments';

/**
 * The regression lock for every `@RequireRole` point in the codebase (docs/35 §35.4.3, §35.8.2).
 *
 * The rows are not hand-written: the real `CreateRoleAssignments` migration runs on an in-memory
 * `main` database with one key per legacy role, and its output is fed to the real
 * `PermissionService`. For every decorator found in `src/`, a backfilled key must pass exactly the
 * points its legacy role passed, and a scoped assignment must never reach an ADMIN point.
 *
 * A new `@RequireRole` point is picked up automatically; a change to the backfill or to the bridge
 * that moves any decision fails here.
 */
const SRC = join(__dirname, '..', '..');
const LEVEL: Record<ApiKeyRole, number> = {
  [ApiKeyRole.VIEWER]: 1,
  [ApiKeyRole.OPERATOR]: 2,
  [ApiKeyRole.ADMIN]: 3,
};

function controllerFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) controllerFiles(full, out);
    else if (entry.name.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

interface RolePoint {
  file: string;
  line: number;
  role: ApiKeyRole;
}

function requireRolePoints(): RolePoint[] {
  const pattern = /@RequireRole\(\s*ApiKeyRole\.(ADMIN|OPERATOR|VIEWER)\s*\)/g;
  const points: RolePoint[] = [];
  for (const file of controllerFiles(SRC)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index).split('\n').length;
      const member = match[1] as 'ADMIN' | 'OPERATOR' | 'VIEWER';
      points.push({ file: file.slice(SRC.length + 1), line, role: ApiKeyRole[member] });
    }
  }
  return points;
}

describe('@RequireRole bridge: every point keeps its pre-Fase-1 decision', () => {
  let ds: DataSource;
  let rows: Array<RoleAssignment & { apiKeyId: string }>;
  let service: PermissionService;
  const keys: Record<ApiKeyRole, ApiKey> = {} as Record<ApiKeyRole, ApiKey>;

  const makeKey = (id: string, role: ApiKeyRole): ApiKey => ({
    id,
    name: id,
    keyHash: `h-${id}`,
    keyPrefix: `p-${id}`,
    role,
    allowedIps: null,
    allowedSessions: null,
    allowedChats: null,
    isActive: true,
    expiresAt: null,
    lastUsedAt: null,
    usageCount: 0,
    authzVersion: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  beforeAll(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [], synchronize: false });
    await ds.initialize();
    const qr = ds.createQueryRunner();
    await new CreateAuthAuditTables1779900000000().up(qr);
    await new AddUsersAndSessions1786700000000().up(qr);
    for (const role of [ApiKeyRole.ADMIN, ApiKeyRole.OPERATOR, ApiKeyRole.VIEWER]) {
      await qr.query(
        `INSERT INTO api_keys (id, name, keyHash, keyPrefix, role) VALUES ('k-${role}', 'k', 'h-${role}', 'p', '${role}')`,
      );
    }
    await new CreateRoleAssignments1787000000000().up(qr);
    rows = (await qr.query(
      `SELECT id, apiKeyId, userId, role, scopeType, scopeId, source, externalId, validFrom, validTo, grantedByKeyId, createdAt, updatedAt FROM role_assignments`,
    )) as Array<RoleAssignment & { apiKeyId: string }>;
    await qr.release();

    const repo = {
      find: ({ where }: { where: { apiKeyId: string } }) =>
        Promise.resolve(rows.filter(row => row.apiKeyId === where.apiKeyId)),
    } as unknown as Repository<RoleAssignment>;
    service = new PermissionService(repo);
    for (const role of [ApiKeyRole.ADMIN, ApiKeyRole.OPERATOR, ApiKeyRole.VIEWER]) {
      keys[role] = makeKey(`k-${role}`, role);
    }
  });

  afterAll(async () => {
    await ds.destroy();
  });

  const points = requireRolePoints();

  it('finds the @RequireRole points in the codebase (a scan that found none would pass for the wrong reason)', () => {
    expect(points.length).toBeGreaterThanOrEqual(186);
    expect(new Set(points.map(point => point.role))).toEqual(
      new Set([ApiKeyRole.ADMIN, ApiKeyRole.OPERATOR, ApiKeyRole.VIEWER]),
    );
  });

  it.each([ApiKeyRole.ADMIN, ApiKeyRole.OPERATOR, ApiKeyRole.VIEWER])(
    'a backfilled %s key passes exactly the points its legacy role passed',
    async legacyRole => {
      const level = await service.bridgeLevel(keys[legacyRole]);
      const mismatches = points.filter(
        point => LEVEL[level] >= LEVEL[point.role] !== LEVEL[legacyRole] >= LEVEL[point.role],
      );
      expect(mismatches.map(point => `${point.file}:${point.line} ${point.role}`)).toEqual([]);
    },
  );

  it('a scoped system_admin reaches no ADMIN point through the bridge', async () => {
    const scoped = { ...keys[ApiKeyRole.ADMIN] };
    rows.push({
      id: 'scoped-admin',
      apiKeyId: scoped.id,
      userId: null,
      role: 'system_admin',
      scopeType: 'team',
      scopeId: 'd1',
      source: 'local',
      externalId: null,
      validFrom: null,
      validTo: null,
      grantedByKeyId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // The key already has the backfilled global grants; drop them for this case so only the scoped
    // grant remains, which is what a newly provisioned team administrator looks like.
    const saved = rows;
    rows = saved.filter(row => row.apiKeyId !== scoped.id || row.id === 'scoped-admin');
    service.clearCache();

    const level = await service.bridgeLevel(scoped);
    expect(level).toBe(ApiKeyRole.OPERATOR);
    const adminPoints = points.filter(point => point.role === ApiKeyRole.ADMIN);
    expect(adminPoints.length).toBeGreaterThan(0);
    expect(adminPoints.filter(point => LEVEL[level] >= LEVEL[point.role])).toEqual([]);

    rows = saved;
    service.clearCache();
  });
});
