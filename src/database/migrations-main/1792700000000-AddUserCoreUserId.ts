import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `users.coreUserId` on the **main** connection — the external identity the ALIM Core SSO
 * handoff maps on.
 *
 * Additive and idempotent, like the rest of this chain: the column is probed before the ALTER, so a
 * file that `synchronize` already built is adopted, and a run interrupted after the DDL completes on
 * the next boot. The unique index is created only when absent; SQLite treats NULLs as distinct, so
 * every account that is not mapped yet keeps a NULL and the index still refuses two accounts mapped
 * to the same Core person.
 */
export class AddUserCoreUserId1792700000000 implements MigrationInterface {
  name = 'AddUserCoreUserId1792700000000';

  private async hasColumn(queryRunner: QueryRunner): Promise<boolean> {
    const rows = (await queryRunner.query(`PRAGMA table_info("users")`)) as Array<{ name: string }>;
    return rows.some(row => row.name === 'coreUserId');
  }

  private async hasIndex(queryRunner: QueryRunner): Promise<boolean> {
    const rows = (await queryRunner.query(`PRAGMA index_list("users")`)) as Array<{ name: string }>;
    return rows.some(row => row.name === 'UQ_users_coreUserId');
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.hasColumn(queryRunner))) {
      await queryRunner.query(`ALTER TABLE "users" ADD COLUMN "coreUserId" varchar(64)`);
    }
    if (!(await this.hasIndex(queryRunner))) {
      await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_users_coreUserId" ON "users" ("coreUserId")`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await this.hasIndex(queryRunner)) {
      await queryRunner.query(`DROP INDEX IF EXISTS "UQ_users_coreUserId"`);
    }
    if (await this.hasColumn(queryRunner)) {
      await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "coreUserId"`);
    }
  }
}
