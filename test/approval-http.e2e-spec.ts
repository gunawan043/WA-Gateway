import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { createServer, Server } from 'http';
import type { AddressInfo } from 'net';
import supertest from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { requestContextMiddleware } from '../src/common/middleware/request-context.middleware';
import { applyGlobalValidation } from '../src/config/app-validation';
import { HookManager } from '../src/core/hooks/hook-manager.service';
import { ALIM_CORE_APPROVAL_CLIENT } from '../src/modules/approval/core-client/alim-core-approval.client';
import { assertApprovalCoreClientAllowed } from '../src/modules/approval/core-client/core-client-policy';
import { HttpAlimCoreApprovalClient } from '../src/modules/approval/core-client/http-alim-core-approval.client';
import { ApprovalRetryService } from '../src/modules/approval/approval-retry.service';
import { ApprovalCommand } from '../src/modules/approval/entities/approval-command.entity';
import { ApprovalRequest } from '../src/modules/approval/entities/approval-request.entity';
import { WhatsAppIdentity } from '../src/modules/approval/entities/whatsapp-identity.entity';
import { AuditAction, AuditLog } from '../src/modules/audit/entities/audit-log.entity';
import { MetricsService } from '../src/modules/metrics/metrics.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { ApiKeyRole } from '../src/modules/auth/entities/api-key.entity';

/**
 * Alur approval lewat HTTP yang sesungguhnya, dengan Core palsu di batas HTTP.
 *
 * Yang dibuktikan di sini tidak dapat dibuktikan unit test: guard global, DTO pipe, routing,
 * `@RequireUnscopedKey`, klien HTTP nyata (bukan mock yang menggantikan `ApprovalService`), dan
 * pemrosesan balasan lewat hook `message:received` yang memang dipakai aplikasi.
 *
 * Core palsu adalah server HTTP di loopback. `ALIM_CONNECT_CORE_CLIENT=http` membuat aplikasi
 * memakai `HttpAlimCoreApprovalClient` yang asli, sehingga `fetch`, timeout, dan pembacaan envelope
 * semuanya berjalan. Tidak ada jalan bagi mock ini masuk produksi: `assertApprovalCoreClientAllowed`
 * menolak `mock` saat `NODE_ENV=production`, dan test terakhir memeriksa keduanya.
 */

const INGEST_KEY = 'e2e-ingest-key';
const CORE_KEY = 'e2e-core-approval-key';
const CORE_HEADER = 'x-alim-connect-approval-key';
const METRICS_TOKEN = 'e2e-metrics-token-0123456789abcdef';
const TARGET_NUMBER = '628111000001';
const TARGET_JID = '628111000001@s.whatsapp.net';
const TARGET_CORE_PERSON_ID = '9f1c2a44-3c55-4c1e-9c1f-2b7d8e6a5f01';
const CORE_TIMEOUT_MS = 400;
const MAX_ATTEMPTS = 2;

process.env.METRICS_TOKEN = METRICS_TOKEN;
process.env.ALIM_CONNECT_CORE_CLIENT = 'http';
process.env.ALIM_CONNECT_INGEST_KEY = INGEST_KEY;
// Kunci untuk mock (section mock) harus CORE_KEY, tetapi section "Core sungguhan" harus memakai
// kunci milik operator: menimpanya di sini membuat uji nyata ditolak 401 oleh Core staging.
const operatorApprovalKey = (process.env.ALIM_CORE_APPROVAL_API_KEY ?? '').trim();
process.env.ALIM_CORE_APPROVAL_API_KEY = CORE_KEY;
process.env.ALIM_CORE_TIMEOUT_MS = String(CORE_TIMEOUT_MS);
// Worker deterministik: tidak ada pass otomatis; test memanggil runOnce() sendiri.
process.env.ALIM_CONNECT_RETRY_INTERVAL_MS = '0';
process.env.ALIM_CONNECT_RETRY_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.ALIM_CONNECT_RETRY_BASE_DELAY_MS = '10';
process.env.ALIM_CONNECT_RETRY_MAX_DELAY_MS = '20';
process.env.ALIM_CONNECT_RETRY_LEASE_MS = '50';

interface CoreCall {
  path: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

interface MockReply {
  status: number;
  body: unknown;
  delayMs?: number;
}

interface ApprovalRequestBody {
  id: string;
  coreRequestId: string;
  reference: string;
  status: string;
  coreStatus: string | null;
  [key: string]: unknown;
}

interface CommandViewBody {
  commandId: string;
  status: string;
  attempts: number;
  coreResponseCode: number | null;
  errorCode: string | null;
  lastError: string | null;
  decision: string;
  durationDays: number | null;
  [key: string]: unknown;
}

interface DetailBody extends ApprovalRequestBody {
  commands?: CommandViewBody[];
}

const appliedBody = (overrides: Record<string, unknown> = {}): unknown => ({
  success: true,
  message: 'Command diterapkan.',
  data: { outcome: 'applied', status: 'approved', expected_return_datetime: '2026-11-25T10:00:00+07:00', ...overrides },
  errors: null,
});

const duplicateBody = (): unknown => ({
  success: true,
  message: 'Command sudah pernah diterapkan.',
  data: { outcome: 'duplicate', status: 'approved' },
  errors: null,
});

const rejectedBody = (code: string, message: string): unknown => ({
  success: false,
  message,
  data: null,
  errors: { code },
});

describe('Approval over HTTP with a mock Core at the HTTP boundary (e2e)', () => {
  let app: INestApplication<App>;
  let coreServer: Server;
  let coreBaseUrl: string;
  let coreCalls: CoreCall[] = [];
  let responder: (call: CoreCall) => MockReply = () => ({ status: 200, body: appliedBody() });

  let adminKey: string;
  let viewerKey: string;
  let scopedViewerKey: string;
  let scopedAdminKey: string;

  let hooks: HookManager;
  let retry: ApprovalRetryService;
  let commands: Repository<ApprovalCommand>;
  let requests: Repository<ApprovalRequest>;
  let metricsService: MetricsService;

  const resetCoreMock = (): void => {
    coreCalls = [];
    responder = () => ({ status: 200, body: appliedBody() });
  };

  const startMockCore = async (): Promise<void> => {
    coreServer = createServer((req, res) => {
      const chunks: Buffer[] = [];

      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: Record<string, unknown>;

        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          body = {};
        }

        const call: CoreCall = {
          path: req.url ?? '',
          method: req.method ?? '',
          headers: req.headers,
          body,
        };

        coreCalls.push(call);

        const reply = responder(call);
        const send = (): void => {
          // Klien dapat membatalkan permintaan (timeout) sebelum balasan ini dikirim.
          if (res.writableEnded || res.destroyed) return;
          res.writeHead(reply.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(reply.body));
        };

        if (reply.delayMs) {
          setTimeout(send, reply.delayMs);
        } else {
          send();
        }
      });
    });
    coreServer.on('clientError', () => undefined);

    await new Promise<void>(resolve => coreServer.listen(0, '127.0.0.1', resolve));

    coreBaseUrl = `http://127.0.0.1:${(coreServer.address() as AddressInfo).port}`;
  };

  // Lihat catatan di sso-handoff-http.e2e-spec.ts: nilai operator harus ditangkap sebelum mock
  // menimpa variabelnya, atau uji "Core sungguhan" akan menembak mock dan tetap melaporkan lulus.
  const operatorCoreBaseUrl = (process.env.ALIM_CORE_BASE_URL ?? '').trim();

  beforeAll(async () => {
    await startMockCore();

    // Env Core harus sudah final sebelum AppModule dievaluasi: `ConfigModule.forRoot` memanggil
    // factory `configuration.ts` saat modul di-import, dan factory itu membaca process.env.
    // Karena itu modul dimuat di sini dengan `require`, bukan `import` di puncak berkas. Registry
    // modul tetap sama, jadi patch loopback dari setup-e2e masih berlaku (tidak seperti
    // `jest.isolateModules`, yang akan memuat ulang @nestjs/core).
    process.env.ALIM_CORE_BASE_URL = coreBaseUrl;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppModule } = require('../src/app.module') as typeof import('../src/app.module');

    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    applyGlobalValidation(app);
    app.use(requestContextMiddleware);
    await app.init();

    const authService = app.get(AuthService);
    adminKey = (await authService.createApiKey({ name: 'e2e-approval-admin', role: ApiKeyRole.ADMIN })).rawKey;
    viewerKey = (await authService.createApiKey({ name: 'e2e-approval-viewer', role: ApiKeyRole.VIEWER })).rawKey;
    scopedViewerKey = (
      await authService.createApiKey({
        name: 'e2e-approval-scoped-viewer',
        role: ApiKeyRole.VIEWER,
        allowedSessions: ['e2e-session'],
      })
    ).rawKey;
    scopedAdminKey = (
      await authService.createApiKey({
        name: 'e2e-approval-scoped-admin',
        role: ApiKeyRole.ADMIN,
        allowedSessions: ['e2e-session'],
      })
    ).rawKey;

    hooks = app.get(HookManager);
    retry = app.get(ApprovalRetryService);
    commands = app.get<Repository<ApprovalCommand>>(getRepositoryToken(ApprovalCommand, 'data'));
    requests = app.get<Repository<ApprovalRequest>>(getRepositoryToken(ApprovalRequest, 'data'));
    metricsService = app.get(MetricsService);

    // Pemetaan identitas lewat endpoint yang sesungguhnya, bukan penyisipan baris langsung:
    // yang diuji termasuk audit dan aturan verifikasi.
    await supertest(app.getHttpServer())
      .post('/api/approval/identities')
      .set('x-api-key', adminKey)
      .send({
        externalIdentity: TARGET_NUMBER,
        corePersonId: TARGET_CORE_PERSON_ID,
        displayName: 'Kepala Asrama E2E',
        isVerified: true,
      })
      .expect(201);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    coreServer?.closeAllConnections?.();
    await new Promise<void>(resolve => coreServer?.close(() => resolve()));
  }, 60_000);

  beforeEach(async () => {
    resetCoreMock();
    // Command yang ditinggalkan test sebelumnya tidak boleh ikut diklaim pass retry berikutnya.
    // Ini pembersihan state test, bukan perubahan perilaku: nilainya langsung terminal.
    await commands
      .createQueryBuilder()
      .update(ApprovalCommand)
      .set({ status: 'FAILED', nextAttemptAt: null })
      .where('status IN (:...statuses)', { statuses: ['UNKNOWN', 'PENDING'] })
      .execute();
  });

  // Mengembalikan Test (bukan Promise) supaya pemanggil dapat merantai `.expect(status)`.
  const ingest = (
    overrides: Record<string, unknown> = {},
    options: { key?: string | null; ingestKey?: string | null } = {},
  ) => {
    const key = options.key === undefined ? adminKey : options.key;
    const header = options.ingestKey === undefined ? INGEST_KEY : options.ingestKey;
    const payload = {
      coreRequestId: randomUUID(),
      reference: 'IZN-2026-001',
      studentName: 'Ahmad Fauzi',
      studentClass: '7A',
      permitType: 'pulang',
      requestedDurationDays: 2,
      targetCorePersonId: TARGET_CORE_PERSON_ID,
      targetIdentity: TARGET_NUMBER,
      notify: false,
      ...overrides,
    };

    let req = supertest(app.getHttpServer()).post('/api/approval/requests');
    if (key !== null) req = req.set('x-api-key', key);
    if (header !== null) req = req.set('x-alim-connect-ingest-key', header);

    return req.send(payload);
  };

  // Dipakai test terakhir: satu permohonan dan satu balasan WhatsApp lewat rute yang sama, sehingga
  // apa pun yang dikirim ke Core berasal dari aplikasi, bukan dari test.
  const ingestApproval = (overrides: Record<string, unknown> = {}) => ingest(overrides);

  /**
   * The same reply from another number, for the real-Core section: the mock sections' sender
   * (TARGET_NUMBER) is mapped by an earlier test to somebody else, so a real command sent as that
   * number is refused on the actor while the permit it replies to is still targeted at the staging
   * actor — a mismatch that says nothing about Core.
   */
  const replyFrom = async (from: string, body: string, messageId: string): Promise<void> => {
    const result = await hooks.execute(
      'message:received',
      { id: messageId, from, chatId: from, body, isGroup: false, fromMe: false },
      { source: 'Engine' },
    );

    expect(result.continue).toBe(true);
  };

  const reply = async (body: string, messageId: string): Promise<void> => {
    const result = await hooks.execute(
      'message:received',
      { id: messageId, from: TARGET_JID, chatId: TARGET_JID, body, isGroup: false, fromMe: false },
      { source: 'Engine' },
    );

    expect(result.continue).toBe(true);
  };

  const detail = async (id: string, key = viewerKey): Promise<DetailBody> => {
    const res = await supertest(app.getHttpServer())
      .get(`/api/approval/requests/${id}`)
      .query({ include: 'commands' })
      .set('x-api-key', key)
      .expect(200);

    return res.body as DetailBody;
  };

  /**
   * The permit once ALIM has a verdict for it: a command was stored, and its status has moved past
   * PENDING. Polled because the reply hook does not wait for Core to answer; 20 s is far beyond a Core
   * round trip, and a permit still unsettled then is returned as it is, not assumed.
   */
  const waitForCommand = async (id: string): Promise<DetailBody> => {
    const settled = (body: DetailBody): boolean => {
      const [command] = body.commands ?? [];
      return Boolean(command) && command.status !== 'PENDING';
    };
    let latest = await detail(id);
    for (let waited = 0; waited < 20_000 && !settled(latest); waited += 250) {
      await new Promise(resolve => setTimeout(resolve, 250));
      latest = await detail(id);
    }
    return latest;
  };

  // `MetricsService.render()` menyajikan hasil yang di-cache selama beberapa detik, sehingga dua
  // scrape berurutan akan mengembalikan teks yang sama dan delta selalu nol. Cache itu dibuang
  // sebelum setiap scrape di sini; yang diuji adalah nilai counter, bukan perilaku cache.
  const metrics = async (): Promise<string> => {
    (metricsService as unknown as { cachedRender: { at: number; text: string } | null }).cachedRender = null;

    const res = await supertest(app.getHttpServer())
      .get('/api/metrics')
      .set('authorization', `Bearer ${METRICS_TOKEN}`)
      .expect(200);

    return res.text;
  };

  const metricValue = (text: string, prefix: string): number => {
    const line = text.split('\n').find(candidate => candidate.startsWith(prefix));

    return line ? Number(line.slice(prefix.length).trim()) : 0;
  };

  const appliedMetric = (text: string): number =>
    metricValue(text, 'openwa_approval_command_transitions_total{status="applied"} ');
  const unknownMetric = (text: string): number =>
    metricValue(text, 'openwa_approval_command_transitions_total{status="unknown"} ');
  const failedMetric = (text: string): number =>
    metricValue(text, 'openwa_approval_command_transitions_total{status="failed"} ');
  const duplicateMetric = (text: string): number =>
    metricValue(text, 'openwa_approval_command_transitions_total{status="duplicate"} ');
  const rejectedMetric = (text: string): number =>
    metricValue(text, 'openwa_approval_command_transitions_total{status="rejected"} ');
  const ingestRejectedMetric = (reason: string): string => `openwa_approval_ingest_rejected_total{reason="${reason}"} `;
  const notificationMetric = (result: string): string => `openwa_approval_notifications_total{result="${result}"} `;

  describe('A. Alur normal', () => {
    it('menerima permohonan lewat HTTP, mengirim command ke Core, dan menyimpan status akhir', async () => {
      const coreRequestId = randomUUID();

      const ingested = await ingest({ coreRequestId, reference: 'IZN-2026-101' }).expect(201);
      const request = ingested.body as ApprovalRequestBody;

      expect(request.status).toBe('PENDING_APPROVAL');
      expect(request.coreRequestId).toBe(coreRequestId);

      await reply('SETUJU 2 HARI IZN-2026-101', 'wamid-e2e-101');

      expect(coreCalls).toHaveLength(1);

      const [call] = coreCalls;

      expect(call.method).toBe('POST');
      expect(call.path).toBe('/api/connect/v1/approval-commands');
      expect(call.headers[CORE_HEADER]).toBe(CORE_KEY);
      // Kontrak command: header idempotensi dan versi ikut terkirim lewat HTTP nyata, dan nilainya
      // tidak menyimpang dari body.
      expect(call.headers['idempotency-key']).toBe(call.body.command_id);
      expect(call.headers['x-alim-api-version']).toBe('1');
      expect(call.body).toMatchObject({
        request_id: coreRequestId,
        decision: 'approved',
        approved_duration_days: 2,
        actor_external_id: TARGET_NUMBER,
        actor_core_person_id: TARGET_CORE_PERSON_ID,
        source: 'whatsapp',
        external_message_id: 'wamid-e2e-101',
        message_text: 'SETUJU 2 HARI',
      });
      expect(call.body.command_id).toMatch(/^[0-9a-f-]{36}$/);

      const after = await detail(request.id);

      expect(after.status).toBe('APPROVED');
      expect(after.coreStatus).toBe('approved');
      expect(after.commands).toHaveLength(1);
      expect(after.commands?.[0]).toMatchObject({
        status: 'APPLIED',
        attempts: 1,
        coreResponseCode: 200,
        decision: 'approved',
        durationDays: 2,
      });
      expect(after.commands?.[0]?.commandId).toBe(call.body.command_id);
    });

    it('meninggalkan satu baris audit per command, tanpa nomor pengirim maupun teks balasan', async () => {
      const coreRequestId = randomUUID();
      const ingested = await ingest({ coreRequestId, reference: 'IZN-2026-104' }).expect(201);
      const request = ingested.body as ApprovalRequestBody;

      await reply('SETUJU 2 HARI IZN-2026-104', 'wamid-e2e-104');

      const after = await detail(request.id);
      const [command] = after.commands ?? [];

      // Read through the application's own audit repository, so this proves the wiring and not just
      // the processor's intent.
      const audits = app.get<Repository<AuditLog>>(getRepositoryToken(AuditLog, 'main'));
      const rows = await audits.find({ where: { action: AuditAction.APPROVAL_COMMAND } });
      const mine = rows.filter(row => row.metadata?.commandId === command?.commandId);

      expect(mine).toHaveLength(1);
      expect(mine[0].metadata).toMatchObject({
        outcome: 'applied',
        coreRequestId,
        decision: 'approved',
        approvedDurationDays: 2,
        commandStatus: 'APPLIED',
        requestStatus: 'APPROVED',
        actorCorePersonId: TARGET_CORE_PERSON_ID,
      });

      const flat = JSON.stringify(mine[0].metadata);
      expect(flat).not.toContain(TARGET_NUMBER);
      expect(flat).not.toContain('SETUJU 2 HARI');
      expect(flat).not.toContain(CORE_KEY);
    });

    it('tidak mengembalikan body mentah Core, id pesan WhatsApp, atau topologi sesi', async () => {
      const ingested = await ingest({ reference: 'IZN-2026-102' }).expect(201);
      const request = ingested.body as ApprovalRequestBody;

      await reply('TOLAK IZN-2026-102', 'wamid-e2e-102');

      const after = await detail(request.id);
      const [command] = after.commands ?? [];

      expect(command).toBeDefined();
      expect(Object.keys(command ?? {}).sort()).toEqual(
        [
          'approvalRequestId',
          'attempts',
          'commandId',
          'coreResponseCode',
          'createdAt',
          'decision',
          'durationDays',
          'errorCode',
          'id',
          'lastAttemptAt',
          'lastError',
          'nextAttemptAt',
          'resolvedAt',
          'sentAt',
          'status',
          'updatedAt',
        ].sort(),
      );
      expect(JSON.stringify(after)).not.toContain('Command diterapkan.');
      expect(after).not.toHaveProperty('targetIdentity');
      expect(after).not.toHaveProperty('targetCorePersonId');
      expect(after).not.toHaveProperty('sessionId');
      expect(after).not.toHaveProperty('notificationMessageId');
    });

    it('mencatat penolakan Core sebagai REJECTED dan menyamarkan pesan error sebelum keluar', async () => {
      responder = () => ({
        status: 422,
        body: rejectedBody(
          'permit_not_decidable',
          'Izin sudah final. Hubungi https://core.internal/izin atau admin@alim.sch.id di 6281234567890. Authorization: Bearer rahasia-core',
        ),
      });

      const ingested = await ingest({ reference: 'IZN-2026-103' }).expect(201);
      const request = ingested.body as ApprovalRequestBody;

      await reply('SETUJU 1 HARI IZN-2026-103', 'wamid-e2e-103');

      const after = await detail(request.id);
      const [command] = after.commands ?? [];

      expect(command?.status).toBe('REJECTED');
      expect(command?.coreResponseCode).toBe(422);
      expect(command?.errorCode).toBe('permit_not_decidable');
      expect(after.status).toBe('PENDING_APPROVAL');

      const lastError = command?.lastError ?? '';

      expect(lastError).toContain('[url]');
      expect(lastError).toContain('[email]');
      expect(lastError).toContain('[number]');
      expect(lastError).toContain('[redacted]');
      expect(lastError).not.toContain('core.internal');
      expect(lastError).not.toContain('admin@alim.sch.id');
      expect(lastError).not.toContain('6281234567890');
      expect(lastError).not.toContain('rahasia-core');
    });
  });

  describe('B. Keamanan', () => {
    it('menolak ingest tanpa kredensial layanan atau dengan kredensial yang salah', async () => {
      const before = await metrics();

      await ingest({}, { ingestKey: null }).expect(401);
      await ingest({}, { ingestKey: 'salah' }).expect(401);

      const after = await metrics();

      expect(metricValue(after, ingestRejectedMetric('credential'))).toBe(
        metricValue(before, ingestRejectedMetric('credential')) + 2,
      );
      expect(coreCalls).toHaveLength(0);
    });

    it('menolak request tanpa API key dan menolak VIEWER pada ingest', async () => {
      await ingest({}, { key: null }).expect(401);
      await ingest({}, { key: viewerKey }).expect(403);

      expect(coreCalls).toHaveLength(0);
    });

    it('menolak key yang dibatasi sesi pada rute approval', async () => {
      const ingested = await ingest({ reference: 'IZN-2026-111' }).expect(201);
      const request = ingested.body as ApprovalRequestBody;

      await supertest(app.getHttpServer())
        .get(`/api/approval/requests/${request.id}`)
        .set('x-api-key', scopedViewerKey)
        .expect(403);

      await supertest(app.getHttpServer())
        .post('/api/approval/requests')
        .set('x-api-key', scopedAdminKey)
        .set('x-alim-connect-ingest-key', INGEST_KEY)
        .send({
          coreRequestId: randomUUID(),
          reference: 'IZN-2026-112',
          studentName: 'Ahmad Fauzi',
          permitType: 'pulang',
          sessionId: 'e2e-session',
        })
        .expect(403);
    });

    it('menolak body yang tidak memenuhi DTO sebelum menyimpan apa pun', async () => {
      const res = await ingest({ coreRequestId: 'bukan-uuid', reference: 'IZN-2026-113' }).expect(400);

      expect(JSON.stringify(res.body)).toContain('coreRequestId');

      const list = await supertest(app.getHttpServer())
        .get('/api/approval/requests')
        .query({ limit: 200 })
        .set('x-api-key', viewerKey)
        .expect(200);

      expect((list.body as ApprovalRequestBody[]).some(row => row.reference === 'IZN-2026-113')).toBe(false);
    });

    it('menolak nomor tujuan yang tidak valid dan mencatatnya sebagai ingest invalid', async () => {
      const before = await metrics();

      await ingest({ reference: 'IZN-2026-114', targetIdentity: 'bukan-nomor' }).expect(400);

      const after = await metrics();

      expect(metricValue(after, ingestRejectedMetric('invalid'))).toBe(
        metricValue(before, ingestRejectedMetric('invalid')) + 1,
      );
    });

    it('memakai klien HTTP asli, dan kebijakan produksi menolak mock', () => {
      expect(app.get(ALIM_CORE_APPROVAL_CLIENT)).toBeInstanceOf(HttpAlimCoreApprovalClient);
      expect(() =>
        assertApprovalCoreClientAllowed({ coreClient: 'mock', coreBaseUrl: '', coreApiKey: '' }, 'production'),
      ).toThrow(/ALIM_CONNECT_CORE_CLIENT/);
    });

    /**
     * Batas yang diketahui, bukan jaminan.
     *
     * Connect belum punya sumber unit organisasi yang sah dari Core, jadi `VIEWER` membaca seluruh
     * asrama. Test ini mengunci keadaan itu supaya tidak ada yang mengira scoping sudah ada, dan
     * supaya perubahan pertama yang menambahkan scoping gagal di sini dan memaksa test negatif
     * pengganti — bukan lolos diam-diam.
     */
    it('membiarkan VIEWER membaca permohonan lintas asrama (batas yang diketahui)', async () => {
      const dormitoryA = '11111111-1111-4111-8111-111111111111';
      const dormitoryB = '22222222-2222-4222-8222-222222222222';

      const first = (await ingest({
        reference: 'IZN-2026-141',
        dormitoryCoreId: dormitoryA,
        dormitoryName: 'Asrama A',
      }).expect(201)) as { body: ApprovalRequestBody };
      const second = (await ingest({
        reference: 'IZN-2026-142',
        dormitoryCoreId: dormitoryB,
        dormitoryName: 'Asrama B',
      }).expect(201)) as { body: ApprovalRequestBody };

      const list = await supertest(app.getHttpServer())
        .get('/api/approval/requests')
        .query({ limit: 200 })
        .set('x-api-key', viewerKey)
        .expect(200);
      const listed = (list.body as ApprovalRequestBody[]).map(row => row.id);

      expect(listed).toEqual(expect.arrayContaining([first.body.id, second.body.id]));

      // Detail permohonan asrama lain juga terbuka, dan asal asramanya ikut terlihat.
      const detailOfOther = await detail(second.body.id);

      expect(detailOfOther.id).toBe(second.body.id);
      expect(detailOfOther.dormitoryCoreId).toBe(dormitoryB);
    });
  });

  describe('C. Reliability', () => {
    it('tidak membuat command kedua untuk pesan WhatsApp yang sama', async () => {
      const ingested = await ingest({ reference: 'IZN-2026-121' }).expect(201);
      const request = ingested.body as ApprovalRequestBody;

      await reply('SETUJU 2 HARI IZN-2026-121', 'wamid-e2e-121');
      await reply('SETUJU 2 HARI IZN-2026-121', 'wamid-e2e-121');

      const rows = await commands.find({ where: { approvalRequestId: request.id } });

      expect(rows).toHaveLength(1);
      expect(coreCalls).toHaveLength(1);
      expect((await detail(request.id)).status).toBe('APPROVED');
    });

    it('timeout tidak pernah menghasilkan status disetujui', async () => {
      responder = () => ({ status: 200, body: appliedBody(), delayMs: CORE_TIMEOUT_MS * 3 });

      const before = await metrics();
      const ingested = await ingest({ reference: 'IZN-2026-122' }).expect(201);
      const request = ingested.body as ApprovalRequestBody;

      await reply('SETUJU 2 HARI IZN-2026-122', 'wamid-e2e-122');

      const after = await detail(request.id);
      const [command] = after.commands ?? [];

      expect(after.status).toBe('PROCESSING');
      expect(command?.status).toBe('UNKNOWN');
      expect(command?.coreResponseCode).toBe(504);
      expect(command?.lastError).toBe('Core tidak merespons tepat waktu.');
      expect(metricValue(await metrics(), 'openwa_approval_command_transitions_total{status="unknown"} ')).toBe(
        unknownMetric(before) + 1,
      );
      expect(appliedMetric(await metrics())).toBe(appliedMetric(before));
    });

    it('retry mengirim ulang command yang sama dan memulihkannya setelah Core menjawab', async () => {
      let attempt = 0;

      responder = () => {
        attempt += 1;

        return attempt === 1
          ? { status: 500, body: rejectedBody('core_error', 'Gagal sementara.'), delayMs: CORE_TIMEOUT_MS * 3 }
          : { status: 200, body: appliedBody() };
      };

      const ingested = await ingest({ reference: 'IZN-2026-123' }).expect(201);
      const request = ingested.body as ApprovalRequestBody;

      await reply('SETUJU 2 HARI IZN-2026-123', 'wamid-e2e-123');

      const timedOut = await detail(request.id);
      const firstCommandId = timedOut.commands?.[0]?.commandId;

      expect(timedOut.commands?.[0]?.status).toBe('UNKNOWN');

      const stats = await retry.runOnce(new Date(Date.now() + 60_000));

      expect(stats.retried).toBeGreaterThanOrEqual(1);
      expect(coreCalls).toHaveLength(2);
      expect(coreCalls[1].body.command_id).toBe(firstCommandId);
      expect(coreCalls[1].body.external_message_id).toBe('wamid-e2e-123');

      // Kontrak Core: percobaan ulang harus identik, bukan sekadar mirip, dan header
      // `Idempotency-Key` harus mengulang `command_id` — Core menolak (422) bila berbeda.
      expect(coreCalls[1].body).toEqual(coreCalls[0].body);
      expect(coreCalls[1].headers['idempotency-key']).toBe(firstCommandId);
      expect(coreCalls[1].headers['x-alim-api-version']).toBe(coreCalls[0].headers['x-alim-api-version']);

      const recovered = await detail(request.id);

      expect(recovered.status).toBe('APPROVED');
      expect(recovered.commands?.[0]).toMatchObject({ status: 'APPLIED', attempts: 2 });
      expect(recovered.commands?.[0]?.commandId).toBe(firstCommandId);
    });

    it('jawaban duplicate dari Core diperlakukan sebagai hasil sah, bukan keputusan kedua', async () => {
      let attempt = 0;

      responder = () => {
        attempt += 1;

        return attempt === 1
          ? { status: 500, body: rejectedBody('core_error', 'Gagal sementara.') }
          : { status: 200, body: duplicateBody() };
      };

      const before = await metrics();
      const ingested = await ingest({ reference: 'IZN-2026-124' }).expect(201);
      const request = ingested.body as ApprovalRequestBody;

      await reply('SETUJU 2 HARI IZN-2026-124', 'wamid-e2e-124');
      await retry.runOnce(new Date(Date.now() + 60_000));

      const after = await detail(request.id);

      expect(after.status).toBe('APPROVED');
      expect(after.commands).toHaveLength(1);
      expect(after.commands?.[0]?.status).toBe('DUPLICATE');
      expect(duplicateMetric(await metrics())).toBe(duplicateMetric(before) + 1);
      expect(coreCalls).toHaveLength(2);
    });

    it('retry yang habis memarkir command FAILED tanpa mengubah status permohonan', async () => {
      responder = () => ({ status: 500, body: rejectedBody('core_error', 'Core sedang gangguan.') });

      const before = await metrics();
      const ingested = await ingest({ reference: 'IZN-2026-125' }).expect(201);
      const request = ingested.body as ApprovalRequestBody;

      await reply('SETUJU 2 HARI IZN-2026-125', 'wamid-e2e-125');
      await retry.runOnce(new Date(Date.now() + 60_000));

      const exhausted = await detail(request.id);
      const [command] = exhausted.commands ?? [];

      expect(command?.status).toBe('FAILED');
      expect(command?.attempts).toBe(MAX_ATTEMPTS);
      expect(command?.nextAttemptAt).toBeNull();
      expect(exhausted.status).toBe('PROCESSING');
      expect(failedMetric(await metrics())).toBe(failedMetric(before) + 1);

      const callsAfterExhaustion = coreCalls.length;

      await retry.runOnce(new Date(Date.now() + 120_000));

      expect(coreCalls).toHaveLength(callsAfterExhaustion);
      expect((await detail(request.id)).commands?.[0]?.status).toBe('FAILED');
    });

    it('memulihkan command PENDING yang ditinggal proses mati setelah lease habis', async () => {
      const ingested = await ingest({ reference: 'IZN-2026-126' }).expect(201);
      const request = ingested.body as ApprovalRequestBody;
      const commandId = randomUUID();

      // Keadaan yang ditinggalkan proses yang mati antara menyimpan command dan mengirimnya.
      await commands.save(
        commands.create({
          commandId,
          approvalRequestId: request.id,
          externalMessageId: 'wamid-e2e-126',
          decision: 'approved',
          durationDays: 2,
          status: 'PENDING',
          attempts: 0,
          nextAttemptAt: new Date(Date.now() - 1_000),
        }),
      );

      await retry.runOnce();

      expect(coreCalls).toHaveLength(1);
      expect(coreCalls[0].body.command_id).toBe(commandId);

      const recovered = await detail(request.id);

      expect(recovered.status).toBe('APPROVED');
      expect(recovered.commands?.[0]).toMatchObject({ commandId, status: 'APPLIED', attempts: 1 });
    });
  });

  describe('D. Observability', () => {
    it('metrik mengikuti transisi aktual tanpa penghitungan ganda', async () => {
      const before = await metrics();

      const ingested = await ingest({ reference: 'IZN-2026-131' }).expect(201);
      const request = ingested.body as ApprovalRequestBody;

      await reply('SETUJU 2 HARI IZN-2026-131', 'wamid-e2e-131');

      const after = await metrics();

      expect(appliedMetric(after)).toBe(appliedMetric(before) + 1);
      expect(unknownMetric(after)).toBe(unknownMetric(before));
      expect(failedMetric(after)).toBe(failedMetric(before));
      expect(rejectedMetric(after)).toBe(rejectedMetric(before));
      expect((await detail(request.id)).commands).toHaveLength(1);
    });

    it('mencatat notifikasi yang dilewati ketika belum ada sesi WhatsApp', async () => {
      const before = await metrics();

      const ingested = await ingest({ reference: 'IZN-2026-132', notify: true }).expect(201);
      const request = ingested.body as ApprovalRequestBody;

      await supertest(app.getHttpServer())
        .post(`/api/approval/requests/${request.id}/notify`)
        .set('x-api-key', adminKey)
        .expect(201);

      const after = await metrics();

      expect(metricValue(after, notificationMetric('skipped'))).toBe(
        metricValue(before, notificationMetric('skipped')) + 2,
      );
      expect(metricValue(after, notificationMetric('failed'))).toBe(metricValue(before, notificationMetric('failed')));
    });

    it('menautkan balasan yang mengutip pesan notifikasi, lewat event message:sent yang sesungguhnya', async () => {
      const ingested = await ingest({
        reference: 'IZN-2026-140',
        sessionId: 'e2e-session',
        notify: false,
      }).expect(201);
      const request = ingested.body as ApprovalRequestBody;

      // What the gateway dispatches when it records a message this process just sent: the chain runs
      // the approval hook on `message:sent`, which links the notification id to the permit.
      const notificationText = `*Persetujuan Izin Santri*\n\nReferensi: IZN-2026-140\n\nBalas:\nSETUJU <jumlah hari> HARI IZN-2026-140`;
      await hooks.execute(
        'message:sent',
        { id: 'wamid.NOTIF-OUT-140', chatId: `${TARGET_NUMBER}@c.us`, body: notificationText, fromMe: true },
        { sessionId: 'e2e-session', source: 'Engine' },
      );

      const stored = await requests.findOneByOrFail({ id: request.id });
      expect(stored.notificationMessageId).toBe('wamid.NOTIF-OUT-140');

      // The reply quotes the notification and names no reference of its own.
      await hooks.execute(
        'message:received',
        {
          id: 'wamid.REPLY-140',
          from: `${TARGET_NUMBER}@s.whatsapp.net`,
          chatId: `${TARGET_NUMBER}@c.us`,
          body: 'SETUJU 2 HARI',
          isGroup: false,
          fromMe: false,
          quotedMessage: { id: 'wamid.NOTIF-OUT-140' },
        },
        { sessionId: 'e2e-session', source: 'Engine' },
      );

      const [command] = await commands.find({ where: { approvalRequestId: request.id } });
      expect(command).toBeDefined();
      expect(command.decision).toBe('approved');
      expect(command.durationDays).toBe(2);
      expect(coreCalls.some(call => call.body.command_id === command.commandId)).toBe(true);
      expect((await requests.findOneByOrFail({ id: request.id })).status).toBe('APPROVED');
    });

    it('label metrik approval hanya berisi nilai dari himpunan tetap, tanpa PII', async () => {
      const text = await metrics();
      const labels = text
        .split('\n')
        .filter(line => line.startsWith('openwa_approval_') && line.includes('{'))
        .flatMap(line => [...line.matchAll(/="([^"]*)"/g)].map(match => match[1]));

      expect(labels.length).toBeGreaterThan(0);
      for (const value of labels) {
        expect(value).toMatch(/^[a-z_]+$/);
      }
    });
  });

  /**
   * Runs only when the process was pointed at a real Core (`ALIM_CORE_BASE_URL` plus the approval
   * key set before this file loads). With no Core there is nothing to prove, so it skips instead of
   * pretending: the mock sections above are the contract evidence until staging exists.
   *
   * It sends one permit and one WhatsApp reply through the ordinary routes, then reports what Core
   * actually answered. `outcome: 'unavailable'` is a FAIL, not a skip — reaching this test means the
   * operator asked for a real run, and an unreachable Core is the thing being tested.
   */
  describe('Z. ALIM Core sungguhan', () => {
    const direct = (): HttpAlimCoreApprovalClient => app.get<HttpAlimCoreApprovalClient>(HttpAlimCoreApprovalClient);
    const baseUrl = operatorCoreBaseUrl;
    const approvalKey = operatorApprovalKey;
    // A PERMIT for a nil UUID in a person's name is legal in Core's domain; a probe command is not.
    // But Core resolves the REPLIER to a person it can name, so this section needs a staging actor
    // Core mapped and verified — otherwise Core correctly answers 403 actor_identity_unmapped.
    const targetCorePersonId =
      (process.env.ALIM_CONNECT_STAGING_ACTOR_CORE_USER ?? '').trim() || '00000000-0000-4000-8000-000000000003';
    // Identity used only by this section, so suite B's mapping of TARGET_NUMBER cannot repoint it.
    const ACTOR_NUMBER = (process.env.ALIM_CONNECT_STAGING_ACTOR_NUMBER ?? '').trim();
    // A number Core cannot have mapped, built from the actor's own so it keeps the same country and
    // length while differing in its last digit. The actor check needs it to show that Core answers
    // `actor_identity_unmapped` for an unknown number — without that contrast, a refusal of the mapped
    // actor would look the same as a misconfigured key.
    const ACTOR_JID = ACTOR_NUMBER === '' ? '' : `${ACTOR_NUMBER}@s.whatsapp.net`;
    const UNMAPPED_ACTOR_NUMBER =
      ACTOR_NUMBER.length >= 8 ? `${ACTOR_NUMBER.slice(0, -1)}${ACTOR_NUMBER.endsWith('7') ? '8' : '7'}` : '';
    // Connect normalises what Core sends (`0812…`, `+62 812…`, `62812…@s.whatsapp.net` all become the
    // E.164 digits without `+`), so a value in any of those forms would still be sent as digits — but a
    // value it cannot normalise (`''`, a word) would silently become `''` and fail at Core, weeks later.
    // Reported here instead of asserted, so the run still ends with the failure Core itself gives.
    const actorNumberProblem = /^[1-9][0-9]{7,14}$/.test(ACTOR_NUMBER)
      ? ''
      : ACTOR_NUMBER === ''
        ? ''
        : `ALIM_CONNECT_STAGING_ACTOR_NUMBER is not E.164 digits (8–15, no "+"): it would be sent as "${ACTOR_NUMBER.replace(/[^0-9]/g, '')}"`;
    // Tanpa aktor staging, bagian ini hanya membuktikan penolakan Core; bukti nyata butuh orang
    // yang benar-benar dipetakan dan diverifikasi di Core.
    const real =
      baseUrl !== '' &&
      approvalKey !== '' &&
      ACTOR_NUMBER !== '' &&
      targetCorePersonId !== '00000000-0000-4000-8000-000000000003';

    if (real && actorNumberProblem !== '') console.log(`[real-core] ${actorNumberProblem}`);

    (real ? it : it.skip)(
      'mengirim satu command dan mencatat jawaban Core yang sebenarnya',
      async () => {
        // Arahkan aplikasi yang SUDAH berjalan ke Core sungguhan. `beforeAll` menimpa
        // `ALIM_CORE_BASE_URL` dengan alamat mock SEBELUM AppModule dimuat, jadi ConfigService memegang
        // alamat mock: tanpa baris ini, bagian ini tetap menembak mock lalu melaporkan APPLIED.
        app.get(ConfigService).set('connect.approval.coreBaseUrl', baseUrl);
        app.get(ConfigService).set('connect.approval.coreApiKey', approvalKey);

        // Referensi harus berbentuk `PREFIX-TAHUN-NOMOR` agar parser mengenalinya sebagai referensi.
        const marker = `IZN-2026-${randomUUID().replace(/\D/g, '').slice(0, 8)}`;
        coreCalls = [];

        // Lokal dan idempoten: pemetaan ulang yang sah (suite B memetakan nomor yang sama ke
        // personel lain) tidak boleh membuat section ini gagal, jadi `reassign` dikirim eksplisit.
        await supertest(app.getHttpServer())
          .post('/api/approval/identities')
          .set('x-api-key', adminKey)
          .send({
            externalIdentity: ACTOR_NUMBER,
            corePersonId: targetCorePersonId,
            displayName: 'Probe staging',
            isVerified: true,
            reassign: true,
          })
          .expect(res => {
            if (res.status !== 200 && res.status !== 201) {
              throw new Error(`identity mapping rejected: ${res.status} ${JSON.stringify(res.body)}`);
            }
          });

        const ingested = await ingestApproval({
          coreRequestId: randomUUID(),
          reference: marker,
          requestedDurationDays: 1,
          targetCorePersonId: targetCorePersonId,
          // Pengirim balasan harus orang yang dituju (processor memeriksa `sender.corePersonId`
          // terhadap target), jadi permohonan ini ditujukan ke aktor staging itu sendiri.
          targetIdentity: ACTOR_NUMBER,
          notify: false,
        }).expect(201);
        const request = ingested.body as ApprovalRequestBody;
        // Lokal: identitas pengirim harus terverifikasi, dan itulah yang diperiksa processor.
        const identity = await app
          .get<Repository<WhatsAppIdentity>>(getRepositoryToken(WhatsAppIdentity, 'data'))
          .findOne({ where: { externalIdentity: ACTOR_NUMBER } });

        // Pemetaan identitas bersifat global (`UQ_whatsapp_identities_external`), jadi nomor uji
        // dapat saja masih terpetakan ke personel lain dari suite B. Deskripsi publik sengaja
        // menyembunyikan `targetCorePersonId`, sehingga yang diperiksa adalah databasenya.
        const stored = await app
          .get<Repository<ApprovalRequest>>(getRepositoryToken(ApprovalRequest, 'data'))
          .findOne({ where: { id: request.id } });

        expect(identity).not.toBeNull();
        expect(stored?.targetCorePersonId).toBe(identity?.corePersonId);

        // Referensi pada teks balasan harus menyebut `reference` yang benar-benar di-ingest; coretan
        // lama memakai `IZN-2026-…` sehingga balasannya tidak pernah dikenali sebagai keputusan.
        // The reply comes from the actor's own number: a reply from anyone else is refused as
        // `not_authorized` before Core is called, and proves nothing about Core's mapping of the actor.
        await replyFrom(ACTOR_JID, `SETUJU 1 HARI ${request.reference}`, `wamid-real-${randomUUID()}`);

        // What ALIM recorded went up the loopback recorder: this command reached the mock, not Core.
        const misrouted = coreCalls.filter(call => call.body?.command_id);
        if (misrouted.length > 0) {
          throw new Error(
            `${misrouted.length} approval command(s) went to the loopback mock, not Core: ` +
              `the real section would report what the mock said`,
          );
        }

        // The reply hook stores the command and then calls Core; it does not wait for Core's answer. A
        // real Core is fast enough to make an immediate read look settled, but not reliably so, and a
        // read that sees PENDING_APPROVAL with no command says nothing about whether Core approved.
        const after = await waitForCommand(request.id);

        if ((after.commands?.length ?? 0) === 0) {
          // The reply produced no command: reported with what a direct command with the same actor
          // answers, so a permit restriction and an unmapped actor do not print the same line.
          const probe = await direct().sendApprovalCommand({
            commandId: randomUUID(),
            requestId: '00000000-0000-4000-8000-000000000000',
            decision: 'approved',
            approvedDurationDays: 1,
            actorExternalId: ACTOR_NUMBER,
            actorCorePersonId: targetCorePersonId,
            source: 'whatsapp',
            externalMessageId: `diag-${randomUUID()}`,
            messageText: 'DIAG',
            notes: null,
          });
          throw new Error(
            `no command was created: request status ${after.status} (coreStatus ${after.coreStatus}) did not produce one; ` +
              `a direct command with the same actor and no permit answered ${probe.httpStatus} ${probe.code ?? ''} (${probe.outcome})`,
          );
        }

        // Every command this section sends must carry the actor's number and the permit's person, and its
        // idempotency key must be the command id — readable for the mock sections, asserted here for the
        // command Connect built for a real reply.
        const actorTrails = (
          await app.get<Repository<AuditLog>>(getRepositoryToken(AuditLog, 'main')).find({
            where: { action: AuditAction.APPROVAL_COMMAND },
            order: { createdAt: 'DESC' },
            take: 20,
          })
        ).filter(row => row.metadata?.coreRequestId === request.coreRequestId);
        expect(actorTrails).toHaveLength(1);
        expect(JSON.stringify(actorTrails[0].metadata)).not.toContain(ACTOR_NUMBER);
        const actorStored = (
          await app.get<Repository<ApprovalCommand>>(getRepositoryToken(ApprovalCommand, 'data')).find({
            where: { approvalRequestId: request.id },
          })
        )[0];
        expect(actorStored?.commandId).toMatch(/^[0-9a-f-]{36}$/);
        expect(actorStored?.decision).toBe('approved');
        expect(actorStored?.status).toMatch(/^(PENDING|UNKNOWN|APPLIED|DUPLICATE|REJECTED|FAILED)$/);

        const command = (await waitForCommand(request.id)).commands?.find(c => c.commandId === actorStored?.commandId);

        if (!command) return; // no settled command: the error above already reported why
        const verdict = await waitForCommand(request.id);

        // Printed so the operator has a verbatim record; none of it is a credential or a permit body.
        console.log(
          '[real-core] approval command ' +
            JSON.stringify({
              commandId: command.commandId,
              status: command.status,
              attempts: command.attempts,
              coreResponseCode: command.coreResponseCode,
              errorCode: command.errorCode,
              requestStatus: verdict.status,
              coreStatus: verdict.coreStatus,
            }),
        );

        if (command.status === 'REJECTED' || command.status === 'FAILED') {
          return; // Core refused: reported above, and there is no earlier decision to check against
        }

        expect([200, 201, 202]).toContain(command.coreResponseCode);
        expect(['APPLIED', 'DUPLICATE']).toContain(command.status);
        expect(verdict.status).toBe('APPROVED');
        // Core's own verdict for the permit, not ALIM's starting value: `pending` here means the read
        // ran before Core answered, which the wait above should have made impossible.
        expect(verdict.coreStatus).not.toBe('pending');

        // A second reply for a decision already settled must not become a second command — from the
        // same number, which is the only sender the reply path accepts for this permit.
        const before = (await detail(request.id)).commands?.length ?? 0;
        await replyFrom(ACTOR_JID, `SETUJU 1 HARI ${request.reference}`, `wamid-real-again-${randomUUID()}`);
        expect((await detail(request.id)).commands?.length ?? 0).toBe(before);

        // Retry path against Core. The suite's own policy (400 ms timeout, 2 attempts) is reused on
        // purpose: a temporary env override here would also apply to the mock sections above, because
        // config is read once at module load.
        //
        // What Core answers a replay is not assumed, because two behaviours are both correct: a replay
        // of the same command id is a `duplicate` (the same answer, not a second decision), and a permit
        // already settled may be refused as a business result. What must hold either way is checked
        // below and in the verbatim line printed above.
        const sent = command.attempts;
        const now = new Date();
        await commands.update(
          { commandId: command.commandId },
          { status: 'UNKNOWN', nextAttemptAt: null, lastAttemptAt: now },
        );

        const stats = await retry.runOnce(new Date(now.getTime() + 1_000));

        console.log('[real-core] approval retry ' + JSON.stringify(stats));

        const replayed = (await detail(request.id)).commands?.find(c => c.commandId === command.commandId);

        const final = await detail(request.id);

        expect(replayed?.attempts ?? 0).toBe(sent + 1);
        expect(['APPLIED', 'DUPLICATE', 'REJECTED', 'FAILED']).toContain(replayed?.status);
        // Whatever Core answered the second time, it never became a second decision in Connect.
        expect(final.status).toBe('APPROVED');
        expect(final.commands).toHaveLength(before);

        // The permit's state as Core reports it, printed for the operator's own Core-side check (the
        // audit row is read there, since Connect has no endpoint into Core's audit log).
        console.log(
          '[real-core] permit after replay ' +
            JSON.stringify({
              requestStatus: final.status,
              coreStatus: final.coreStatus,
              commandStatus: replayed?.status,
            }),
        );
      },
      60_000,
    );

    (real && actorNumberProblem === '' ? it : it.skip)(
      'menolak aktor yang tidak dikenali Core, dan membuktikan yang terpetakan diterima',
      async () => {
        app.get(ConfigService).set('connect.approval.coreBaseUrl', baseUrl);
        app.get(ConfigService).set('connect.approval.coreApiKey', approvalKey);
        const client = direct();
        const base = {
          decision: 'approved' as const,
          approvedDurationDays: 1,
          source: 'whatsapp' as const,
          notes: null,
          requestId: '00000000-0000-4000-8000-000000000000',
        };
        // Neither command names a permit, so neither can apply a decision whatever Core answers; the
        // only thing read here is which actor Core accepts.
        const unmapped = await client.sendApprovalCommand({
          ...base,
          commandId: randomUUID(),
          actorExternalId: UNMAPPED_ACTOR_NUMBER,
          actorCorePersonId: null,
          externalMessageId: `actor-probe-unmapped-${randomUUID()}`,
          messageText: 'PROBE, unmapped actor — must not be applied',
        });
        expect(unmapped.outcome).toBe('rejected');
        expect(unmapped.code).toBe('actor_identity_unmapped');

        const mapped = await client.sendApprovalCommand({
          ...base,
          commandId: randomUUID(),
          actorExternalId: ACTOR_NUMBER,
          actorCorePersonId: targetCorePersonId,
          externalMessageId: `actor-probe-mapped-${randomUUID()}`,
          messageText: 'PROBE, mapped actor — must not be applied',
        });
        console.log(
          '[real-core] actor check ' +
            JSON.stringify({
              unmapped: { outcome: unmapped.outcome, httpStatus: unmapped.httpStatus, code: unmapped.code },
              mapped: { outcome: mapped.outcome, httpStatus: mapped.httpStatus, code: mapped.code },
            }),
        );
        // A mapped, authorised Head of Dormitory gets past the actor: Core then refuses the permit that
        // does not exist, which is the answer that proves the actor was recognised.
        expect(mapped.outcome).toBe('rejected');
        expect(mapped.httpStatus).toBe(404);
        expect(mapped.code ?? '').not.toMatch(/^actor_/);
      },
      60_000,
    );
  });
});
