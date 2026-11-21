// Compares each existing key's legacy role against the authorization its role_assignments grant,
// so the behaviour-changing stage of Fase 1 is only enabled once every backfilled key is proven to
// authorize exactly as it did before (docs/35 §35.7.2).
//
// Read-only: two SELECTs, no migration, no write. Exits 1 on any mismatch, so it can gate a deploy.
//
// Usage: npm run rbac:verify
//        MAIN_DATABASE_NAME=/path/to/main.sqlite npm run rbac:verify
import '../src/config/load-env';
import { DataSource } from 'typeorm';
import { formatVerifyReport, verifyBackfill, type VerifyAssignmentRow, type VerifyKeyRow } from '../src/modules/auth/rbac-verify';

async function main(): Promise<void> {
  const file = process.env.MAIN_DATABASE_NAME || './data/main.sqlite';
  const ds = new DataSource({ type: 'better-sqlite3', database: file, entities: [], synchronize: false });
  await ds.initialize();

  try {
    const keys = await ds.query<VerifyKeyRow[]>('SELECT "id", "name", "role", "isActive" FROM "api_keys"');

    let assignments: VerifyAssignmentRow[] = [];
    try {
      assignments = await ds.query<VerifyAssignmentRow[]>(
        'SELECT "apiKeyId", "role", "scopeType", "scopeId", "validFrom", "validTo" FROM "role_assignments"',
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/no such table/i.test(message)) {
        console.error(
          `role_assignments does not exist in ${file}. Boot this release once (it runs the migrations-main chain) before verifying.`,
        );
        process.exit(1);
      }
      throw err;
    }

    const report = verifyBackfill(keys, assignments);
    console.log(formatVerifyReport(report));
    if (!report.ok) process.exit(1);
  } finally {
    await ds.destroy().catch(() => undefined);
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
