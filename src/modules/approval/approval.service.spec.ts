import { randomUUID } from 'crypto';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { ApprovalService } from './approval.service';
import { ApprovalRequest } from './entities/approval-request.entity';
import { ApprovalCommand } from './entities/approval-command.entity';
import { WhatsAppIdentity } from './entities/whatsapp-identity.entity';
import { ApprovalNotificationService } from './approval-notification.service';
import { WhatsAppIdentityService } from './whatsapp-identity.service';
import type { IngestApprovalRequestDto } from './dto/approval.dto';

/**
 * ApprovalService hanya menerima data izin dari Core dan menyajikan status internal.
 * Yang dijaga di sini: idempotensi berdasarkan `coreRequestId`, keputusan final tidak
 * ditimpa oleh sinkronisasi berikutnya, subjek otorisasi tidak berubah setelah permohonan
 * berjalan, kegagalan notifikasi tidak membatalkan simpan, dan key ber-scope sesi tidak
 * boleh menyebut sesi lain.
 */
describe('ApprovalService', () => {
  let ds: DataSource;
  let requests: Repository<ApprovalRequest>;
  let notification: { notify: jest.Mock };
  let service: ApprovalService;

  const baseDto = (overrides: Partial<IngestApprovalRequestDto> = {}): IngestApprovalRequestDto => ({
    coreRequestId: randomUUID(),
    reference: `IZN-2026-${Math.floor(Math.random() * 90_000) + 10_000}`,
    studentName: 'Ahmad Fauzi',
    studentClass: '7A',
    dormitoryCoreId: randomUUID(),
    dormitoryName: 'Asrama Putra 1',
    permitType: 'pulang',
    requestedDurationDays: 3,
    departureAt: '2026-12-01T08:00:00.000Z',
    expectedReturnAt: '2026-12-04T08:00:00.000Z',
    targetCorePersonId: randomUUID(),
    targetIdentity: '628111222333',
    sessionId: 'sess-approval',
    coreStatus: 'pending',
    ...overrides,
  });

  beforeAll(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [ApprovalRequest, WhatsAppIdentity, ApprovalCommand],
      synchronize: true,
    });
    await ds.initialize();
  });

  afterAll(async () => {
    await ds.destroy();
  });

  beforeEach(async () => {
    await ds.getRepository(ApprovalRequest).clear();
    await ds.getRepository(ApprovalCommand).clear();
    requests = ds.getRepository(ApprovalRequest);
    notification = { notify: jest.fn() };
    service = new ApprovalService(
      requests,
      ds.getRepository(ApprovalCommand),
      notification as unknown as ApprovalNotificationService,
      new WhatsAppIdentityService(ds.getRepository(WhatsAppIdentity)),
    );
  });

  it('menyimpan permohonan baru dan mengirim notifikasi', async () => {
    const dto = baseDto();

    const saved = await service.ingest(dto);

    expect(saved.id).toBeTruthy();
    expect(saved.status).toBe('PENDING_APPROVAL');
    expect(saved.coreStatus).toBe('pending');
    expect(saved.targetIdentity).toBe('628111222333');
    expect(notification.notify).toHaveBeenCalledTimes(1);
  });

  it('tidak mengirim notifikasi bila notify=false', async () => {
    await service.ingest(baseDto({ notify: false }));

    expect(notification.notify).not.toHaveBeenCalled();
  });

  it('memperbarui permohonan yang sama tanpa membuat baris kedua', async () => {
    const coreRequestId = randomUUID();
    const targetCorePersonId = randomUUID();
    const first = await service.ingest(baseDto({ coreRequestId, targetCorePersonId, notify: false }));

    const second = await service.ingest(
      baseDto({
        coreRequestId,
        targetCorePersonId,
        studentName: 'Ahmad Fauzi (baru)',
        coreStatus: 'pending',
        notify: false,
      }),
    );

    expect(second.id).toBe(first.id);
    expect(second.studentName).toBe('Ahmad Fauzi (baru)');
    expect(await requests.count()).toBe(1);
  });

  it('tidak menimpa keputusan final dengan sinkronisasi berikutnya', async () => {
    const coreRequestId = randomUUID();
    const targetCorePersonId = randomUUID();
    const first = await service.ingest(baseDto({ coreRequestId, targetCorePersonId, notify: false }));
    first.status = 'APPROVED';
    first.decidedAt = new Date();
    await requests.save(first);

    const second = await service.ingest(
      baseDto({ coreRequestId, targetCorePersonId, coreStatus: 'pending', notify: false }),
    );

    expect(second.status).toBe('APPROVED');
    expect(second.decidedAt).not.toBeNull();
  });

  it('tetap menyimpan permohonan ketika notifikasi gagal', async () => {
    notification.notify.mockRejectedValue(new Error('WhatsApp down'));

    const saved = await service.ingest(baseDto());

    expect(saved.id).toBeTruthy();
    expect(await requests.count()).toBe(1);
  });

  it('menolak sesi di luar cakupan key', async () => {
    await expect(service.ingest(baseDto({ sessionId: 'sess-lain' }), ['sess-approval'])).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('mengizinkan sesi yang ada di cakupan key', async () => {
    const saved = await service.ingest(baseDto({ sessionId: 'sess-approval' }), ['sess-approval']);

    expect(saved.sessionId).toBe('sess-approval');
  });

  it('membatasi daftar pada status dan batas baris', async () => {
    await service.ingest(baseDto({ notify: false }));
    const approved = await service.ingest(baseDto({ notify: false }));
    approved.status = 'APPROVED';
    await requests.save(approved);

    const pending = await service.list({ status: 'PENDING_APPROVAL' });
    expect(pending).toHaveLength(1);

    const capped = await service.list({ limit: 1 });
    expect(capped).toHaveLength(1);
  });

  it('melempar 404 untuk permohonan yang tidak ada', async () => {
    await expect(service.get(randomUUID())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('mengirim ulang notifikasi lewat notify()', async () => {
    const saved = await service.ingest(baseDto({ notify: false }));
    notification.notify.mockClear();

    await service.notify(saved.id);

    expect(notification.notify).toHaveBeenCalledTimes(1);
  });

  describe('subjek otorisasi bersifat tetap', () => {
    const seeded = async (status: ApprovalRequest['status'] = 'PENDING_APPROVAL') => {
      const coreRequestId = randomUUID();
      const targetCorePersonId = randomUUID();
      const request = await service.ingest(
        baseDto({ coreRequestId, targetCorePersonId, targetIdentity: '628111222333', notify: false }),
      );

      if (status !== 'PENDING_APPROVAL') {
        request.status = status;
        await requests.save(request);
      }

      return { coreRequestId, targetCorePersonId };
    };

    it('menolak pemindahan target ke personel Core lain saat permohonan masih PENDING', async () => {
      const { coreRequestId, targetCorePersonId } = await seeded();

      await expect(
        service.ingest(baseDto({ coreRequestId, targetCorePersonId: randomUUID(), notify: false })),
      ).rejects.toBeInstanceOf(ConflictException);

      const stored = await requests.findOneByOrFail({ coreRequestId });
      expect(stored.targetCorePersonId).toBe(targetCorePersonId);
    });

    it('menolak penggantian nomor tujuan saat permohonan masih PENDING', async () => {
      const { coreRequestId, targetCorePersonId } = await seeded();

      await expect(
        service.ingest(baseDto({ coreRequestId, targetCorePersonId, targetIdentity: '628999000111', notify: false })),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('menolak penggantian sesi pengiriman saat permohonan masih PENDING', async () => {
      const { coreRequestId, targetCorePersonId } = await seeded();

      await expect(
        service.ingest(baseDto({ coreRequestId, targetCorePersonId, sessionId: 'sess-lain', notify: false })),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('mengizinkan penetapan target pertama selama permohonan belum berjalan', async () => {
      const coreRequestId = randomUUID();
      const targetCorePersonId = randomUUID();
      await service.ingest(
        baseDto({
          coreRequestId,
          targetCorePersonId: undefined,
          targetIdentity: undefined,
          sessionId: undefined,
          notify: false,
        }),
      );

      const bound = await service.ingest(
        baseDto({ coreRequestId, targetCorePersonId, targetIdentity: '628111222333', notify: false }),
      );

      expect(bound.targetCorePersonId).toBe(targetCorePersonId);
      expect(bound.targetIdentity).toBe('628111222333');
    });

    it('menolak perubahan target saat permohonan sedang diproses', async () => {
      const { coreRequestId } = await seeded('PROCESSING');

      await expect(
        service.ingest(baseDto({ coreRequestId, targetCorePersonId: randomUUID(), notify: false })),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('menolak perubahan target pada permohonan final', async () => {
      const { coreRequestId } = await seeded('APPROVED');

      await expect(
        service.ingest(baseDto({ coreRequestId, targetCorePersonId: randomUUID(), notify: false })),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('menerima ingest ulang idempoten tanpa mengubah target', async () => {
      const { coreRequestId, targetCorePersonId } = await seeded();

      const again = await service.ingest(baseDto({ coreRequestId, targetCorePersonId, notify: false }));

      expect(again.targetCorePersonId).toBe(targetCorePersonId);
      expect(again.targetIdentity).toBe('628111222333');
      expect(await requests.count()).toBe(1);
    });

    it('menormalkan nomor tujuan saat permohonan dibuat', async () => {
      const saved = await service.ingest(baseDto({ targetIdentity: '+62 811-1222-333', notify: false }));

      expect(saved.targetIdentity).toBe('628111222333');
    });

    it('menolak nomor tujuan yang tidak dapat dinormalkan, bukan mengabaikannya', async () => {
      const coreRequestId = randomUUID();

      await expect(
        service.ingest(baseDto({ coreRequestId, targetIdentity: 'bukan-nomor', notify: false })),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(await requests.findOneBy({ coreRequestId })).toBeNull();
    });
  });

  describe('riwayat command satu permohonan', () => {
    const seedCommand = async (overrides: Partial<ApprovalCommand> = {}): Promise<ApprovalCommand> =>
      ds.getRepository(ApprovalCommand).save(
        ds.getRepository(ApprovalCommand).create({
          commandId: randomUUID(),
          approvalRequestId: randomUUID(),
          externalMessageId: randomUUID(),
          decision: 'approved',
          durationDays: 2,
          status: 'FAILED',
          attempts: 5,
          ...overrides,
        }),
      );

    it('mengembalikan command permohonan itu saja, terbaru lebih dulu', async () => {
      const requestId = randomUUID();
      const older = await seedCommand({ approvalRequestId: requestId, createdAt: new Date('2026-01-01T00:00:00Z') });
      const newer = await seedCommand({ approvalRequestId: requestId, createdAt: new Date('2026-02-01T00:00:00Z') });
      await seedCommand({ createdAt: new Date('2026-03-01T00:00:00Z') });

      const rows = await service.listCommands(requestId);

      expect(rows.map(row => row.id)).toEqual([newer.id, older.id]);
    });

    it('menghormati limit', async () => {
      const requestId = randomUUID();
      await seedCommand({ approvalRequestId: requestId, createdAt: new Date('2026-01-01T00:00:00Z') });
      const newer = await seedCommand({ approvalRequestId: requestId, createdAt: new Date('2026-02-01T00:00:00Z') });

      const rows = await service.listCommands(requestId, 1);

      expect(rows.map(row => row.id)).toEqual([newer.id]);
    });

    it('mengembalikan daftar kosong saat permohonan belum punya command', async () => {
      expect(await service.listCommands(randomUUID())).toEqual([]);
    });
  });
});
