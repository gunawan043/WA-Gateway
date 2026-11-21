import { DataSource } from 'typeorm';
import { AddUsersAndSessions1786700000000 } from '../../migrations-main/1786700000000-AddUsersAndSessions';

describe('AddUsersAndSessions migration', () => {
  let ds: DataSource;
  const migration = new AddUsersAndSessions1786700000000();

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
    await ds.initialize();
  });

  afterEach(async () => {
    if (ds.isInitialized) await ds.destroy();
  });

  it('creates both tables with every column the entities declare', async () => {
    await migration.up(ds.createQueryRunner());

    const userCols: { name: string }[] = await ds.query(`PRAGMA table_info("users")`);
    expect(userCols.map(c => c.name).sort()).toEqual(
      [
        'id',
        'email',
        'name',
        'passwordHash',
        'role',
        'isActive',
        'apiKeyId',
        'lastLoginAt',
        'createdAt',
        'updatedAt',
      ].sort(),
    );

    const sessionCols: { name: string }[] = await ds.query(`PRAGMA table_info("user_sessions")`);
    expect(sessionCols.map(c => c.name).sort()).toEqual(
      [
        'id',
        'userId',
        'tokenHash',
        'expiresAt',
        'revokedAt',
        'lastSeenAt',
        'userAgent',
        'ipAddress',
        'createdAt',
      ].sort(),
    );
  });

  it('creates the named indexes the boot check and the drift gate compare', async () => {
    await migration.up(ds.createQueryRunner());

    const userIndexes: { name: string; unique: number }[] = await ds.query(`PRAGMA index_list("users")`);
    const userByName = new Map(userIndexes.map(index => [index.name, index.unique]));
    expect(userByName.get('UQ_users_email')).toBe(1);
    expect(userByName.get('UQ_users_apiKeyId')).toBe(1);

    const sessionIndexes: { name: string; unique: number }[] = await ds.query(`PRAGMA index_list("user_sessions")`);
    const sessionByName = new Map(sessionIndexes.map(index => [index.name, index.unique]));
    expect(sessionByName.get('UQ_user_sessions_tokenHash')).toBe(1);
    expect(sessionByName.get('IDX_user_sessions_userId')).toBe(0);
  });

  it('enforces one account per email and one account per key', async () => {
    await migration.up(ds.createQueryRunner());
    const insertUser = (id: string, email: string, apiKeyId: string): Promise<unknown> =>
      ds.query(
        `INSERT INTO "users" ("id","email","name","passwordHash","role","isActive","apiKeyId") ` +
          `VALUES ('${id}','${email}','n','h','operator',1,'${apiKeyId}')`,
      );

    await insertUser('u1', 'a@example.com', 'k1');
    // The unique email is the identity check; the unique key stops two accounts sharing one credential.
    await expect(insertUser('u2', 'a@example.com', 'k2')).rejects.toThrow();
    await expect(insertUser('u3', 'b@example.com', 'k1')).rejects.toThrow();
    await expect(insertUser('u4', 'b@example.com', 'k2')).resolves.toBeDefined();
  });

  it('enforces one row per token hash, so a replayed token cannot be duplicated', async () => {
    await migration.up(ds.createQueryRunner());
    const insertSession = (id: string, tokenHash: string): Promise<unknown> =>
      ds.query(
        `INSERT INTO "user_sessions" ("id","userId","tokenHash","expiresAt") ` +
          `VALUES ('${id}','u1','${tokenHash}','2099-01-01T00:00:00.000Z')`,
      );

    await insertSession('s1', 'a'.repeat(64));
    await expect(insertSession('s2', 'a'.repeat(64))).rejects.toThrow();
    await expect(insertSession('s3', 'b'.repeat(64))).resolves.toBeDefined();
  });

  it('is a no-op when the tables already exist, and reverts idempotently', async () => {
    await migration.up(ds.createQueryRunner());
    await expect(migration.up(ds.createQueryRunner())).resolves.toBeUndefined();

    await migration.down(ds.createQueryRunner());
    const tables: unknown[] = await ds.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('users','user_sessions')`,
    );
    expect(tables).toHaveLength(0);
    await expect(migration.down(ds.createQueryRunner())).resolves.toBeUndefined();
  });
});
