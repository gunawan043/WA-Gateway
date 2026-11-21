import { DataSource } from 'typeorm';
import { formatVerifyReport, verifyBackfill, type VerifyAssignmentRow, type VerifyKeyRow } from './rbac-verify';
import { CreateAuthAuditTables1779900000000 } from '../../database/migrations-main/1779900000000-CreateAuthAuditTables';
import { AddUsersAndSessions1786700000000 } from '../../database/migrations-main/1786700000000-AddUsersAndSessions';
import { CreateRoleAssignments1787000000000 } from '../../database/migrations-main/1787000000000-CreateRoleAssignments';

/**
 * The gate that must pass before the behaviour-changing stage is enabled (docs/35 §35.7.2). The
 * first case runs the REAL migration, so a change to its SQL is caught here as well as in the
 * migration test.
 */
describe('rbac:verify', () => {
  const keys: VerifyKeyRow[] = [
    { id: 'k-admin', name: 'Admin', role: 'admin', isActive: true },
    { id: 'k-op', name: 'Operator', role: 'operator', isActive: true },
    { id: 'k-view', name: 'Viewer', role: 'viewer', isActive: true },
    { id: 'k-machine', name: 'Machine', role: 'operator', isActive: true },
  ];

  it('passes on the output of the real backfill migration', async () => {
    const ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [], synchronize: false });
    await ds.initialize();
    const qr = ds.createQueryRunner();
    await new CreateAuthAuditTables1779900000000().up(qr);
    await new AddUsersAndSessions1786700000000().up(qr);
    for (const key of keys.filter(key => key.id !== 'k-machine')) {
      await qr.query(
        `INSERT INTO api_keys (id, name, keyHash, keyPrefix, role) VALUES ('${key.id}', '${key.name}', 'h-${key.id}', 'p', '${key.role}')`,
      );
    }
    await new CreateRoleAssignments1787000000000().up(qr);
    // A machine key minted after the migration is on the legacy path, which is the case the report
    // separates from a backfilled key.
    await qr.query(
      `INSERT INTO api_keys (id, name, keyHash, keyPrefix, role) VALUES ('k-machine', 'Machine', 'h-m', 'p', 'operator')`,
    );
    const assignments = (await qr.query(
      `SELECT apiKeyId, role, scopeType, scopeId, validFrom, validTo FROM role_assignments`,
    )) as VerifyAssignmentRow[];
    await qr.release();
    await ds.destroy();

    const report = verifyBackfill(keys, assignments);
    expect(report.mismatches).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.keys.withAssignments).toBe(3);
    expect(report.keys.legacyPath).toBe(1);
  });

  it('flags a key whose scoped grant no longer matches its legacy role', () => {
    const report = verifyBackfill(keys, [
      { apiKeyId: 'k-admin', role: 'system_admin', scopeType: 'team', scopeId: 'd1' },
    ]);
    expect(report.ok).toBe(false);
    expect(report.mismatches).toEqual([
      expect.objectContaining({
        keyId: 'k-admin',
        legacyRole: 'admin',
        legacyLevel: 'admin',
        assignmentLevel: 'operator',
      }),
    ]);
    expect(formatVerifyReport(report)).toContain('MISMATCH');
  });

  it('ignores an assignment outside its validity window', () => {
    const report = verifyBackfill(
      keys,
      [{ apiKeyId: 'k-op', role: 'agent', scopeType: 'global', scopeId: '', validTo: '2020-01-01T00:00:00Z' }],
      new Date('2026-01-01T00:00:00Z'),
    );
    expect(report.ok).toBe(true);
    expect(report.keys.legacyPath).toBe(4);
  });

  it('flags an unknown legacy role, which authorized nothing before', () => {
    const report = verifyBackfill(
      [{ id: 'k-x', name: 'X', role: 'superuser', isActive: true }],
      [{ apiKeyId: 'k-x', role: 'agent', scopeType: 'global', scopeId: '' }],
    );
    expect(report.ok).toBe(false);
    expect(report.mismatches[0]).toMatchObject({ keyId: 'k-x', legacyRole: 'superuser' });
  });

  it('summarises scope counts for the operator', () => {
    const report = verifyBackfill(keys, [
      { apiKeyId: 'k-admin', role: 'system_admin', scopeType: 'global', scopeId: '' },
      { apiKeyId: 'k-admin', role: 'connect_admin', scopeType: 'global', scopeId: '' },
      { apiKeyId: 'k-op', role: 'agent', scopeType: 'team', scopeId: 'd1' },
    ]);
    expect(report.assignments.byScope).toEqual({ global: 2, team: 1 });
    expect(formatVerifyReport(report)).toContain('global 2, team 1');
  });
});
