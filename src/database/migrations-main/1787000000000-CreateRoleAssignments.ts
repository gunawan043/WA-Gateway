import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `role_assignments` on the **main** connection and backfills one global grant per existing
 * key from its legacy `api_keys.role` (docs/35 §35.7.1).
 *
 * Additive only: no existing table or column is touched. The backfill is idempotent — every row is
 * written with `INSERT OR IGNORE` against the unique index on
 * `(apiKeyId, role, scopeType, scopeId)` — so a migration re-run after an interrupted boot (or a
 * second boot of the same file) cannot duplicate a grant.
 *
 * The grants are `global` on purpose: today's authority comes from `allowedSessions`/`allowedChats`,
 * which stay enforced as credential fences above the assignment, so a backfilled key authorizes
 * exactly what it did before Fase 1. `rbac:verify` proves that before the behaviour-changing stage
 * is enabled.
 *
 * `scopeId` is `''` for a global grant, never NULL: SQLite treats every NULL as distinct, so a
 * nullable column would let the unique index admit the same global grant twice.
 */
export class CreateRoleAssignments1787000000000 implements MigrationInterface {
  name = 'CreateRoleAssignments1787000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "role_assignments" (` +
        `"id" varchar PRIMARY KEY NOT NULL, ` +
        `"apiKeyId" varchar(36) NOT NULL, ` +
        `"userId" varchar(36), ` +
        `"role" varchar(32) NOT NULL, ` +
        `"scopeType" varchar(16) NOT NULL, ` +
        `"scopeId" varchar(64) NOT NULL DEFAULT (''), ` +
        `"source" varchar(16) NOT NULL DEFAULT ('local'), ` +
        `"externalId" varchar(64), ` +
        `"validFrom" datetime, ` +
        `"validTo" datetime, ` +
        `"grantedByKeyId" varchar(36), ` +
        `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"updatedAt" datetime NOT NULL DEFAULT (datetime('now'))` +
        `)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_role_assignments_scope" ` +
        `ON "role_assignments" ("apiKeyId", "role", "scopeType", "scopeId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_role_assignments_apiKeyId" ON "role_assignments" ("apiKeyId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_role_assignments_userId" ON "role_assignments" ("userId")`,
    );

    // The account behind a key, when there is one. `users` is created by an earlier migration in
    // this chain, but the guard keeps the backfill safe on a file whose chain was adopted halfway.
    const userJoin = (await queryRunner.hasTable('users'))
      ? `(SELECT "u"."id" FROM "users" "u" WHERE "u"."apiKeyId" = "k"."id" LIMIT 1)`
      : `NULL`;

    // `admin` held both administrative roles' authority, so it receives both grants; `operator` and
    // `viewer` map to the roles whose permission set equals what they could do before (35.4).
    const backfill = (legacyRole: string, role: string): string =>
      `INSERT OR IGNORE INTO "role_assignments" ` +
      `("id", "apiKeyId", "userId", "role", "scopeType", "scopeId", "source", "externalId", ` +
      `"validFrom", "validTo", "grantedByKeyId", "createdAt", "updatedAt") ` +
      `SELECT lower(hex(randomblob(16))), "k"."id", ${userJoin}, '${role}', 'global', '', 'local', NULL, ` +
      `NULL, NULL, NULL, datetime('now'), datetime('now') ` +
      `FROM "api_keys" "k" WHERE "k"."role" = '${legacyRole}'`;

    await queryRunner.query(backfill('admin', 'system_admin'));
    await queryRunner.query(backfill('admin', 'connect_admin'));
    await queryRunner.query(backfill('operator', 'agent'));
    await queryRunner.query(backfill('viewer', 'analyst'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Safe: `api_keys.role` is still the source of truth, so dropping the table loses no authority.
    // Only for disaster recovery — a normal application rollback leaves the table in place (35.7.5).
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_role_assignments_userId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_role_assignments_apiKeyId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_role_assignments_scope"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "role_assignments"`);
  }
}
