import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the first-response SLA to division routing.
 *
 * `divisions.slaMinutes` is the per-division target; 0 means the division has no SLA, which is the
 * default so every existing division keeps behaving exactly as it does today.
 *
 * `inbox_conversations` gains the clock itself rather than computing it at read time: a deadline
 * that moves when someone edits the division is not a deadline, and a stored `slaDueAt` lets the
 * sweeper find overdue conversations with one indexed range query instead of scanning every row.
 *
 * - `firstInboundAt`  first inbound message ever seen for the chat (reports: response time)
 * - `firstResponseAt` first human reply after the clock started (reports: first response time)
 * - `slaStartedAt`    when the current window opened; an inbound message while nobody has answered
 *                     restarts it, a human reply stops it
 * - `slaDueAt`        `slaStartedAt + slaMinutes`, null while no window is open
 * - `slaBreachedAt`   when the sweeper first saw the window overdue; survives a late reply so the
 *                     breach stays on the record
 * - `slaMinutes`      snapshot of the target at `slaStartedAt`, so editing the division later does
 *                     not retroactively rewrite whether a past conversation met its SLA
 *
 * No foreign keys: the columns are per-conversation state, and a division can be deleted while its
 * conversations (and their SLA history) remain.
 */
export class AddInboxSla1792300000000 implements MigrationInterface {
  name = 'AddInboxSla1792300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.dataSource.options.type === 'postgres';
    // `dateColumnType()` resolves to 'text' on SQLite and DateTransformer writes ISO strings, so
    // 'text' is what the entity metadata expects. The older tables used 'datetime' (same TEXT
    // affinity) and that difference is pinned in the drift snapshot; new columns do not add to it.
    const stamp = isPostgres ? 'timestamp' : 'text';

    if (!(await queryRunner.hasColumn('divisions', 'slaMinutes'))) {
      await queryRunner.query(`ALTER TABLE "divisions" ADD COLUMN "slaMinutes" integer NOT NULL DEFAULT 0`);
    }

    if (await queryRunner.hasTable('inbox_conversations')) {
      const columns: Array<[string, string]> = [
        ['firstInboundAt', stamp],
        ['firstResponseAt', stamp],
        ['slaStartedAt', stamp],
        ['slaDueAt', stamp],
        ['slaBreachedAt', stamp],
      ];
      for (const [name, type] of columns) {
        if (!(await queryRunner.hasColumn('inbox_conversations', name))) {
          await queryRunner.query(`ALTER TABLE "inbox_conversations" ADD COLUMN "${name}" ${type}`);
        }
      }
      if (!(await queryRunner.hasColumn('inbox_conversations', 'slaMinutes'))) {
        await queryRunner.query(`ALTER TABLE "inbox_conversations" ADD COLUMN "slaMinutes" integer`);
      }

      // The sweeper's only query: open windows whose deadline has passed.
      await queryRunner.query(`CREATE INDEX "IDX_inbox_conversations_sla_due" ON "inbox_conversations" ("slaDueAt")`);
      // Reports filter by session and then by the first-inbound window.
      await queryRunner.query(
        `CREATE INDEX "IDX_inbox_conversations_session_first_inbound" ON "inbox_conversations" ("sessionId", "firstInboundAt")`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_inbox_conversations_session_first_inbound"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_inbox_conversations_sla_due"`);

    if (await queryRunner.hasTable('inbox_conversations')) {
      for (const name of [
        'slaMinutes',
        'slaBreachedAt',
        'slaDueAt',
        'slaStartedAt',
        'firstResponseAt',
        'firstInboundAt',
      ]) {
        if (await queryRunner.hasColumn('inbox_conversations', name)) {
          await queryRunner.query(`ALTER TABLE "inbox_conversations" DROP COLUMN "${name}"`);
        }
      }
    }
    if (await queryRunner.hasColumn('divisions', 'slaMinutes')) {
      await queryRunner.query(`ALTER TABLE "divisions" DROP COLUMN "slaMinutes"`);
    }
  }
}
