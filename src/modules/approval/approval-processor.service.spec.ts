import { randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { ApprovalProcessorService, ApprovalInboundContext } from './approval-processor.service';
import { ApprovalConfirmationService } from './approval-confirmation.service';
import { ApprovalNotificationService } from './approval-notification.service';
import { ApprovalReplyResolver } from './approval-reply-resolver.service';
import { ApprovalCommand } from './entities/approval-command.entity';
import { ApprovalRequest } from './entities/approval-request.entity';
import { WhatsAppIdentity } from './entities/whatsapp-identity.entity';
import { MockAlimCoreApprovalClient } from './core-client/mock-alim-core-approval.client';
import { WhatsAppIdentityService } from './whatsapp-identity.service';

const PERSON = '11111111-1111-4111-8111-111111111111';
const SENDER = '628111222333';
const SESSION = 'sess-approval';

interface SentMessage {
  sessionId: string;
  chatId: string;
  text: string;
}

describe('ApprovalProcessorService', () => {
  let ds: DataSource;
  let requests: Repository<ApprovalRequest>;
  let commands: Repository<ApprovalCommand>;
  let identityRepo: Repository<WhatsAppIdentity>;

  let identities: WhatsAppIdentityService;
  let processor: ApprovalProcessorService;
  let core: MockAlimCoreApprovalClient;
  let sent: SentMessage[];
  let replyToUnknown: boolean;
  let seq: number;

  beforeAll(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [ApprovalRequest, ApprovalCommand, WhatsAppIdentity],
      synchronize: true,
    });
    await ds.initialize();
  });

  afterAll(async () => {
    await ds.destroy();
  });

  beforeEach(async () => {
    await ds.getRepository(ApprovalCommand).clear();
    await ds.getRepository(ApprovalRequest).clear();
    await ds.getRepository(WhatsAppIdentity).clear();

    requests = ds.getRepository(ApprovalRequest);
    commands = ds.getRepository(ApprovalCommand);
    identityRepo = ds.getRepository(WhatsAppIdentity);

    sent = [];
    seq = 0;
    replyToUnknown = false;
    core = new MockAlimCoreApprovalClient();

    const messageService = {
      // eslint-disable-next-line @typescript-eslint/require-await -- tiruan MessageService.sendText yang async
      sendText: jest.fn(async (sessionId: string, dto: { chatId: string; text: string }) => {
        sent.push({ sessionId, chatId: dto.chatId, text: dto.text });

        return { messageId: `wamid.out.${++seq}`, timestamp: 1 };
      }),
    };

    const config = {
      get: (key: string, fallback?: unknown) =>
        key === 'connect.approval.replyToUnknownSender' ? replyToUnknown : fallback,
    };

    identities = new WhatsAppIdentityService(identityRepo);
    const notification = new ApprovalNotificationService(requests, messageService as never, identities);
    const confirmation = new ApprovalConfirmationService(messageService as never, notification);
    const resolver = new ApprovalReplyResolver(requests, identities);

    processor = new ApprovalProcessorService(
      requests,
      commands,
      identities,
      resolver,
      confirmation,
      config as never,
      core,
    );
  });

  async function seedIdentity(overrides: Partial<WhatsAppIdentity> = {}): Promise<WhatsAppIdentity> {
    return identityRepo.save(
      identityRepo.create({
        externalIdentity: SENDER,
        corePersonId: PERSON,
        displayName: 'Kepala Asrama',
        isVerified: true,
        isActive: true,
        verifiedAt: new Date(),
        ...overrides,
      }),
    );
  }

  async function seedRequest(overrides: Partial<ApprovalRequest> = {}): Promise<ApprovalRequest> {
    const n = ++seq;

    return requests.save(
      requests.create({
        coreRequestId: randomUUID(),
        reference: `IZN-2026-${String(n).padStart(5, '0')}`,
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
        targetCorePersonId: PERSON,
        targetIdentity: SENDER,
        sessionId: SESSION,
        notificationMessageId: `wamid.notif.${n}`,
        ...overrides,
      }),
    );
  }

  function inbound(body: string, overrides: Partial<ApprovalInboundContext> = {}): ApprovalInboundContext {
    return {
      sessionId: SESSION,
      externalMessageId: `wamid.in.${++seq}`,
      chatId: `${SENDER}@c.us`,
      senderIdentity: `${SENDER}@s.whatsapp.net`,
      body,
      quotedMessageId: null,
      isGroup: false,
      fromMe: false,
      ...overrides,
    };
  }

  // 1. Notifikasi terkirim -------------------------------------------------

  it('mengirim notifikasi berisi referensi dan instruksi balasan', async () => {
    await seedIdentity();
    const request = await seedRequest();

    const notification = new ApprovalNotificationService(
      requests,
      {
        // eslint-disable-next-line @typescript-eslint/require-await -- tiruan MessageService.sendText yang async
        sendText: jest.fn(async (sessionId: string, dto: { chatId: string; text: string }) => {
          sent.push({ sessionId, chatId: dto.chatId, text: dto.text });

          return { messageId: 'wamid.notif.out.1', timestamp: 1 };
        }),
      } as never,
      identities,
    );

    await notification.notify(request);

    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe(`${SENDER}@c.us`);
    expect(sent[0].text).toContain(request.reference);
    expect(sent[0].text).toContain(`SETUJU <jumlah hari> HARI ${request.reference}`);
    expect((await requests.findOneByOrFail({ id: request.id })).notificationMessageId).toBe('wamid.notif.out.1');
  });

  // 2. Identitas pengirim terverifikasi ------------------------------------

  it('hanya menerima identitas yang terverifikasi', async () => {
    await seedIdentity({ isVerified: false, externalIdentity: '628999000111' });

    expect(await identities.findVerified('0899-9000-111')).toBeNull();

    await seedIdentity({ isVerified: true, externalIdentity: SENDER });

    expect(await identities.findVerified('+62 811-1222-333')).toMatchObject({ corePersonId: PERSON });
  });

  // 3. SETUJU dengan durasi ------------------------------------------------

  it('menyetujui dengan durasi eksplisit dan mengirim konfirmasi setelah Core sukses', async () => {
    await seedIdentity();
    const request = await seedRequest();

    const outcome = await processor.handle(inbound(`SETUJU 2 HARI ${request.reference}`));

    expect(outcome).toBe('applied');
    expect(core.received).toHaveLength(1);
    expect(core.received[0]).toMatchObject({
      requestId: request.coreRequestId,
      decision: 'approved',
      approvedDurationDays: 2,
      actorExternalId: SENDER,
    });

    const stored = await requests.findOneByOrFail({ id: request.id });
    expect(stored.status).toBe('APPROVED');
    expect(stored.coreStatus).toBe('approved');

    const command = await commands.findOneByOrFail({ approvalRequestId: request.id });
    expect(command.status).toBe('APPLIED');
    expect(command.durationDays).toBe(2);

    expect(sent.at(-1)?.text).toContain('DISETUJUI');
  });

  // 4. TOLAK ---------------------------------------------------------------

  it('menolak permohonan tanpa durasi', async () => {
    await seedIdentity();
    const request = await seedRequest();

    const outcome = await processor.handle(inbound(`TOLAK ${request.reference}`));

    expect(outcome).toBe('applied');
    expect(core.received[0]).toMatchObject({ decision: 'rejected', approvedDurationDays: null });
    expect((await requests.findOneByOrFail({ id: request.id })).status).toBe('REJECTED');
    expect(sent.at(-1)?.text).toContain('DITOLAK');
  });

  // 5. SETUJU tanpa durasi → klarifikasi -----------------------------------

  it('meminta klarifikasi ketika SETUJU tidak menyebut durasi', async () => {
    await seedIdentity();
    const request = await seedRequest();

    const outcome = await processor.handle(inbound(`SETUJU ${request.reference}`));

    expect(outcome).toBe('clarification');
    expect(core.received).toHaveLength(0);
    expect((await requests.findOneByOrFail({ id: request.id })).status).toBe('NEEDS_CLARIFICATION');
    expect(sent.at(-1)?.text).toContain('belum menyebutkan durasi');
  });

  // 6. Reply teridentifikasi -----------------------------------------------

  it('mengaitkan balasan lewat reply ke pesan notifikasi', async () => {
    await seedIdentity();
    const request = await seedRequest({ notificationMessageId: 'wamid.notif.quoted' });

    const outcome = await processor.handle(inbound('SETUJU 2 HARI', { quotedMessageId: 'wamid.notif.quoted' }));

    expect(outcome).toBe('applied');
    expect(core.received[0].requestId).toBe(request.coreRequestId);
  });

  // 7. Balasan ambigu ------------------------------------------------------

  it('tidak memproses balasan ambigu ketika ada beberapa permohonan terbuka', async () => {
    await seedIdentity();
    await seedRequest();
    await seedRequest();

    const outcome = await processor.handle(inbound('SETUJU 2 HARI'));

    expect(outcome).toBe('not_found');
    expect(core.received).toHaveLength(0);
    expect(await commands.count()).toBe(0);
    expect(sent.at(-1)?.text).toContain('tidak dapat dikaitkan');
  });

  // 8. Nomor tak dikenal ---------------------------------------------------

  it('mengabaikan nomor tak dikenal tanpa membocorkan data izin', async () => {
    const request = await seedRequest();

    const outcome = await processor.handle(inbound(`SETUJU 2 HARI ${request.reference}`));

    expect(outcome).toBe('unknown_sender');
    expect(core.received).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  // 9. Pesan duplikat ------------------------------------------------------

  it('memproses pesan yang sama hanya sekali', async () => {
    await seedIdentity();
    const request = await seedRequest();
    const message = inbound(`SETUJU 2 HARI ${request.reference}`);

    expect(await processor.handle(message)).toBe('applied');
    expect(await processor.handle(message)).toBe('duplicate');

    expect(core.received).toHaveLength(1);
    expect(await commands.count()).toBe(1);
  });

  // 10. Core menolak + alasan ---------------------------------------------

  it('menyampaikan alasan penolakan Core dan tidak mengubah status menjadi disetujui', async () => {
    await seedIdentity();
    const request = await seedRequest();
    core.scenario = 'not_authorized';

    const outcome = await processor.handle(inbound(`SETUJU 2 HARI ${request.reference}`));

    expect(outcome).toBe('core_rejected');

    const stored = await requests.findOneByOrFail({ id: request.id });
    expect(stored.status).toBe('PENDING_APPROVAL');
    expect(stored.status).not.toBe('APPROVED');
    expect(sent.at(-1)?.text).toContain('tidak tercatat sebagai Kepala Asrama');

    const command = await commands.findOneByOrFail({ approvalRequestId: request.id });
    expect(command.status).toBe('REJECTED');
    expect(command.errorCode).toBe('actor_not_authorized');
  });

  // 11. Core timeout tanpa keputusan ganda --------------------------------

  it('tidak membuat keputusan ganda ketika Core timeout', async () => {
    await seedIdentity();
    const request = await seedRequest();
    core.scenario = 'timeout';

    expect(await processor.handle(inbound(`SETUJU 2 HARI ${request.reference}`))).toBe('core_unavailable');

    const afterTimeout = await requests.findOneByOrFail({ id: request.id });
    expect(afterTimeout.status).toBe('PROCESSING');
    expect((await commands.findOneByOrFail({ approvalRequestId: request.id })).status).toBe('UNKNOWN');
    expect(sent.at(-1)?.text).toContain('belum dapat dipastikan');

    // Balasan berbeda datang sebelum hasil diketahui: jangan kirim command baru.
    expect(await processor.handle(inbound(`TOLAK ${request.reference}`))).toBe('core_unavailable');
    expect(core.received).toHaveLength(1);
    expect(await commands.count()).toBe(1);

    // Balasan yang sama aman dikirim ulang dengan commandId yang sama.
    core.scenario = 'applied';
    expect(await processor.handle(inbound(`SETUJU 2 HARI ${request.reference}`))).toBe('applied');
    expect(core.received).toHaveLength(2);
    expect(core.received[1].commandId).toBe(core.received[0].commandId);
    expect(await commands.count()).toBe(1);
  });

  // 12. Konfirmasi hanya setelah Core sukses ------------------------------

  it('tidak pernah mengirim konfirmasi sukses sebelum Core menyatakan sukses', async () => {
    await seedIdentity();
    const request = await seedRequest();
    core.scenario = 'timeout';

    await processor.handle(inbound(`SETUJU 2 HARI ${request.reference}`));

    expect(sent.some(message => message.text.includes('DISETUJUI'))).toBe(false);

    const command = await commands.findOneByOrFail({ approvalRequestId: request.id });
    core.scenario = 'applied';

    expect(await processor.retryUnknown(command.commandId)).toBe('applied');
    expect(sent.at(-1)?.text).toContain('DISETUJUI');
    expect((await requests.findOneByOrFail({ id: request.id })).status).toBe('APPROVED');
  });

  // 13. Pemetaan lima decision value ---------------------------------------

  it.each([
    ['expired', 'EXPIRED', 'kedaluwarsa'],
    ['cancelled', 'CANCELLED', 'dibatalkan'],
    ['needs_clarification', 'NEEDS_CLARIFICATION', 'tidak dapat dipastikan'],
  ] as const)(
    'memetakan outcome %s ke status %s tanpa menyatakan disetujui',
    async (decision, expectedStatus, message) => {
      await seedIdentity();
      const request = await seedRequest();

      // Command non-final hanya dapat berasal dari proses internal; diuji lewat retryUnknown
      // agar jalur pemetaan Core → status lokal dan konfirmasi ikut teruji.
      const command = await commands.save(
        commands.create({
          commandId: `cmd-${decision}`,
          approvalRequestId: request.id,
          externalMessageId: `wamid.${decision}`,
          decision,
          durationDays: null,
          status: 'UNKNOWN',
          attempts: 0,
        }),
      );

      expect(await processor.retryUnknown(command.commandId)).toBe('applied');

      const after = await requests.findOneByOrFail({ id: request.id });
      expect(after.status).toBe(expectedStatus);
      expect(sent.at(-1)?.text).toContain(message);
      expect(sent.some(entry => entry.text.includes('DISETUJUI'))).toBe(false);
    },
  );

  // 14. Command PENDING: proses berhenti sebelum sempat mengirim -------------

  it('menyimpan lease saat command PENDING dibuat, sehingga worker tidak mendahului pengirim', async () => {
    await seedIdentity();
    const request = await seedRequest();
    const send = core.sendApprovalCommand.bind(core);
    let duringSend: ApprovalCommand | null = null;

    jest.spyOn(core, 'sendApprovalCommand').mockImplementation(async command => {
      // Keadaan tepat seperti yang ditinggalkan proses yang mati setelah menyimpan PENDING.
      duringSend = await commands.findOneByOrFail({ approvalRequestId: request.id });

      return send(command);
    });

    expect(await processor.handle(inbound(`SETUJU 2 HARI ${request.reference}`))).toBe('applied');
    expect(duringSend).not.toBeNull();
    expect(duringSend!.status).toBe('PENDING');
    expect(duringSend!.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('memulihkan command PENDING setelah proses berhenti sebelum mengirim', async () => {
    await seedIdentity();
    const request = await seedRequest();
    const pending = await commands.save(
      commands.create({
        commandId: randomUUID(),
        approvalRequestId: request.id,
        externalMessageId: 'wamid.crash',
        decision: 'approved',
        durationDays: 2,
        status: 'PENDING',
        attempts: 0,
        nextAttemptAt: new Date(Date.now() - 1000),
      }),
    );

    expect(await processor.retryUnknown(pending.commandId)).toBe('applied');

    expect(core.received).toHaveLength(1);
    expect(core.received[0].commandId).toBe(pending.commandId);
    expect(core.received[0].externalMessageId).toBe('wamid.crash');
    expect(await commands.count()).toBe(1);
    expect((await requests.findOneByOrFail({ id: request.id })).status).toBe('APPROVED');
  });

  it('tidak membuat command kedua untuk keputusan berbeda saat command masih PENDING', async () => {
    await seedIdentity();
    const request = await seedRequest();
    await commands.save(
      commands.create({
        commandId: randomUUID(),
        approvalRequestId: request.id,
        externalMessageId: 'wamid.inflight',
        decision: 'approved',
        durationDays: 2,
        status: 'PENDING',
        attempts: 0,
        nextAttemptAt: new Date(Date.now() + 60_000),
      }),
    );

    expect(await processor.handle(inbound(`TOLAK ${request.reference}`))).toBe('core_unavailable');
    expect(core.received).toHaveLength(0);
    expect(await commands.count()).toBe(1);
    expect((await requests.findOneByOrFail({ id: request.id })).status).toBe('PENDING_APPROVAL');
  });

  it('mengirim ulang keputusan yang sama dengan commandId PENDING, bukan command baru', async () => {
    await seedIdentity();
    const request = await seedRequest();
    const pending = await commands.save(
      commands.create({
        commandId: randomUUID(),
        approvalRequestId: request.id,
        externalMessageId: 'wamid.inflight',
        decision: 'approved',
        durationDays: 2,
        status: 'PENDING',
        attempts: 0,
        nextAttemptAt: new Date(Date.now() + 60_000),
      }),
    );

    expect(await processor.handle(inbound(`SETUJU 2 HARI ${request.reference}`))).toBe('applied');
    expect(core.received).toHaveLength(1);
    expect(core.received[0].commandId).toBe(pending.commandId);
    expect(await commands.count()).toBe(1);
  });

  // 15. Permohonan yang masih terbuka vs sudah final -------------------------

  it('masih dapat memutuskan permohonan yang menunggu klarifikasi', async () => {
    await seedIdentity();
    const request = await seedRequest({ status: 'NEEDS_CLARIFICATION' });

    expect(await processor.handle(inbound(`SETUJU 2 HARI ${request.reference}`))).toBe('applied');
    expect((await requests.findOneByOrFail({ id: request.id })).status).toBe('APPROVED');
  });

  it('menolak keputusan baru untuk permohonan yang sudah final', async () => {
    await seedIdentity();
    const request = await seedRequest({ status: 'APPROVED', coreStatus: 'approved' });

    expect(await processor.handle(inbound(`TOLAK ${request.reference}`))).toBe('not_decidable');
    expect(core.received).toHaveLength(0);
    expect(await commands.count()).toBe(0);
    expect(sent.at(-1)?.text).toContain('sudah diputuskan');
  });

  // 16. Pemulihan command tanpa permohonan -------------------------------

  it('memarkir command yang permohonannya sudah tidak ada', async () => {
    const command = await commands.save(
      commands.create({
        commandId: randomUUID(),
        approvalRequestId: randomUUID(),
        externalMessageId: 'wamid.orphan',
        decision: 'approved',
        durationDays: 2,
        status: 'UNKNOWN',
        attempts: 1,
      }),
    );

    expect(await processor.retryUnknown(command.commandId)).toBe('not_found');

    const after = await commands.findOneByOrFail({ id: command.id });
    expect(after.status).toBe('FAILED');
    expect(after.lastError).toMatch(/tidak ditemukan/);
    expect(core.received).toHaveLength(0);
  });

  // 17. Konsistensi audit saat Core menyatakan izin sudah diputuskan ----------

  it('mencatat waktu dan sumber keputusan saat Core menyatakan izin sudah final', async () => {
    await seedIdentity();
    const request = await seedRequest();

    jest.spyOn(core, 'sendApprovalCommand').mockResolvedValue({
      outcome: 'rejected',
      decisionOutcome: null,
      httpStatus: 409,
      code: 'permit_not_decidable',
      message: 'Permohonan sudah diputuskan.',
      coreStatus: 'approved',
      secondaryStatus: null,
      expectedReturnAt: null,
      retryable: false,
      raw: null,
    });

    expect(await processor.handle(inbound(`SETUJU 2 HARI ${request.reference}`))).toBe('core_rejected');

    const stored = await requests.findOneByOrFail({ id: request.id });
    expect(stored.status).toBe('APPROVED');
    expect(stored.decidedAt).toBeInstanceOf(Date);
    expect(stored.decisionSource).toBe('core');
  });
});
