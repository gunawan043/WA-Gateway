import { DataSource } from 'typeorm';
import { CreateAuthAuditTables1779900000000 } from '../1779900000000-CreateAuthAuditTables';
import { AddApiKeyAuthzVersion1787010000000 } from '../1787010000000-AddApiKeyAuthzVersion';

/**
 * Locks the additive column the invalidation design needs (docs/35 §35.5.4): an existing key reads
 * `authzVersion = 0`, so the fingerprint of a pre-Fase-1 row is unchanged and no socket is evicted by
 * the upgrade itself.
 */
describe('AddApiKeyAuthzVersion migration', () => {
  let ds: DataSource;
  let qr: ReturnType<DataSource['createQueryRunner']>;

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [], synchronize: false });
    await ds.initialize();
    qr = ds.createQueryRunner();
    await new CreateAuthAuditTables1779900000000().up(qr);
    await qr.query(`INSERT INTO api_keys (id, name, keyHash, keyPrefix) VALUES ('k1', 'k', 'h', 'p')`);
  });

  afterEach(async () => {
    await qr.release();
    await ds.destroy();
  });

  it('adds the column with a 0 default for rows that already exist', async () => {
    await new AddApiKeyAuthzVersion1787010000000().up(qr);
    const rows = (await qr.query(`SELECT authzVersion FROM api_keys WHERE id = 'k1'`)) as Array<{
      authzVersion: number;
    }>;
    expect(rows[0].authzVersion).toBe(0);
  });

  it('is idempotent', async () => {
    const migration = new AddApiKeyAuthzVersion1787010000000();
    await migration.up(qr);
    await expect(migration.up(qr)).resolves.not.toThrow();
  });

  it('down() drops the column', async () => {
    const migration = new AddApiKeyAuthzVersion1787010000000();
    await migration.up(qr);
    await migration.down(qr);
    const columns = (await qr.query(`PRAGMA table_info("api_keys")`)) as Array<{ name: string }>;
    expect(columns.map(column => column.name)).not.toContain('authzVersion');
  });
});
