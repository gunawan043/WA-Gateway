import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `users` and `user_sessions` on the **main** connection — the email/password accounts the
 * dashboard signs in with, and the revocable sessions they hold.
 *
 * `main` is always SQLite (boot config) and this chain runs at every boot, so both tables are
 * `IF NOT EXISTS` and the indexes are named explicitly. Named indexes matter twice here: the boot
 * check (`createMainDataSource`) refuses a database whose columns do not match the entities, and the
 * migration-drift gate compares index names — an auto-generated `IDX_<hash>` name on one side and a
 * hand-written name on the other is exactly the drift that gate exists to catch.
 *
 * Every user owns one `api_keys` row (`users.apiKeyId`), created by UsersService in the same
 * transaction. No cross-table FK: the auth tables predate foreign keys here and a cascade would
 * delete an audit actor's row silently.
 */
export class AddUsersAndSessions1786700000000 implements MigrationInterface {
  name = 'AddUsersAndSessions1786700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "users" (` +
        `"id" varchar PRIMARY KEY NOT NULL, ` +
        `"email" varchar(190) NOT NULL, ` +
        `"name" varchar(100) NOT NULL, ` +
        `"passwordHash" varchar(255) NOT NULL, ` +
        `"role" varchar(20) NOT NULL DEFAULT ('operator'), ` +
        `"isActive" boolean NOT NULL DEFAULT (1), ` +
        `"apiKeyId" varchar(36) NOT NULL, ` +
        `"lastLoginAt" datetime, ` +
        `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"updatedAt" datetime NOT NULL DEFAULT (datetime('now'))` +
        `)`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_users_email" ON "users" ("email")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_users_apiKeyId" ON "users" ("apiKeyId")`);

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "user_sessions" (` +
        `"id" varchar PRIMARY KEY NOT NULL, ` +
        `"userId" varchar(36) NOT NULL, ` +
        `"tokenHash" varchar(64) NOT NULL, ` +
        `"expiresAt" datetime NOT NULL, ` +
        `"revokedAt" datetime, ` +
        `"lastSeenAt" datetime, ` +
        `"userAgent" varchar(255), ` +
        `"ipAddress" varchar(45), ` +
        `"createdAt" datetime NOT NULL DEFAULT (datetime('now'))` +
        `)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_user_sessions_tokenHash" ON "user_sessions" ("tokenHash")`,
    );
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_user_sessions_userId" ON "user_sessions" ("userId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_user_sessions_userId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_user_sessions_tokenHash"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "user_sessions"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_users_apiKeyId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_users_email"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "users"`);
  }
}
