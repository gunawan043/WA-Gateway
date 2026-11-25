import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Emits the INSERT statements that write the data-connection migration ledger.
 *
 * WHY THIS EXISTS
 * ---------------
 * The production data database was found with 33 tables but an EMPTY `public.migrations`. TypeORM
 * decides what to run by comparing that ledger against `src/database/migrations/*`, so an empty
 * ledger reads as "nothing has ever run": the next boot would replay all 58 migrations against a
 * schema that already has them. Most are guarded (`hasTable`, `hasColumn`, index-name checks), but
 * "most" is not "all", and a replay rewrites tables on SQLite and can fail hard on Postgres.
 *
 * This script produces the OTHER half of the decision: the exact rows that make the ledger agree
 * with a schema that was built outside the migration path. It writes SQL ONLY. It never connects to
 * a database and never executes anything — the DB owner reviews and runs it, or chooses the fresh
 * database path instead (see docs/integration/alim-connect-production-deployment-cycle-1.md §5).
 *
 * HOW THE ROW IS DERIVED
 * ----------------------
 * TypeORM's `MigrationExecutor` inserts `(timestamp, name)` where both come from the loaded class:
 * the `timestamp` from the class's `name` suffix and the `name` from the class `name` itself
 * (node_modules/typeorm/migration/MigrationExecutor.js). So the rows are read from the classes, not
 * parsed from filenames, and `--only` can restrict the ledger to the part of the chain a schema
 * demonstrably already reflects.
 *
 * Usage:
 *   npx ts-node scripts/emit-migration-baseline.ts                  > baseline.sql
 *   npx ts-node scripts/emit-migration-baseline.ts --only=headless > baseline-approval-only.sql
 */

interface Entry {
  timestamp: number;
  name: string;
  file: string;
}

const MIGRATION_DIR = join(__dirname, '..', 'src', 'database', 'migrations');

/** A migration class is the one export whose prototype owns `up`. */
function classOf(source: string, file: string): new () => { up: unknown } {
  // The classes are plain TS with no imports we need; a narrow regex keeps this dependency-free.
  const match = /export class ([A-Za-z0-9_]+)\s+implements\s+MigrationInterface/.exec(source);
  if (!match) throw new Error(`No migration class in ${file}`);
  return { name: match[1] } as unknown as new () => { up: unknown };
}

function entries(): Entry[] {
  return readdirSync(MIGRATION_DIR)
    .filter(file => /^\d+-.+\.ts$/.test(file) && !file.endsWith('.spec.ts'))
    .sort()
    .map(file => {
      const source = require('node:fs').readFileSync(join(MIGRATION_DIR, file), 'utf8') as string;
      const cls = classOf(source, file);
      const timestamp = Number(file.split('-')[0]);
      const name = cls.name;
      // The class name must END with its timestamp, which is what TypeORM parses back out. A class
      // whose name does not would be written with a different timestamp than its file, and the
      // ledger would then silently skip or repeat it.
      if (!name.endsWith(String(timestamp))) {
        throw new Error(`Class ${name} does not end with its file timestamp ${timestamp} (${file})`);
      }
      return { timestamp, name, file };
    });
}

/**
 * The approval/SSO slice of the chain, in order. A database that already has the three approval
 * tables, their retry columns and their lookup indexes reflects exactly these migrations.
 */
const HEADLESS = ['1792400000000', '1792500000000', '1792600000000'];

function main(): void {
  const argv = process.argv.slice(2);
  const headless = argv.includes('--only=headless');
  const all = entries();
  const selected = headless ? all.filter(entry => HEADLESS.includes(String(entry.timestamp))) : all;

  const lines: string[] = [
    '-- ALIM Connect — data-connection migration ledger baseline (GENERATED, review before running).',
    '--',
    `-- Source: ${all.length} migrations in src/database/migrations.`,
    headless
      ? `-- Scope: --only=headless, ${selected.length} approval/SSO migrations ONLY.`
      : `-- Scope: the whole chain, ${selected.length} migrations.`,
    '--',
    '-- Run this ONLY after confirming the target schema already contains what each listed',
    '-- migration creates. It records history; it does not create anything. Verify afterwards with:',
    '--   SELECT count(*), min(timestamp), max(timestamp) FROM public.migrations;',
    '--',
    '-- Wrapped in one transaction: a partial ledger is worse than none.',
    'BEGIN;',
    '',
  ];

  if (!headless) {
    lines.push(
      '-- The whole-chain form asserts that ALL 58 migrations are reflected in the schema.',
      '-- Use it only on a database that was built by this exact chain.',
      '',
    );
  }

  for (const entry of selected) {
    // NOT `ON CONFLICT DO NOTHING`: the only unique key on this table is `id`, which the sequence
    // supplies, so a conflict clause would never fire and a second run would double every row.
    // A guarded insert makes a mistaken re-run harmless without depending on an index that is not
    // there.
    lines.push(
      `INSERT INTO public.migrations (timestamp, name)`,
      `  SELECT ${entry.timestamp}, '${entry.name}'`,
      `  WHERE NOT EXISTS (SELECT 1 FROM public.migrations WHERE timestamp = ${entry.timestamp});`,
    );
  }

  lines.push('', 'COMMIT;', '');
  process.stdout.write(lines.join('\n'));
  // Written to stderr so stdout stays pipeable into a file.
  process.stderr.write(
    headless
      ? `Emitting ${selected.length} approval/SSO ledger rows (of ${all.length}).\n`
      : `Emitting ALL ${selected.length} ledger rows. Read the warning at the top of the file.\n`,
  );
}

main();
