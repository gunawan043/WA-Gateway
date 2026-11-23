import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the sales-pipeline tables and seeds the six default stages.
 *
 * Stage ids are FIXED literals rather than generated: the stages are configuration, seeded on every
 * fresh database, and a deal stores only its `stageId`. Because those ids are identical on every
 * deployment, `crm_stages` is deliberately excluded from the backup payload (see
 * EXPORT_TABLE_EXCLUSIONS) — restoring deals onto another instance always finds the stage rows they
 * reference.
 *
 * `crm_deals.stageId` is RESTRICT, so a stage cannot be deleted while deals sit in it. Neither
 * `sessionId` nor `chatId` on a deal is a foreign key: they record where the deal came from, and a
 * session deletion must not destroy pipeline history.
 */
export class CreateCrmTables1792000000000 implements MigrationInterface {
  name = 'CreateCrmTables1792000000000';

  private static readonly STAGES: ReadonlyArray<{ id: string; name: string; kind: string; position: number }> = [
    { id: 'c4a1e0b0-0000-4000-8000-000000000001', name: 'New', kind: 'open', position: 0 },
    { id: 'c4a1e0b0-0000-4000-8000-000000000002', name: 'Contacted', kind: 'open', position: 1 },
    { id: 'c4a1e0b0-0000-4000-8000-000000000003', name: 'Qualified', kind: 'open', position: 2 },
    { id: 'c4a1e0b0-0000-4000-8000-000000000004', name: 'Proposal', kind: 'open', position: 3 },
    { id: 'c4a1e0b0-0000-4000-8000-000000000005', name: 'Won', kind: 'won', position: 4 },
    { id: 'c4a1e0b0-0000-4000-8000-000000000006', name: 'Lost', kind: 'lost', position: 5 },
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('crm_stages')) return;
    const isPostgres = queryRunner.dataSource.options.type === 'postgres';

    if (isPostgres) {
      await queryRunner.query(
        `CREATE TABLE "crm_stages" ("id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar, ` +
          `"name" varchar(60) NOT NULL, "kind" varchar(8) NOT NULL DEFAULT 'open', ` +
          `"position" int NOT NULL DEFAULT 0, "color" varchar(20), ` +
          `"createdAt" timestamp NOT NULL DEFAULT NOW(), "updatedAt" timestamp NOT NULL DEFAULT NOW())`,
      );
      await queryRunner.query(
        `CREATE TABLE "crm_deals" ("id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar, ` +
          `"stageId" varchar NOT NULL, "title" varchar(200) NOT NULL, ` +
          `"sessionId" varchar(100), "chatId" varchar(100), "value" int, ` +
          `"currency" varchar(3) NOT NULL DEFAULT 'IDR', "status" varchar(12) NOT NULL DEFAULT 'open', ` +
          `"assigneeKeyId" varchar(36), "assigneeName" varchar(100), ` +
          `"expectedCloseAt" timestamp, "closedAt" timestamp, "notes" text, ` +
          `"createdAt" timestamp NOT NULL DEFAULT NOW(), "updatedAt" timestamp NOT NULL DEFAULT NOW(), ` +
          `CONSTRAINT "FK_crm_deals_stageId" FOREIGN KEY ("stageId") REFERENCES "crm_stages" ("id") ON DELETE RESTRICT)`,
      );
      await queryRunner.query(
        `CREATE TABLE "crm_deal_activities" ("id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar, ` +
          `"dealId" varchar NOT NULL, "kind" varchar(20) NOT NULL, "body" text, ` +
          `"fromStageId" varchar(36), "toStageId" varchar(36), ` +
          `"authorKeyId" varchar(36) NOT NULL, "authorName" varchar(100) NOT NULL, ` +
          `"createdAt" timestamp NOT NULL DEFAULT NOW(), ` +
          `CONSTRAINT "FK_crm_deal_activities_dealId" FOREIGN KEY ("dealId") REFERENCES "crm_deals" ("id") ON DELETE CASCADE)`,
      );
    } else {
      await queryRunner.query(
        `CREATE TABLE "crm_stages" ("id" varchar PRIMARY KEY NOT NULL, ` +
          `"name" varchar(60) NOT NULL, "kind" varchar(8) NOT NULL DEFAULT ('open'), ` +
          `"position" int NOT NULL DEFAULT (0), "color" varchar(20), ` +
          `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`,
      );
      await queryRunner.query(
        `CREATE TABLE "crm_deals" ("id" varchar PRIMARY KEY NOT NULL, ` +
          `"stageId" varchar NOT NULL, "title" varchar(200) NOT NULL, ` +
          `"sessionId" varchar(100), "chatId" varchar(100), "value" int, ` +
          `"currency" varchar(3) NOT NULL DEFAULT ('IDR'), "status" varchar(12) NOT NULL DEFAULT ('open'), ` +
          `"assigneeKeyId" varchar(36), "assigneeName" varchar(100), ` +
          `"expectedCloseAt" datetime, "closedAt" datetime, "notes" text, ` +
          `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
          `CONSTRAINT "FK_crm_deals_stageId" FOREIGN KEY ("stageId") REFERENCES "crm_stages" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION)`,
      );
      await queryRunner.query(
        `CREATE TABLE "crm_deal_activities" ("id" varchar PRIMARY KEY NOT NULL, ` +
          `"dealId" varchar NOT NULL, "kind" varchar(20) NOT NULL, "body" text, ` +
          `"fromStageId" varchar(36), "toStageId" varchar(36), ` +
          `"authorKeyId" varchar(36) NOT NULL, "authorName" varchar(100) NOT NULL, ` +
          `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
          `CONSTRAINT "FK_crm_deal_activities_dealId" FOREIGN KEY ("dealId") REFERENCES "crm_deals" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
      );
    }

    await queryRunner.query(`CREATE INDEX "IDX_crm_stages_position" ON "crm_stages" ("position")`);
    await queryRunner.query(`CREATE INDEX "IDX_crm_deals_stage_status" ON "crm_deals" ("stageId", "status")`);
    await queryRunner.query(`CREATE INDEX "IDX_crm_deals_chat" ON "crm_deals" ("sessionId", "chatId")`);
    await queryRunner.query(`CREATE INDEX "IDX_crm_deal_activities_deal" ON "crm_deal_activities" ("dealId")`);

    for (const stage of CreateCrmTables1792000000000.STAGES) {
      const now = isPostgres ? 'NOW()' : "datetime('now')";
      await queryRunner.query(
        `INSERT INTO "crm_stages" ("id", "name", "kind", "position", "color", "createdAt", "updatedAt") ` +
          `VALUES ('${stage.id}', '${stage.name}', '${stage.kind}', ${stage.position}, NULL, ${now}, ${now})`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_crm_deal_activities_deal"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_crm_deals_chat"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_crm_deals_stage_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_crm_stages_position"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "crm_deal_activities"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "crm_deals"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "crm_stages"`);
  }
}
