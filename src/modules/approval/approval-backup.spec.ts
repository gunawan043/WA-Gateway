import { DataSource } from 'typeorm';
import { EXPORT_TABLES, EXPORT_TABLE_EXCLUSIONS } from '../infra/export-tables';
import { TABLE_IMPORTERS } from '../infra/table-importers';
import type { ApprovalCommandRow, ApprovalRequestRow, WhatsAppIdentityRow } from '../infra/migration-tables.types';
import { ApprovalCommand } from './entities/approval-command.entity';
import { ApprovalRequest } from './entities/approval-request.entity';
import { WhatsAppIdentity } from './entities/whatsapp-identity.entity';

/**
 * Backup round-trip for the approval workflow.
 *
 * The workflow is useless after a restore if the WhatsApp → Core person mapping is gone: every
 * restored request would then resolve to an approver Connect cannot authorize. The export registry
 * and the import descriptors are the only paths that carry these rows, so this spec drives the real
 * descriptors against two real SQLite databases and asserts the relationships survive.
 *
 * The export side is a raw `SELECT *`, which returns JSON columns as TEXT; the importer's own
 * `jsonText`/`nulFree` helpers normalise that. The `insert()` rewrite (Postgres `$N` → SQLite `?`)
 * is reproduced here because the service-level helper is private.
 */

const TABLES = ['whatsapp_identities', 'approval_requests', 'approval_commands'] as const;

const identity: WhatsAppIdentityRow = {
  id: 'a1111111-1111-4111-8111-111111111111',
  externalIdentity: '628111222333',
  corePersonId: 'b1111111-1111-4111-8111-111111111111',
  displayName: 'Kepala Asrama',
  isVerified: true,
  isActive: true,
  verifiedAt: '2026-11-20T02:00:00.000Z',
  lastSeenAt: '2026-11-22T02:00:00.000Z',
  createdAt: '2026-11-20T02:00:00.000Z',
  updatedAt: '2026-11-22T02:00:00.000Z',
};

const request: ApprovalRequestRow = {
  id: 'c1111111-1111-4111-8111-111111111111',
  coreRequestId: 'd1111111-1111-4111-8111-111111111111',
  reference: 'IZN-2026-00125',
  studentName: 'Ahmad',
  studentClass: '10A',
  dormitoryCoreId: 'e1111111-1111-4111-8111-111111111111',
  dormitoryName: 'Asrama Putra',
  permitType: 'pulang',
  requestedDurationDays: 2,
  departureAt: '2026-11-23T00:00:00.000Z',
  expectedReturnAt: '2026-11-25T00:00:00.000Z',
  status: 'APPROVED',
  coreStatus: 'approved',
  targetCorePersonId: identity.corePersonId,
  targetIdentity: identity.externalIdentity,
  sessionId: 'sess-approval',
  notificationMessageId: 'wamid.NOTIFY',
  notificationSentAt: '2026-11-21T02:00:00.000Z',
  clarificationCount: 1,
  decidedAt: '2026-11-22T02:05:00.000Z',
  decisionSource: 'whatsapp',
  lastCommandId: 'cmd-1',
  metadata: JSON.stringify({ channel: 'whatsapp' }),
  createdAt: '2026-11-21T02:00:00.000Z',
  updatedAt: '2026-11-22T02:05:00.000Z',
};

const command: ApprovalCommandRow = {
  id: 'f1111111-1111-4111-8111-111111111111',
  commandId: 'cmd-1',
  approvalRequestId: request.id,
  externalMessageId: 'wamid.REPLY',
  decision: 'approved',
  durationDays: 2,
  status: 'APPLIED',
  attempts: 1,
  coreResponseCode: 200,
  coreResponseBody: JSON.stringify({ success: true, data: { status: 'approved' } }),
  errorCode: null,
  lastError: null,
  lastAttemptAt: '2026-11-22T02:05:00.000Z',
  nextAttemptAt: null,
  sentAt: '2026-11-22T02:05:00.000Z',
  resolvedAt: '2026-11-22T02:05:01.000Z',
  createdAt: '2026-11-22T02:05:00.000Z',
  updatedAt: '2026-11-22T02:05:01.000Z',
};

async function open(): Promise<DataSource> {
  const ds = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    entities: [ApprovalRequest, ApprovalCommand, WhatsAppIdentity],
    synchronize: true,
  });
  await ds.initialize();
  return ds;
}

/** The same rewrite `InfraDataService` applies to a Postgres-made descriptor on SQLite. */
async function importRows(ds: DataSource, key: string, rows: unknown[]): Promise<void> {
  const importer = TABLE_IMPORTERS.find(candidate => candidate.key === key);
  if (!importer) throw new Error(`missing importer for ${key}`);

  for (const row of rows) {
    const params = importer.map(row as never);
    await ds.query(
      importer.sql.replace(/\$\d+/g, '?'),
      params.map(value => (typeof value === 'boolean' ? Number(value) : (value ?? null))),
    );
  }
}

describe('approval workflow backup and restore', () => {
  it('registers all three tables for export instead of excluding them', () => {
    const registered = EXPORT_TABLES.map(entry => entry.table);

    for (const table of TABLES) {
      expect(registered).toContain(table);
      expect(EXPORT_TABLE_EXCLUSIONS[table]).toBeUndefined();
    }
  });

  it('keeps identities, requests and commands in FK-safe import order', () => {
    const keys = TABLE_IMPORTERS.map(importer => importer.key);
    const identityAt = keys.indexOf('whatsappIdentities');
    const requestAt = keys.indexOf('approvalRequests');
    const commandAt = keys.indexOf('approvalCommands');

    expect(identityAt).toBeGreaterThan(-1);
    expect(requestAt).toBeGreaterThan(identityAt);
    expect(commandAt).toBeGreaterThan(requestAt);
  });

  it('round-trips every row and preserves the identity mapping and request/command link', async () => {
    const source = await open();
    const target = await open();

    try {
      // Rows are created by the app with real objects for JSON columns; the export's raw
      // `SELECT *` then hands them back as TEXT, which is what the importer expects.
      await source.getRepository(WhatsAppIdentity).save(identity as never);
      await source
        .getRepository(ApprovalRequest)
        .save({ ...request, metadata: JSON.parse(request.metadata as string) as Record<string, unknown> } as never);
      await source.getRepository(ApprovalCommand).save({
        ...command,
        coreResponseBody: JSON.parse(command.coreResponseBody as string) as Record<string, unknown>,
      } as never);

      // Export: exactly what the service does, a raw SELECT * per table.
      const exported = {
        whatsappIdentities: await source.query<WhatsAppIdentityRow[]>('SELECT * FROM whatsapp_identities'),
        approvalRequests: await source.query<ApprovalRequestRow[]>('SELECT * FROM approval_requests'),
        approvalCommands: await source.query<ApprovalCommandRow[]>('SELECT * FROM approval_commands'),
      };

      await importRows(target, 'whatsappIdentities', exported.whatsappIdentities);
      await importRows(target, 'approvalRequests', exported.approvalRequests);
      await importRows(target, 'approvalCommands', exported.approvalCommands);

      const restoredIdentity = await target.getRepository(WhatsAppIdentity).findOneByOrFail({ id: identity.id });
      expect(restoredIdentity.externalIdentity).toBe(identity.externalIdentity);
      expect(restoredIdentity.corePersonId).toBe(identity.corePersonId);
      expect(restoredIdentity.isVerified).toBe(true);

      const restoredRequest = await target.getRepository(ApprovalRequest).findOneByOrFail({ id: request.id });
      expect(restoredRequest.targetIdentity).toBe(restoredIdentity.externalIdentity);
      expect(restoredRequest.targetCorePersonId).toBe(restoredIdentity.corePersonId);
      expect(restoredRequest.status).toBe('APPROVED');
      expect(restoredRequest.metadata).toEqual({ channel: 'whatsapp' });

      const restoredCommand = await target.getRepository(ApprovalCommand).findOneByOrFail({ id: command.id });
      expect(restoredCommand.approvalRequestId).toBe(restoredRequest.id);
      expect(restoredCommand.decision).toBe('approved');
      expect(restoredCommand.coreResponseBody).toEqual({ success: true, data: { status: 'approved' } });
    } finally {
      await source.destroy();
      await target.destroy();
    }
  });

  it('restores a command whose Core response was never known, keeping its retry schedule', async () => {
    const source = await open();
    const target = await open();
    const unknown: ApprovalCommandRow = {
      ...command,
      id: 'f2222222-2222-4222-8222-222222222222',
      commandId: 'cmd-unknown',
      externalMessageId: 'wamid.UNKNOWN',
      status: 'UNKNOWN',
      attempts: 3,
      coreResponseCode: 504,
      coreResponseBody: null,
      errorCode: 'core_timeout',
      lastError: 'Core tidak merespons tepat waktu.',
      nextAttemptAt: '2026-11-22T02:10:00.000Z',
      resolvedAt: null,
    };

    try {
      await source.getRepository(ApprovalCommand).save(unknown as never);
      const rows = await source.query<ApprovalCommandRow[]>('SELECT * FROM approval_commands');
      await importRows(target, 'approvalCommands', rows);

      const restored = await target.getRepository(ApprovalCommand).findOneByOrFail({ id: unknown.id });
      expect(restored.status).toBe('UNKNOWN');
      expect(restored.attempts).toBe(3);
      expect(restored.nextAttemptAt?.toISOString()).toBe('2026-11-22T02:10:00.000Z');
      expect(restored.coreResponseBody).toBeNull();
    } finally {
      await source.destroy();
      await target.destroy();
    }
  });
});
