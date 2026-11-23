import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the campaign tables: the campaign itself, its per-chat recipient rows and the saved
 * segments a campaign's audience can point at.
 *
 * `campaigns.sessionId` is NOT a foreign key. A campaign is a record of a broadcast, and deleting the
 * WhatsApp session must not erase what was sent — the same rule `crm_deals` follows. The runner
 * refuses to start such a campaign, which is the correct outcome for a session that no longer exists.
 *
 * `campaign_recipients` cascades from its campaign, so deleting a draft removes its rows in one
 * statement. `(campaignId, chatId)` is unique: resolving the audience again after a restart cannot
 * duplicate a recipient, and the runner only ever picks up rows that are still `pending`.
 */
export class CreateCampaignTables1792100000000 implements MigrationInterface {
  name = 'CreateCampaignTables1792100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('campaigns')) return;
    const isPostgres = queryRunner.dataSource.options.type === 'postgres';

    if (isPostgres) {
      await queryRunner.query(
        `CREATE TABLE "campaigns" ("id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar, ` +
          `"sessionId" varchar(100) NOT NULL, "name" varchar(120) NOT NULL, ` +
          `"status" varchar(16) NOT NULL DEFAULT 'draft', ` +
          `"content" text NOT NULL, "options" text NOT NULL, "audience" text NOT NULL, "progress" text NOT NULL, ` +
          `"scheduledAt" timestamp, "startedAt" timestamp, "completedAt" timestamp, ` +
          `"createdByKeyId" varchar(36), "createdByName" varchar(100), ` +
          `"createdAt" timestamp NOT NULL DEFAULT NOW(), "updatedAt" timestamp NOT NULL DEFAULT NOW())`,
      );
      await queryRunner.query(
        `CREATE TABLE "campaign_recipients" ("id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar, ` +
          `"campaignId" varchar NOT NULL, "chatId" varchar(100) NOT NULL, "chatName" varchar(200), ` +
          `"status" varchar(12) NOT NULL DEFAULT 'pending', "batchId" varchar(255), "messageId" varchar(200), ` +
          `"errorCode" varchar(64), "errorMessage" varchar(500), "sentAt" timestamp, ` +
          `"createdAt" timestamp NOT NULL DEFAULT NOW(), "updatedAt" timestamp NOT NULL DEFAULT NOW(), ` +
          `CONSTRAINT "UQ_campaign_recipients_campaign_chat" UNIQUE ("campaignId", "chatId"), ` +
          `CONSTRAINT "FK_campaign_recipients_campaignId" FOREIGN KEY ("campaignId") REFERENCES "campaigns" ("id") ON DELETE CASCADE)`,
      );
      await queryRunner.query(
        `CREATE TABLE "campaign_segments" ("id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar, ` +
          `"sessionId" varchar(100) NOT NULL, "name" varchar(120) NOT NULL, "chatIds" text NOT NULL, ` +
          `"createdAt" timestamp NOT NULL DEFAULT NOW(), "updatedAt" timestamp NOT NULL DEFAULT NOW())`,
      );
    } else {
      await queryRunner.query(
        `CREATE TABLE "campaigns" ("id" varchar PRIMARY KEY NOT NULL, ` +
          `"sessionId" varchar(100) NOT NULL, "name" varchar(120) NOT NULL, ` +
          `"status" varchar(16) NOT NULL DEFAULT ('draft'), ` +
          `"content" text NOT NULL, "options" text NOT NULL, "audience" text NOT NULL, "progress" text NOT NULL, ` +
          `"scheduledAt" datetime, "startedAt" datetime, "completedAt" datetime, ` +
          `"createdByKeyId" varchar(36), "createdByName" varchar(100), ` +
          `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`,
      );
      await queryRunner.query(
        `CREATE TABLE "campaign_recipients" ("id" varchar PRIMARY KEY NOT NULL, ` +
          `"campaignId" varchar NOT NULL, "chatId" varchar(100) NOT NULL, "chatName" varchar(200), ` +
          `"status" varchar(12) NOT NULL DEFAULT ('pending'), "batchId" varchar(255), "messageId" varchar(200), ` +
          `"errorCode" varchar(64), "errorMessage" varchar(500), "sentAt" datetime, ` +
          `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
          `CONSTRAINT "UQ_campaign_recipients_campaign_chat" UNIQUE ("campaignId", "chatId"), ` +
          `CONSTRAINT "FK_campaign_recipients_campaignId" FOREIGN KEY ("campaignId") REFERENCES "campaigns" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
      );
      await queryRunner.query(
        `CREATE TABLE "campaign_segments" ("id" varchar PRIMARY KEY NOT NULL, ` +
          `"sessionId" varchar(100) NOT NULL, "name" varchar(120) NOT NULL, "chatIds" text NOT NULL, ` +
          `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`,
      );
    }

    await queryRunner.query(`CREATE INDEX "IDX_campaigns_session_created" ON "campaigns" ("sessionId", "createdAt")`);
    await queryRunner.query(`CREATE INDEX "IDX_campaigns_session_status" ON "campaigns" ("sessionId", "status")`);
    await queryRunner.query(
      `CREATE INDEX "IDX_campaign_recipients_campaign_status" ON "campaign_recipients" ("campaignId", "status")`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_campaign_segments_session" ON "campaign_segments" ("sessionId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_campaign_segments_session"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_campaign_recipients_campaign_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_campaigns_session_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_campaigns_session_created"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "campaign_recipients"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "campaigns"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "campaign_segments"`);
  }
}
