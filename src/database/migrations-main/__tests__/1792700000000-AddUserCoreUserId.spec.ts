import { DataSource } from 'typeorm';
import { CreateAuthAuditTables1779900000000 } from '../1779900000000-CreateAuthAuditTables';
import { AddUsersAndSessions1786700000000 } from '../1786700000000-AddUsersAndSessions';
import { AddUserCoreUserId1792700000000 } from '../1792700000000-AddUserCoreUserId';

/**
 * Locks the additive column the SSO handoff maps on: an existing account reads NULL (unmapped), two
 * accounts can both be unmapped, and a second account cannot claim an external id already in use.
 */
describe('AddUserCoreUserId migration', () => {
  let ds: DataSource;
  let qr: ReturnType<DataSource['createQueryRunner']>;

  const insertUser = (id: string, coreUserId: string | null): Promise<unknown> =>
    qr.query(
      `INSERT INTO users (id, email, name, passwordHash, role, isActive, apiKeyId, coreUserId)
       VALUES (?, ?, ?, 'hash', 'operator', 1, ?, ?)`,
      [id, `${id}@example.com`, id, `key-${id}`, coreUserId],
    );

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [], synchronize: false });
    await ds.initialize();
    qr = ds.createQueryRunner();
    await new CreateAuthAuditTables1779900000000().up(qr);
    await new AddUsersAndSessions1786700000000().up(qr);
  });

  afterEach(async () => {
    await qr.release();
    await ds.destroy();
  });

  it('adds a nullable column, so existing accounts are simply unmapped', async () => {
    await qr.query(
      `INSERT INTO users (id, email, name, passwordHash, role, isActive, apiKeyId)
       VALUES ('u1', 'u1@example.com', 'u1', 'hash', 'operator', 1, 'k1')`,
    );

    await new AddUserCoreUserId1792700000000().up(qr);

    const rows = (await qr.query(`SELECT coreUserId FROM users WHERE id = 'u1'`)) as Array<{
      coreUserId: string | null;
    }>;
    expect(rows[0].coreUserId).toBeNull();
  });

  it('is idempotent', async () => {
    const migration = new AddUserCoreUserId1792700000000();
    await migration.up(qr);
    await expect(migration.up(qr)).resolves.not.toThrow();
  });

  it('allows many unmapped accounts but refuses two accounts on one Core identity', async () => {
    await new AddUserCoreUserId1792700000000().up(qr);

    await insertUser('u1', null);
    await insertUser('u2', null);
    await insertUser('u3', 'core-1');

    await expect(insertUser('u4', 'core-1')).rejects.toThrow();
  });

  it('down() drops the index and the column', async () => {
    const migration = new AddUserCoreUserId1792700000000();
    await migration.up(qr);
    await migration.down(qr);

    const columns = (await qr.query(`PRAGMA table_info("users")`)) as Array<{ name: string }>;
    expect(columns.map(column => column.name)).not.toContain('coreUserId');
    const indexes = (await qr.query(`PRAGMA index_list("users")`)) as Array<{ name: string }>;
    expect(indexes.map(index => index.name)).not.toContain('UQ_users_coreUserId');
  });
});
