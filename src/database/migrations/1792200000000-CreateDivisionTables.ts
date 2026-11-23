import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the division-routing tables and tags inbox conversations with a division.
 *
 * `divisions` is the menu the customer sees; `division_agents` is its membership (an api key id with
 * no foreign key — keys live on the always-SQLite main connection); `division_settings` is the
 * per-session text and idle policy, created on first save so a session runs on defaults with no
 * backfill; `division_chat_states` is the per-chat state machine, unique on `(sessionId, chatId)`
 * because that pair is what the router claims before sending a menu.
 *
 * The two `inbox_conversations` columns are a denormalised display tag with a name snapshot, the
 * same convention `assigneeKeyId`/`assigneeName` follow: no foreign key, so deleting a division
 * never cascades a conversation away.
 */
export class CreateDivisionTables1792200000000 implements MigrationInterface {
  name = 'CreateDivisionTables1792200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('divisions')) return;
    const isPostgres = queryRunner.dataSource.options.type === 'postgres';

    if (isPostgres) {
      await queryRunner.query(
        `CREATE TABLE "divisions" ("id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar, ` +
          `"sessionId" varchar NOT NULL, "name" varchar(100) NOT NULL, "keywords" text NOT NULL DEFAULT '[]', ` +
          `"menuLabel" varchar(100), "welcomeText" text, "sortOrder" int NOT NULL DEFAULT 0, ` +
          `"isActive" boolean NOT NULL DEFAULT true, ` +
          `"createdAt" timestamp NOT NULL DEFAULT NOW(), "updatedAt" timestamp NOT NULL DEFAULT NOW(), ` +
          `CONSTRAINT "FK_divisions_sessionId" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE)`,
      );
      await queryRunner.query(
        `CREATE TABLE "division_agents" ("id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar, ` +
          `"divisionId" varchar NOT NULL, "apiKeyId" varchar(36) NOT NULL, "agentName" varchar(100) NOT NULL, ` +
          `"createdAt" timestamp NOT NULL DEFAULT NOW(), ` +
          `CONSTRAINT "FK_division_agents_divisionId" FOREIGN KEY ("divisionId") REFERENCES "divisions" ("id") ON DELETE CASCADE)`,
      );
      await queryRunner.query(
        `CREATE TABLE "division_settings" ("id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar, ` +
          `"sessionId" varchar NOT NULL, "enabled" boolean NOT NULL DEFAULT true, "menuHeader" text, ` +
          `"invalidReply" text, "idleHours" int NOT NULL DEFAULT 24, ` +
          `"createdAt" timestamp NOT NULL DEFAULT NOW(), "updatedAt" timestamp NOT NULL DEFAULT NOW(), ` +
          `CONSTRAINT "FK_division_settings_sessionId" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE)`,
      );
      await queryRunner.query(
        `CREATE TABLE "division_chat_states" ("id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar, ` +
          `"sessionId" varchar NOT NULL, "chatId" varchar(100) NOT NULL, ` +
          `"status" varchar(16) NOT NULL DEFAULT 'awaiting', "divisionId" varchar, ` +
          `"menuDivisionIds" text, "promptedAt" timestamp, "invalidReplyAt" timestamp, "routedAt" timestamp, ` +
          `"lastInboundAt" timestamp, ` +
          `"createdAt" timestamp NOT NULL DEFAULT NOW(), "updatedAt" timestamp NOT NULL DEFAULT NOW(), ` +
          `CONSTRAINT "FK_division_chat_states_sessionId" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE, ` +
          `CONSTRAINT "FK_division_chat_states_divisionId" FOREIGN KEY ("divisionId") REFERENCES "divisions" ("id") ON DELETE SET NULL)`,
      );
    } else {
      await queryRunner.query(
        `CREATE TABLE "divisions" ("id" varchar PRIMARY KEY NOT NULL, ` +
          `"sessionId" varchar NOT NULL, "name" varchar(100) NOT NULL, "keywords" text NOT NULL DEFAULT ('[]'), ` +
          `"menuLabel" varchar(100), "welcomeText" text, "sortOrder" integer NOT NULL DEFAULT (0), ` +
          `"isActive" boolean NOT NULL DEFAULT (1), ` +
          `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
          `CONSTRAINT "FK_divisions_sessionId" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
      );
      await queryRunner.query(
        `CREATE TABLE "division_agents" ("id" varchar PRIMARY KEY NOT NULL, ` +
          `"divisionId" varchar NOT NULL, "apiKeyId" varchar(36) NOT NULL, "agentName" varchar(100) NOT NULL, ` +
          `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
          `CONSTRAINT "FK_division_agents_divisionId" FOREIGN KEY ("divisionId") REFERENCES "divisions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
      );
      await queryRunner.query(
        `CREATE TABLE "division_settings" ("id" varchar PRIMARY KEY NOT NULL, ` +
          `"sessionId" varchar NOT NULL, "enabled" boolean NOT NULL DEFAULT (1), "menuHeader" text, ` +
          `"invalidReply" text, "idleHours" integer NOT NULL DEFAULT (24), ` +
          `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
          `CONSTRAINT "FK_division_settings_sessionId" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
      );
      await queryRunner.query(
        `CREATE TABLE "division_chat_states" ("id" varchar PRIMARY KEY NOT NULL, ` +
          `"sessionId" varchar NOT NULL, "chatId" varchar(100) NOT NULL, ` +
          `"status" varchar(16) NOT NULL DEFAULT ('awaiting'), "divisionId" varchar, ` +
          `"menuDivisionIds" text, "promptedAt" datetime, "invalidReplyAt" datetime, "routedAt" datetime, ` +
          `"lastInboundAt" datetime, ` +
          `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
          `CONSTRAINT "FK_division_chat_states_sessionId" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION, ` +
          `CONSTRAINT "FK_division_chat_states_divisionId" FOREIGN KEY ("divisionId") REFERENCES "divisions" ("id") ON DELETE SET NULL ON UPDATE NO ACTION)`,
      );
    }

    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_divisions_session_name" ON "divisions" ("sessionId", "name")`);
    await queryRunner.query(`CREATE INDEX "IDX_divisions_session_sort" ON "divisions" ("sessionId", "sortOrder")`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_division_agents_division_key" ON "division_agents" ("divisionId", "apiKeyId")`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_division_settings_session" ON "division_settings" ("sessionId")`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_division_chat_states_session_chat" ON "division_chat_states" ("sessionId", "chatId")`,
    );

    // ALTER ... ADD COLUMN without a default is portable across both dialects.
    if (!(await queryRunner.hasColumn('inbox_conversations', 'divisionId'))) {
      await queryRunner.query(`ALTER TABLE "inbox_conversations" ADD COLUMN "divisionId" varchar(36)`);
    }
    if (!(await queryRunner.hasColumn('inbox_conversations', 'divisionName'))) {
      await queryRunner.query(`ALTER TABLE "inbox_conversations" ADD COLUMN "divisionName" varchar(100)`);
    }
    await queryRunner.query(
      `CREATE INDEX "IDX_inbox_conversations_session_division" ON "inbox_conversations" ("sessionId", "divisionId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_inbox_conversations_session_division"`);
    if (await queryRunner.hasColumn('inbox_conversations', 'divisionName')) {
      await queryRunner.query(`ALTER TABLE "inbox_conversations" DROP COLUMN "divisionName"`);
    }
    if (await queryRunner.hasColumn('inbox_conversations', 'divisionId')) {
      await queryRunner.query(`ALTER TABLE "inbox_conversations" DROP COLUMN "divisionId"`);
    }
    await queryRunner.query(`DROP TABLE IF EXISTS "division_chat_states"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "division_settings"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "division_agents"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "divisions"`);
  }
}
