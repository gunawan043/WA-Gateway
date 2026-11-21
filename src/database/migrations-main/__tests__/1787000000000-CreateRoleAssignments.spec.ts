import { DataSource } from 'typeorm';
import { CreateAuthAuditTables1779900000000 } from '../1779900000000-CreateAuthAuditTables';
import { AddUsersAndSessions1786700000000 } from '../1786700000000-AddUsersAndSessions';
import { CreateRoleAssignments1787000000000 } from '../1787000000000-CreateRoleAssignments';

/**
 * Locks the two properties the Fase 1a plan depends on (docs/35 §35.7.1): the backfill grants every
 * existing key the authority it already had, and running it twice does not duplicate a grant.
 */
describe('CreateRoleAssignments migration', () => {
  let ds: DataSource;
  let qr: ReturnType<DataSource['createQueryRunner']>;

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [], synchronize: false });
    await ds.initialize();
    qr = ds.createQueryRunner();
    await new CreateAuthAuditTables1779900000000().up(qr);
    await new AddUsersAndSessions1786700000000().up(qr);
    await qr.query(
      `INSERT INTO api_keys (id, name, keyHash, keyPrefix, role) VALUES
       ('k-admin', 'Admin', 'h1', 'p1', 'admin'),
       ('k-op', 'Operator', 'h2', 'p2', 'operator'),
       ('k-view', 'Viewer', 'h3', 'p3', 'viewer')`,
    );
    await qr.query(
      `INSERT INTO users (id, email, name, passwordHash, role, apiKeyId)
       VALUES ('u-admin', 'admin@example.com', 'Admin', 'scrypt$x', 'admin', 'k-admin')`,
    );
  });

  afterEach(async () => {
    await qr.release();
    await ds.destroy();
  });

  const rows = async (): Promise<
    Array<{ apiKeyId: string; userId: string | null; role: string; scopeType: string; scopeId: string }>
  > =>
    (await qr.query(
      `SELECT apiKeyId, userId, role, scopeType, scopeId FROM role_assignments ORDER BY apiKeyId, role`,
    )) as Array<{ apiKeyId: string; userId: string | null; role: string; scopeType: string; scopeId: string }>;

  it('backfills one global grant per legacy role, with admin receiving both administrative roles', async () => {
    await new CreateRoleAssignments1787000000000().up(qr);

    const written = await rows();
    expect(written).toEqual([
      { apiKeyId: 'k-admin', userId: 'u-admin', role: 'connect_admin', scopeType: 'global', scopeId: '' },
      { apiKeyId: 'k-admin', userId: 'u-admin', role: 'system_admin', scopeType: 'global', scopeId: '' },
      { apiKeyId: 'k-op', userId: null, role: 'agent', scopeType: 'global', scopeId: '' },
      { apiKeyId: 'k-view', userId: null, role: 'analyst', scopeType: 'global', scopeId: '' },
    ]);
  });

  it('is idempotent: a second run adds nothing and touches no existing row', async () => {
    const migration = new CreateRoleAssignments1787000000000();
    await migration.up(qr);
    const before = await rows();

    await expect(migration.up(qr)).resolves.not.toThrow();
    expect(await rows()).toEqual(before);
  });

  it('refuses a duplicate grant through the unique index (scopeId is never NULL)', async () => {
    await new CreateRoleAssignments1787000000000().up(qr);
    await expect(
      qr.query(
        `INSERT INTO role_assignments (id, apiKeyId, role, scopeType, scopeId) VALUES ('x', 'k-op', 'agent', 'global', '')`,
      ),
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it('down() drops the table', async () => {
    const migration = new CreateRoleAssignments1787000000000();
    await migration.up(qr);
    await migration.down(qr);
    const tables = (await qr.query(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'role_assignments'`,
    )) as unknown[];
    expect(tables).toHaveLength(0);
  });
});
