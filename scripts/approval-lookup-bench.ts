/**
 * Benchmark for the lookups the approval flow runs on every WhatsApp reply.
 *
 * The reply resolver reads `approval_requests` three ways: by `notificationMessageId` (a reply to the
 * notification), by `reference` (a reference in the text) and by `targetIdentity` + open status (the
 * single-open-request shortcut). Ingest additionally reads by `coreRequestId`. Only `reference` and
 * `coreRequestId` are indexed by the first migration; this script exists to show what the other two
 * cost as the table grows, and to prove the plan the lookup-index migration produces.
 *
 * Usage:
 *   npm run bench:approval                        # 20k rows, 40 rounds, with the lookup indexes
 *   BENCH_ROWS=50000 npm run bench:approval
 *   BENCH_WITH_INDEXES=0 npm run bench:approval   # baseline: the schema before 1792600000000
 *
 * The numbers are SQLite in-memory: they measure the query plan and the per-row cost, not production
 * latency. `EXPLAIN QUERY PLAN` is the part that matters — a `SCAN` visits every row, a `SEARCH`
 * visits the index.
 */
import 'reflect-metadata';
import { DataSource, MigrationInterface } from 'typeorm';
import { CreateApprovalWorkflow1792400000000 } from '../src/database/migrations/1792400000000-CreateApprovalWorkflow';
import { AddApprovalCommandRetry1792500000000 } from '../src/database/migrations/1792500000000-AddApprovalCommandRetry';
import { AddApprovalLookupIndexes1792600000000 } from '../src/database/migrations/1792600000000-AddApprovalLookupIndexes';

const ROWS = Number(process.env.BENCH_ROWS ?? 20_000);
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 40);
const WITH_INDEXES = process.env.BENCH_WITH_INDEXES !== '0';

interface PlanRow {
  detail: string;
}

const migrations: Array<new () => MigrationInterface> = [
  CreateApprovalWorkflow1792400000000,
  AddApprovalCommandRetry1792500000000,
];

if (WITH_INDEXES) {
  migrations.push(AddApprovalLookupIndexes1792600000000);
}

const dataSource = new DataSource({
  type: 'better-sqlite3',
  database: ':memory:',
  migrations,
  synchronize: false,
});

const measure = async (label: string, sql: string, parameters: unknown[]): Promise<void> => {
  const plan = (await dataSource.query(`EXPLAIN QUERY PLAN ${sql}`, parameters)) as PlanRow[];

  for (let round = 0; round < 5; round++) {
    await dataSource.query(sql, parameters);
  }

  const started = process.hrtime.bigint();

  for (let round = 0; round < ROUNDS; round++) {
    await dataSource.query(sql, parameters);
  }

  const microseconds = Number(process.hrtime.bigint() - started) / 1000 / ROUNDS;

  console.log(`\n${label}`);
  console.log(`  plan : ${plan.map(row => row.detail).join(' | ')}`);
  console.log(`  mean : ${microseconds.toFixed(1)} µs over ${ROUNDS} rounds`);
};

const seed = async (): Promise<number> => {
  const insert = `
    INSERT INTO approval_requests
      (id, coreRequestId, reference, studentName, permitType, status, targetCorePersonId,
       targetIdentity, sessionId, notificationMessageId, clarificationCount)
    VALUES (?, ?, ?, 'Siswa', 'pulang', ?, 'person-a', ?, 'sess-a', ?, 0)`;
  const started = Date.now();

  await dataSource.transaction(async manager => {
    for (let index = 0; index < ROWS; index++) {
      await manager.query(insert, [
        `req-${index}`,
        `core-${index}`,
        `IZN-${index}`,
        // One third open, so the single-open-request shortcut has a realistic match rate.
        index % 3 === 0 ? 'PENDING_APPROVAL' : 'APPROVED',
        // Every seventh row belongs to the sender the benchmark answers for.
        index % 7 === 0 ? '628111000001' : `628111${String(index).padStart(6, '0')}`,
        `wamid-${index}`,
      ]);
    }
  });

  return Date.now() - started;
};

const main = async (): Promise<void> => {
  await dataSource.initialize();
  await dataSource.runMigrations();

  console.log(`indexes: ${WITH_INDEXES ? 'with 1792600000000' : 'baseline (no lookup indexes)'}`);
  console.log(`seeded ${ROWS} approval_requests in ${await seed()} ms`);

  // Tanpa statistik SQLite memilih indeks dari estimasi bawaan. Database produksi punya statistik
  // (autovacuum/ANALYZE di PostgreSQL), jadi pengukuran ini juga harus punya.
  await dataSource.query('ANALYZE');

  await measure(
    '1. quoted reply — notificationMessageId + targetIdentity',
    `SELECT * FROM approval_requests WHERE notificationMessageId = ? AND targetIdentity = ? LIMIT 1`,
    [`wamid-${ROWS - 1}`, '628111000001'],
  );

  await measure(
    '2. reference in text — reference + targetIdentity',
    `SELECT * FROM approval_requests WHERE reference = ? AND targetIdentity = ? LIMIT 1`,
    [`IZN-${ROWS - 1}`, '628111000001'],
  );

  await measure(
    '3. single open request — targetIdentity + status, newest first',
    `SELECT * FROM approval_requests WHERE targetIdentity = ? AND status IN ('PENDING_APPROVAL','NEEDS_CLARIFICATION') ORDER BY createdAt DESC LIMIT 5`,
    ['628111000001'],
  );

  await measure(
    '4. ingest idempotency — coreRequestId',
    `SELECT * FROM approval_requests WHERE coreRequestId = ? LIMIT 1`,
    [`core-${ROWS - 1}`],
  );

  await dataSource.destroy();
};

void main();
