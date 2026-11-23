import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the team-inbox tables. A conversation row exists only once someone assigns it, changes its
 * status, or writes a note — a chat with no row is implicitly open and unassigned — so there is no
 * backfill. The unique index on `(sessionId, chatId)` is what makes "get or create" safe under two
 * agents acting at once.
 *
 * CASCADE from `sessions`: an inbox row has no meaning after its session is gone. The same applies
 * from a conversation to its notes. `assigneeKeyId` deliberately carries NO foreign key: API keys
 * live on the always-SQLite `main` connection, a different database from this one.
 */
export class CreateInboxTables1791900000000 implements MigrationInterface {
  name = 'CreateInboxTables1791900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('inbox_conversations')) return;
    const isPostgres = queryRunner.dataSource.options.type === 'postgres';

    if (isPostgres) {
      await queryRunner.query(
        `CREATE TABLE "inbox_conversations" ("id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar, ` +
          `"sessionId" varchar NOT NULL, "chatId" varchar(100) NOT NULL, ` +
          `"status" varchar(16) NOT NULL DEFAULT 'open', "assigneeKeyId" varchar(36), ` +
          `"assigneeName" varchar(100), "resolvedAt" timestamp, "lastInboundAt" timestamp, ` +
          `"createdAt" timestamp NOT NULL DEFAULT NOW(), "updatedAt" timestamp NOT NULL DEFAULT NOW(), ` +
          `CONSTRAINT "FK_inbox_conversations_sessionId" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE)`,
      );
      await queryRunner.query(
        `CREATE TABLE "inbox_notes" ("id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar, ` +
          `"conversationId" varchar(36) NOT NULL, "authorKeyId" varchar(36) NOT NULL, ` +
          `"authorName" varchar(100) NOT NULL, "body" text NOT NULL, ` +
          `"createdAt" timestamp NOT NULL DEFAULT NOW(), ` +
          `CONSTRAINT "FK_inbox_notes_conversationId" FOREIGN KEY ("conversationId") REFERENCES "inbox_conversations" ("id") ON DELETE CASCADE)`,
      );
    } else {
      await queryRunner.query(
        `CREATE TABLE "inbox_conversations" ("id" varchar PRIMARY KEY NOT NULL, ` +
          `"sessionId" varchar NOT NULL, "chatId" varchar(100) NOT NULL, ` +
          `"status" varchar(16) NOT NULL DEFAULT ('open'), "assigneeKeyId" varchar(36), ` +
          `"assigneeName" varchar(100), "resolvedAt" datetime, "lastInboundAt" datetime, ` +
          `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
          `CONSTRAINT "FK_inbox_conversations_sessionId" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
      );
      await queryRunner.query(
        `CREATE TABLE "inbox_notes" ("id" varchar PRIMARY KEY NOT NULL, ` +
          `"conversationId" varchar(36) NOT NULL, "authorKeyId" varchar(36) NOT NULL, ` +
          `"authorName" varchar(100) NOT NULL, "body" text NOT NULL, ` +
          `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
          `CONSTRAINT "FK_inbox_notes_conversationId" FOREIGN KEY ("conversationId") REFERENCES "inbox_conversations" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
      );
    }

    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_inbox_conversations_session_chat" ON "inbox_conversations" ("sessionId", "chatId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_inbox_conversations_session_status" ON "inbox_conversations" ("sessionId", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_inbox_conversations_session_assignee" ON "inbox_conversations" ("sessionId", "assigneeKeyId")`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_inbox_notes_conversationId" ON "inbox_notes" ("conversationId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_inbox_notes_conversationId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_inbox_conversations_session_assignee"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_inbox_conversations_session_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_inbox_conversations_session_chat"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "inbox_notes"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "inbox_conversations"`);
  }
}
