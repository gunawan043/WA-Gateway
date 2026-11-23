#!/usr/bin/env node
/**
 * Read-only retention report for the approval tables.
 *
 * Connect stores personal data (student names, WhatsApp numbers, the text the dormitory head replied
 * with, and Core's response body) and has no automatic deletion. A retention period is a policy
 * decision that has not been made, so this script does not delete anything and takes no period as an
 * argument: it reports how much data exists in each age bucket so the owner can decide from numbers
 * instead of from a guess.
 *
 * Read-only by construction: every statement is a SELECT, and the SQLite connection is opened with
 * `readonly: true`.
 *
 * Usage:
 *   npm run retention:approval
 *   DATABASE_TYPE=postgres node scripts/approval-retention-report.js
 *
 * Output: one line per table and bucket, then the PII-bearing columns that are populated.
 */

const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');

// Same precedence as the app, simplified: process.env wins, then .env.
if (!process.env.DATABASE_TYPE && fs.existsSync(path.join(root, '.env'))) {
  require(path.join(root, 'node_modules', 'dotenv')).config({ path: path.join(root, '.env') });
}

const BUCKETS = [30, 90, 180, 365];
const TABLES = ['approval_requests', 'approval_commands'];

const ssl =
  process.env.DATABASE_SSL === 'true'
    ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' }
    : undefined;

async function withSqlite(run) {
  const Database = require(path.join(root, 'node_modules', 'better-sqlite3'));
  const file = process.env.DATABASE_NAME || path.join(root, 'data', 'openwa.sqlite');
  const database = new Database(file, { readonly: true, fileMustExist: true });

  try {
    return await run({
      all: (sql, parameters = []) => database.prepare(sql).all(...parameters),
    });
  } finally {
    database.close();
  }
}

async function withPostgres(run) {
  const { Client } = require(path.join(root, 'node_modules', 'pg'));
  const client = new Client({
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT || 5432),
    user: process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    ssl,
  });

  await client.connect();

  try {
    return await run({
      all: async (sql, parameters = []) => (await client.query(sql, parameters)).rows,
    });
  } finally {
    await client.end();
  }
}

const columnsOf = async (db, table) => {
  const rows =
    process.env.DATABASE_TYPE === 'postgres'
      ? await db.all(
          `SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
          [table],
        )
      : await db.all(`SELECT name FROM pragma_table_info(?)`, [table]);

  return rows.map(row => row.name);
};

const report = async (db, postgres) => {
  // The cutoff is written per dialect: SQLite stores `createdAt` as text and compares it with
  // `datetime('now', '-N days')`, PostgreSQL with a real interval.
  const cutoff = days =>
    postgres ? `CURRENT_TIMESTAMP - INTERVAL '${days} days'` : `datetime('now', '-${days} days')`;

  for (const table of TABLES) {
    const columns = await columnsOf(db, table);

    if (columns.length === 0) {
      console.log(`\n${table}: tidak ada di database ini`);
      continue;
    }

    const [totals] = await db.all(
      `SELECT COUNT(*) AS total, MIN("createdAt") AS oldest, MAX("createdAt") AS newest FROM "${table}"`,
    );

    console.log(`\n${table}: ${totals.total} baris`);
    console.log(`  tertua : ${totals.oldest ?? '-'}`);
    console.log(`  terbaru: ${totals.newest ?? '-'}`);

    for (const days of BUCKETS) {
      const [row] = await db.all(
        `SELECT COUNT(*) AS count FROM "${table}" WHERE "createdAt" < ${cutoff(days)}`,
      );

      console.log(`  lebih tua dari ${String(days).padStart(3)} hari: ${row.count}`);
    }
  }

  console.log('\nKolom yang berisi data pribadi dan terisi:');

  const checks = [
    ['approval_requests', 'studentName', 'nama santri'],
    ['approval_requests', 'studentClass', 'kelas santri'],
    ['approval_requests', 'targetIdentity', 'nomor WhatsApp Kepala Asrama'],
    ['approval_requests', 'targetCorePersonId', 'identitas personel Core'],
    ['approval_requests', 'dormitoryName', 'nama asrama'],
    ['approval_requests', 'notificationMessageId', 'id pesan notifikasi'],
    ['approval_commands', 'externalMessageId', 'id pesan WhatsApp'],
    ['approval_commands', 'lastError', 'teks error (dapat memuat pesan Core)'],
    ['approval_commands', 'coreResponseBody', 'body respons Core'],
  ];

  for (const [table, column, label] of checks) {
    const columns = await columnsOf(db, table);

    if (!columns.includes(column)) continue;

    const [row] = await db.all(`SELECT COUNT(*) AS count FROM "${table}" WHERE "${column}" IS NOT NULL`);

    console.log(`  ${table}.${column} (${label}): ${row.count} baris terisi`);
  }
};

(async () => {
  const postgres = process.env.DATABASE_TYPE === 'postgres';

  console.log(`retensi approval — ${postgres ? 'postgres' : 'sqlite'}, hanya baca`);

  if (postgres) {
    await withPostgres(db => report(db, true));
  } else {
    await withSqlite(db => report(db, false));
  }

  console.log('\nTidak ada baris yang dihapus. Masa retensi belum ditetapkan; lihat docs/integration/alim-connect-pdca-cycle-2.md §6.');
})().catch(error => {
  console.error(`gagal: ${error.message}`);
  process.exit(1);
});
