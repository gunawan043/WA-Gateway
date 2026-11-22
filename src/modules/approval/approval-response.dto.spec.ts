import { randomUUID } from 'crypto';
import { ApprovalRequest } from './entities/approval-request.entity';
import { ApprovalRequestView, toApprovalRequestView } from './dto/approval-response.dto';

/**
 * `VIEWER` adalah role terendah, dan sebelumnya ia menerima entitas database utuh. Tes ini
 * mengunci daftar field yang boleh keluar: bukan hanya "field sensitif hilang", tetapi seluruh
 * himpunan kunci, sehingga field baru pada entitas tidak otomatis bocor ke API.
 */
describe('ApprovalRequestView', () => {
  const entity = (): ApprovalRequest => ({
    id: randomUUID(),
    coreRequestId: randomUUID(),
    reference: 'IZN-2026-00125',
    studentName: 'Ahmad Fauzi',
    studentClass: '7A',
    dormitoryCoreId: randomUUID(),
    dormitoryName: 'Asrama Putra 1',
    permitType: 'pulang',
    requestedDurationDays: 3,
    departureAt: new Date('2026-12-01T08:00:00.000Z'),
    expectedReturnAt: new Date('2026-12-04T08:00:00.000Z'),
    status: 'PENDING_APPROVAL',
    coreStatus: 'pending',
    targetCorePersonId: randomUUID(),
    targetIdentity: '628111222333',
    sessionId: 'sess-approval',
    notificationMessageId: 'wamid.notif',
    notificationSentAt: new Date('2026-11-22T02:00:00.000Z'),
    clarificationCount: 0,
    decidedAt: null,
    decisionSource: null,
    lastCommandId: 'cmd-1',
    metadata: { internal: true },
    createdAt: new Date('2026-11-22T02:00:00.000Z'),
    updatedAt: new Date('2026-11-22T02:00:00.000Z'),
  });

  const ALLOWED = [
    'id',
    'coreRequestId',
    'reference',
    'studentName',
    'studentClass',
    'dormitoryCoreId',
    'dormitoryName',
    'permitType',
    'requestedDurationDays',
    'departureAt',
    'expectedReturnAt',
    'status',
    'coreStatus',
    'clarificationCount',
    'decidedAt',
    'decisionSource',
    'notificationSentAt',
    'createdAt',
    'updatedAt',
  ].sort();

  it('hanya memuat field yang diizinkan', () => {
    const view = toApprovalRequestView(entity());

    expect(Object.keys(view).sort()).toEqual(ALLOWED);
  });

  it('tidak membocorkan nomor WhatsApp, sesi, identitas Core, atau jejak command', () => {
    const json = JSON.parse(JSON.stringify(toApprovalRequestView(entity()))) as Record<string, unknown>;

    for (const forbidden of [
      'targetIdentity',
      'targetCorePersonId',
      'sessionId',
      'notificationMessageId',
      'lastCommandId',
      'metadata',
    ]) {
      expect(json).not.toHaveProperty(forbidden);
    }

    expect(JSON.stringify(json)).not.toContain('628111222333');
    expect(JSON.stringify(json)).not.toContain('sess-approval');
  });

  it('mempertahankan data operasional yang dibutuhkan', () => {
    const source = entity();
    const view: ApprovalRequestView = toApprovalRequestView(source);

    expect(view.id).toBe(source.id);
    expect(view.reference).toBe(source.reference);
    expect(view.studentName).toBe(source.studentName);
    expect(view.dormitoryName).toBe(source.dormitoryName);
    expect(view.status).toBe(source.status);
    expect(view.decidedAt).toBeNull();
  });
});
