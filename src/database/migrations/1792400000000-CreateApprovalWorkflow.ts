import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Skema alur persetujuan izin lewat WhatsApp.
 *
 * Tiga tabel, semuanya aditif:
 *  - `whatsapp_identities`  pemetaan nomor → personel Core yang terverifikasi
 *  - `approval_requests`    cermin permohonan izin + status internal Connect
 *  - `approval_commands`    buku besar command ke Core (idempotensi & retry)
 *
 * Tidak ada foreign key ke tabel lain: permohonan Core hidup di database lain,
 * dan menghapus permohonan lokal tidak boleh memutus riwayat command.
 */
export class CreateApprovalWorkflow1792400000000 implements MigrationInterface {
  name = 'CreateApprovalWorkflow1792400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.dataSource.options.type === 'postgres';
    const stamp = isPostgres ? 'timestamp' : 'datetime';
    const stampDefault = isPostgres ? 'NOW()' : "datetime('now')";
    const boolTrue = isPostgres ? 'true' : '1';
    const boolFalse = isPostgres ? 'false' : '0';
    // TypeORM emits `INSERT ... VALUES (DEFAULT, ...)` for `@PrimaryGeneratedColumn('uuid')` on
    // Postgres, so the column needs a server-side default or the insert fails with 23502. SQLite
    // mints the uuid in the driver, so it stays plain there (same split as CreateCrmTables).
    const idDefault = isPostgres ? ' DEFAULT gen_random_uuid()::varchar' : '';

    if (!(await queryRunner.hasTable('whatsapp_identities'))) {
      await queryRunner.query(
        `CREATE TABLE "whatsapp_identities" (` +
          `"id" varchar PRIMARY KEY NOT NULL${idDefault}, ` +
          `"externalIdentity" varchar(191) NOT NULL, ` +
          `"corePersonId" varchar(36) NOT NULL, ` +
          `"displayName" varchar(191), ` +
          `"isVerified" boolean NOT NULL DEFAULT ${boolFalse}, ` +
          `"isActive" boolean NOT NULL DEFAULT ${boolTrue}, ` +
          `"verifiedAt" ${stamp}, ` +
          `"lastSeenAt" ${stamp}, ` +
          `"createdAt" ${stamp} NOT NULL DEFAULT (${stampDefault}), ` +
          `"updatedAt" ${stamp} NOT NULL DEFAULT (${stampDefault}))`,
      );
      await queryRunner.query(
        `CREATE UNIQUE INDEX "UQ_whatsapp_identities_external" ON "whatsapp_identities" ("externalIdentity")`,
      );
      await queryRunner.query(
        `CREATE INDEX "IDX_whatsapp_identities_core_person" ON "whatsapp_identities" ("corePersonId")`,
      );
    }

    if (!(await queryRunner.hasTable('approval_requests'))) {
      await queryRunner.query(
        `CREATE TABLE "approval_requests" (` +
          `"id" varchar PRIMARY KEY NOT NULL${idDefault}, ` +
          `"coreRequestId" varchar(36) NOT NULL, ` +
          `"reference" varchar(64) NOT NULL, ` +
          `"studentName" varchar(191) NOT NULL, ` +
          `"studentClass" varchar(100), ` +
          `"dormitoryCoreId" varchar(36), ` +
          `"dormitoryName" varchar(191), ` +
          `"permitType" varchar(64) NOT NULL, ` +
          `"requestedDurationDays" integer, ` +
          `"departureAt" ${stamp}, ` +
          `"expectedReturnAt" ${stamp}, ` +
          `"status" varchar(32) NOT NULL DEFAULT 'PENDING_APPROVAL', ` +
          `"coreStatus" varchar(32), ` +
          `"targetCorePersonId" varchar(36), ` +
          `"targetIdentity" varchar(191), ` +
          `"sessionId" varchar(100), ` +
          `"notificationMessageId" varchar(191), ` +
          `"notificationSentAt" ${stamp}, ` +
          `"clarificationCount" integer NOT NULL DEFAULT 0, ` +
          `"decidedAt" ${stamp}, ` +
          `"decisionSource" varchar(20), ` +
          `"lastCommandId" varchar(100), ` +
          `"metadata" text, ` +
          `"createdAt" ${stamp} NOT NULL DEFAULT (${stampDefault}), ` +
          `"updatedAt" ${stamp} NOT NULL DEFAULT (${stampDefault}))`,
      );
      await queryRunner.query(
        `CREATE UNIQUE INDEX "UQ_approval_requests_core_request" ON "approval_requests" ("coreRequestId")`,
      );
      await queryRunner.query(
        `CREATE UNIQUE INDEX "UQ_approval_requests_reference" ON "approval_requests" ("reference")`,
      );
      await queryRunner.query(`CREATE INDEX "IDX_approval_requests_status" ON "approval_requests" ("status")`);
      await queryRunner.query(
        `CREATE INDEX "IDX_approval_requests_target_status" ON "approval_requests" ("targetCorePersonId", "status")`,
      );
    }

    if (!(await queryRunner.hasTable('approval_commands'))) {
      await queryRunner.query(
        `CREATE TABLE "approval_commands" (` +
          `"id" varchar PRIMARY KEY NOT NULL${idDefault}, ` +
          `"commandId" varchar(100) NOT NULL, ` +
          `"approvalRequestId" varchar(36) NOT NULL, ` +
          `"externalMessageId" varchar(191) NOT NULL, ` +
          `"decision" varchar(16) NOT NULL, ` +
          `"durationDays" integer, ` +
          `"status" varchar(16) NOT NULL DEFAULT 'PENDING', ` +
          `"attempts" integer NOT NULL DEFAULT 0, ` +
          `"coreResponseCode" integer, ` +
          `"coreResponseBody" text, ` +
          `"errorCode" varchar(64), ` +
          `"sentAt" ${stamp}, ` +
          `"resolvedAt" ${stamp}, ` +
          `"createdAt" ${stamp} NOT NULL DEFAULT (${stampDefault}), ` +
          `"updatedAt" ${stamp} NOT NULL DEFAULT (${stampDefault}))`,
      );
      await queryRunner.query(
        `CREATE UNIQUE INDEX "UQ_approval_commands_command" ON "approval_commands" ("commandId")`,
      );
      await queryRunner.query(
        `CREATE UNIQUE INDEX "UQ_approval_commands_external_message" ON "approval_commands" ("externalMessageId")`,
      );
      await queryRunner.query(
        `CREATE INDEX "IDX_approval_commands_request" ON "approval_commands" ("approvalRequestId", "createdAt")`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_approval_commands_request"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_approval_commands_external_message"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_approval_commands_command"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "approval_commands"`);

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_approval_requests_target_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_approval_requests_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_approval_requests_reference"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_approval_requests_core_request"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "approval_requests"`);

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_whatsapp_identities_core_person"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_whatsapp_identities_external"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "whatsapp_identities"`);
  }
}
