import { randomUUID } from 'crypto';
import { ConflictException } from '@nestjs/common';
import { ApprovalController } from './approval.controller';
import { ApprovalService } from './approval.service';
import { WhatsAppIdentityService } from './whatsapp-identity.service';
import type { AuditService } from '../audit/audit.service';
import { AuditAction, AuditSeverity } from '../audit/entities/audit-log.entity';
import type { ApiKey } from '../auth/entities/api-key.entity';
import type { ApprovalRequest } from './entities/approval-request.entity';
import type { WhatsAppIdentity } from './entities/whatsapp-identity.entity';

/**
 * Controller adalah lapisan delegasi tipis, tetapi empat hal di sini bersifat perilaku:
 * ingest meneruskan cakupan sesi key, respons dibentuk oleh DTO (bukan entitas mentah),
 * upsert identitas tidak pernah memberi `isVerified` default, dan setiap perubahan pemetaan
 * tercatat pada audit bersama aktor yang mengautentikasi.
 */
describe('ApprovalController', () => {
  const approvals = {
    ingest: jest.fn(),
    list: jest.fn(),
    get: jest.fn(),
    notify: jest.fn(),
  };
  const identities = { upsert: jest.fn() };
  const audit = { logInfo: jest.fn(), logWarn: jest.fn() };
  let controller: ApprovalController;

  const apiKey = { id: 'key-1', name: 'core-ingest' } as ApiKey;

  const identity = (overrides: Partial<WhatsAppIdentity> = {}): WhatsAppIdentity => ({
    id: 'ident-1',
    externalIdentity: '628111222333',
    corePersonId: 'person-1',
    displayName: null,
    isVerified: true,
    isActive: true,
    verifiedAt: new Date('2026-11-22T02:00:00.000Z'),
    lastSeenAt: null,
    createdAt: new Date('2026-11-22T02:00:00.000Z'),
    updatedAt: new Date('2026-11-22T02:00:00.000Z'),
    ...overrides,
  });

  const request = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
    id: 'req-1',
    coreRequestId: randomUUID(),
    reference: 'IZN-2026-00125',
    studentName: 'Ahmad',
    studentClass: '7A',
    dormitoryCoreId: randomUUID(),
    dormitoryName: 'Asrama Putra 1',
    permitType: 'pulang',
    requestedDurationDays: 3,
    departureAt: null,
    expectedReturnAt: null,
    status: 'PENDING_APPROVAL',
    coreStatus: 'pending',
    targetCorePersonId: 'person-1',
    targetIdentity: '628111222333',
    sessionId: 'sess-approval',
    notificationMessageId: 'wamid.notif',
    notificationSentAt: null,
    clarificationCount: 0,
    decidedAt: null,
    decisionSource: null,
    lastCommandId: 'cmd-1',
    metadata: { internal: true },
    createdAt: new Date('2026-11-22T02:00:00.000Z'),
    updatedAt: new Date('2026-11-22T02:00:00.000Z'),
    ...overrides,
  });

  beforeEach(() => {
    jest.resetAllMocks();
    audit.logInfo.mockResolvedValue(null);
    audit.logWarn.mockResolvedValue(null);
    controller = new ApprovalController(
      approvals as unknown as ApprovalService,
      identities as unknown as WhatsAppIdentityService,
      audit as unknown as AuditService,
    );
  });

  it('meneruskan allowedSessions milik key ke ingest', async () => {
    const dto = {
      coreRequestId: randomUUID(),
      reference: 'IZN-2026-00125',
      studentName: 'Ahmad',
      permitType: 'pulang',
      sessionId: 'sess-approval',
    };
    approvals.ingest.mockResolvedValue(request());

    await controller.ingest(dto, { allowedSessions: ['sess-approval'] } as ApiKey);

    expect(approvals.ingest).toHaveBeenCalledWith(dto, ['sess-approval']);
  });

  it('meneruskan null saat tidak ada key (jalur internal)', async () => {
    const dto = {
      coreRequestId: randomUUID(),
      reference: 'IZN-2026-00125',
      studentName: 'Ahmad',
      permitType: 'pulang',
    };
    approvals.ingest.mockResolvedValue(request());

    await controller.ingest(dto);

    expect(approvals.ingest).toHaveBeenCalledWith(dto, null);
  });

  it('mendelegasikan list dan get, lalu membentuk respons DTO', async () => {
    approvals.list.mockResolvedValue([request()]);
    approvals.get.mockResolvedValue(request());

    const list = await controller.list({ status: 'PENDING_APPROVAL', limit: 10 });
    const one = await controller.get('req-1');

    expect(approvals.list).toHaveBeenCalledWith({ status: 'PENDING_APPROVAL', limit: 10 });
    expect(approvals.get).toHaveBeenCalledWith('req-1');
    expect(list).toHaveLength(1);
    expect(one.id).toBe('req-1');
  });

  it('mendelegasikan notify dan mengembalikan DTO', async () => {
    approvals.notify.mockResolvedValue(request());

    const view = await controller.notify('req-1');

    expect(approvals.notify).toHaveBeenCalledWith('req-1');
    expect(view.id).toBe('req-1');
  });

  it('tidak memberi isVerified default true saat memetakan identitas', async () => {
    const dto = { externalIdentity: '628111222333', corePersonId: randomUUID() };
    identities.upsert.mockResolvedValue({ identity: identity(), change: 'create', before: null });

    await controller.upsertIdentity(dto);

    expect(identities.upsert).toHaveBeenCalledWith({
      externalIdentity: '628111222333',
      corePersonId: dto.corePersonId,
      displayName: null,
      isVerified: undefined,
      isActive: undefined,
      reassign: false,
    });
  });

  it('menghormati isVerified=false dan isVerified=true yang eksplisit', async () => {
    const corePersonId = randomUUID();
    identities.upsert.mockResolvedValue({ identity: identity(), change: 'update', before: null });

    await controller.upsertIdentity({ externalIdentity: '628111222333', corePersonId, isVerified: false });
    expect(identities.upsert).toHaveBeenLastCalledWith(expect.objectContaining({ isVerified: false }));

    await controller.upsertIdentity({ externalIdentity: '628111222333', corePersonId, isVerified: true });
    expect(identities.upsert).toHaveBeenLastCalledWith(expect.objectContaining({ isVerified: true }));
  });

  it('meneruskan isActive=false dan reassign agar pemetaan dapat dicabut atau dipindahkan secara sadar', async () => {
    identities.upsert.mockResolvedValue({ identity: identity(), change: 'reassign', before: null });

    await controller.upsertIdentity({
      externalIdentity: '628111222333',
      corePersonId: randomUUID(),
      isActive: false,
      reassign: true,
    });

    expect(identities.upsert).toHaveBeenCalledWith(expect.objectContaining({ isActive: false, reassign: true }));
  });

  it('mencatat audit dengan aktor, jenis perubahan, dan nilai sebelum/sesudah', async () => {
    const before = {
      externalIdentity: '628111222333',
      corePersonId: 'person-lama',
      displayName: null,
      isVerified: false,
      isActive: true,
    };
    const after = identity({ corePersonId: 'person-baru' });
    identities.upsert.mockResolvedValue({ identity: after, change: 'reassign', before });

    await controller.upsertIdentity(
      { externalIdentity: '628111222333', corePersonId: 'person-baru', reassign: true },
      apiKey,
    );

    expect(audit.logInfo).toHaveBeenCalledWith(AuditAction.APPROVAL_IDENTITY_CHANGED, {
      apiKey,
      metadata: {
        result: 'applied',
        change: 'reassign',
        externalIdentity: '628111222333',
        before,
        after: {
          externalIdentity: '628111222333',
          corePersonId: 'person-baru',
          displayName: null,
          isVerified: true,
          isActive: true,
        },
      },
    });
  });

  it('mencatat penolakan pemindahan tanpa penanda sebagai audit WARN lalu meneruskan error', async () => {
    const conflict = new ConflictException({
      code: 'identity_reassign_requires_flag',
      message: 'butuh penanda',
      currentCorePersonId: 'person-lama',
    });
    identities.upsert.mockRejectedValue(conflict);

    await expect(
      controller.upsertIdentity({ externalIdentity: '628111222333', corePersonId: 'person-baru' }, apiKey),
    ).rejects.toBe(conflict);

    expect(audit.logWarn).toHaveBeenCalledWith(AuditAction.APPROVAL_IDENTITY_CHANGED, {
      apiKey,
      metadata: {
        result: 'rejected',
        change: 'reassign',
        code: 'identity_reassign_requires_flag',
        externalIdentity: '628111222333',
        requestedCorePersonId: 'person-baru',
        currentCorePersonId: 'person-lama',
      },
    });
    expect(AuditSeverity.WARN).toBe('warn');
  });

  it('tidak mengaudit kegagalan validasi biasa sebagai percobaan pemindahan', async () => {
    identities.upsert.mockRejectedValue(new Error('Nomor WhatsApp tidak valid.'));

    await expect(
      controller.upsertIdentity({ externalIdentity: 'bukan-nomor', corePersonId: randomUUID() }),
    ).rejects.toThrow('Nomor WhatsApp tidak valid.');

    expect(audit.logWarn).not.toHaveBeenCalled();
    expect(audit.logInfo).not.toHaveBeenCalled();
  });
});
