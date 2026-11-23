import 'reflect-metadata';
import { DataSource, QueryRunner } from 'typeorm';
import { CreateApprovalWorkflow1792400000000 } from '../../database/migrations/1792400000000-CreateApprovalWorkflow';
import { AddApprovalCommandRetry1792500000000 } from '../../database/migrations/1792500000000-AddApprovalCommandRetry';
import { AddApprovalLookupIndexes1792600000000 } from '../../database/migrations/1792600000000-AddApprovalLookupIndexes';

/**
 * The reply path reads `approval_requests` by notification id and by sender + recency on every
 * WhatsApp reply. Both used to scan the table; the lookup migration adds the indexes, and this spec
 * pins the plan so a later migration cannot quietly drop them. It also pins that both migrations can
 * run `up()` twice, which is what makes a partial restore recoverable.
 *
 * `EXPLAIN QUERY PLAN` is asserted instead of wall-clock time: a plan is deterministic on a loaded
 * machine, and `SCAN` versus `SEARCH ... USING INDEX` is the property that matters.
 */
describe('approval lookup indexes', () => {
  let dataSource: DataSource;

  const QUOTED_REPLY = `SELECT * FROM approval_requests WHERE notificationMessageId = ? AND targetIdentity = ? LIMIT 1`;
  const SINGLE_OPEN = `SELECT * FROM approval_requests WHERE targetIdentity = ? AND status IN ('PENDING_APPROVAL','NEEDS_CLARIFICATION') ORDER BY createdAt DESC LIMIT 5`;

  const planOf = async (sql: string, parameters: unknown[]): Promise<string> =>
    (await dataSource.query<Array<{ detail: string }>>(`EXPLAIN QUERY PLAN ${sql}`, parameters))
      .map(row => row.detail)
      .join(' | ');

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      migrations: [
        CreateApprovalWorkflow1792400000000,
        AddApprovalCommandRetry1792500000000,
        AddApprovalLookupIndexes1792600000000,
      ],
      synchronize: false,
    });

    await dataSource.initialize();
    await dataSource.runMigrations();

    const insert = `
      INSERT INTO approval_requests
        (id, coreRequestId, reference, studentName, permitType, status, targetCorePersonId,
         targetIdentity, sessionId, notificationMessageId, clarificationCount)
      VALUES (?, ?, ?, 'Siswa', 'pulang', ?, 'person-a', ?, 'sess-a', ?, 0)`;

    await dataSource.transaction(async manager => {
      for (let index = 0; index < 500; index++) {
        await manager.query(insert, [
          `req-${index}`,
          `core-${index}`,
          `IZN-${index}`,
          index % 3 === 0 ? 'PENDING_APPROVAL' : 'APPROVED',
          index % 7 === 0 ? '628111000001' : `628111${String(index).padStart(6, '0')}`,
          `wamid-${index}`,
        ]);
      }
    });

    await dataSource.query('ANALYZE');
  }, 60_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('reads a quoted reply through the notification index instead of scanning the table', async () => {
    const plan = await planOf(QUOTED_REPLY, ['wamid-499', '628111000001']);

    expect(plan).toContain('IDX_approval_requests_notification');
    expect(plan).not.toContain('SCAN approval_requests');
  });

  it('reads the newest open request in index order, without a temporary sort', async () => {
    const plan = await planOf(SINGLE_OPEN, ['628111000001']);

    expect(plan).toContain('IDX_approval_requests_target_created');
    expect(plan).not.toContain('TEMP B-TREE');
    expect(plan).not.toContain('SCAN approval_requests');
  });

  it('keeps both migrations repeatable when the objects already exist', async () => {
    const runner: QueryRunner = dataSource.createQueryRunner();

    try {
      // What a partial restore looks like: the columns and indexes are there, but the ledger entry
      // may not be. Re-running `up()` must be a no-op rather than "already exists".
      await expect(new AddApprovalCommandRetry1792500000000().up(runner)).resolves.toBeUndefined();
      await expect(new AddApprovalLookupIndexes1792600000000().up(runner)).resolves.toBeUndefined();
    } finally {
      await runner.release();
    }

    const table = await dataSource.query<Array<{ name: string }>>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'approval_requests'`,
    );

    expect(table.map(row => row.name)).toEqual(
      expect.arrayContaining(['IDX_approval_requests_notification', 'IDX_approval_requests_target_created']),
    );
  });
});
