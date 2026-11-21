import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `api_keys.authzVersion` on the **main** connection — the counter that lets an assignment
 * change invalidate a live WebSocket even when no column the fingerprint used to read moved
 * (docs/35 §35.5.4).
 *
 * Additive and idempotent: the column is probed before the ALTER, so a file created by
 * `synchronize` is adopted and a run interrupted after the DDL still completes.
 */
export class AddApiKeyAuthzVersion1787010000000 implements MigrationInterface {
  name = 'AddApiKeyAuthzVersion1787010000000';

  private async hasColumn(queryRunner: QueryRunner): Promise<boolean> {
    const rows = (await queryRunner.query(`PRAGMA table_info("api_keys")`)) as Array<{ name: string }>;
    return rows.some(r => r.name === 'authzVersion');
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.hasColumn(queryRunner))) {
      await queryRunner.query(`ALTER TABLE "api_keys" ADD COLUMN "authzVersion" integer NOT NULL DEFAULT (0)`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await this.hasColumn(queryRunner)) {
      await queryRunner.query(`ALTER TABLE "api_keys" DROP COLUMN "authzVersion"`);
    }
  }
}
