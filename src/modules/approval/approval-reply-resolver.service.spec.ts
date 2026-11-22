import { randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { ApprovalReplyResolver } from './approval-reply-resolver.service';
import { ApprovalRequest } from './entities/approval-request.entity';
import { WhatsAppIdentity } from './entities/whatsapp-identity.entity';
import { WhatsAppIdentityService } from './whatsapp-identity.service';

/**
 * A short reply is only actionable when it can be tied to exactly one request. Every
 * ambiguous case must return `null` rather than the most recent request: guessing here would
 * approve the wrong permit.
 */
describe('ApprovalReplyResolver', () => {
  let ds: DataSource;
  let requests: Repository<ApprovalRequest>;
  let resolver: ApprovalReplyResolver;
  let seq: number;

  const SENDER = '628111222333';
  const OTHER = '628999888777';

  beforeAll(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [ApprovalRequest, WhatsAppIdentity],
      synchronize: true,
    });
    await ds.initialize();
  });

  afterAll(async () => {
    await ds.destroy();
  });

  beforeEach(async () => {
    await ds.getRepository(ApprovalRequest).clear();
    requests = ds.getRepository(ApprovalRequest);
    seq = 0;
    resolver = new ApprovalReplyResolver(requests, new WhatsAppIdentityService(ds.getRepository(WhatsAppIdentity)));
  });

  async function seed(overrides: Partial<ApprovalRequest> = {}): Promise<ApprovalRequest> {
    const n = ++seq;

    return requests.save(
      requests.create({
        coreRequestId: randomUUID(),
        reference: `IZN-2026-${String(n).padStart(5, '0')}`,
        studentName: 'Ahmad',
        permitType: 'pulang',
        status: 'PENDING_APPROVAL',
        targetIdentity: SENDER,
        sessionId: 'sess-1',
        notificationMessageId: `wamid.notif.${n}`,
        ...overrides,
      }),
    );
  }

  it('mengaitkan lewat reply ke pesan notifikasi', async () => {
    const request = await seed();

    const result = await resolver.resolve({
      sessionId: 'sess-1',
      senderIdentity: `${SENDER}@s.whatsapp.net`,
      quotedMessageId: request.notificationMessageId,
      reference: null,
    });

    expect(result.source).toBe('quoted');
    expect(result.request?.id).toBe(request.id);
  });

  it('jatuh ke referensi bila reply tidak cocok', async () => {
    const request = await seed();

    const result = await resolver.resolve({
      sessionId: 'sess-1',
      senderIdentity: SENDER,
      quotedMessageId: 'wamid.lain',
      reference: request.reference,
    });

    expect(result.source).toBe('reference');
    expect(result.request?.id).toBe(request.id);
  });

  it('tidak menebak bila referensi milik orang lain', async () => {
    const request = await seed({ targetIdentity: OTHER });

    const result = await resolver.resolve({
      sessionId: 'sess-1',
      senderIdentity: SENDER,
      quotedMessageId: null,
      reference: request.reference,
    });

    expect(result.request).toBeNull();
    expect(result.source).toBe('none');
  });

  it('memakai satu-satunya permohonan terbuka', async () => {
    const request = await seed();

    const result = await resolver.resolve({
      sessionId: 'sess-1',
      senderIdentity: SENDER,
      quotedMessageId: null,
      reference: null,
    });

    expect(result.source).toBe('single_pending');
    expect(result.request?.id).toBe(request.id);
  });

  it('menandai ambigu bila ada lebih dari satu permohonan terbuka', async () => {
    await seed();
    await seed();

    const result = await resolver.resolve({
      sessionId: 'sess-1',
      senderIdentity: SENDER,
      quotedMessageId: null,
      reference: null,
    });

    expect(result.request).toBeNull();
    expect(result.source).toBe('ambiguous');
    expect(result.openCount).toBe(2);
  });

  it('mengabaikan permohonan yang sudah final saat menghitung yang terbuka', async () => {
    await seed({ status: 'APPROVED' });
    const open = await seed();

    const result = await resolver.resolve({
      sessionId: 'sess-1',
      senderIdentity: SENDER,
      quotedMessageId: null,
      reference: null,
    });

    expect(result.source).toBe('single_pending');
    expect(result.request?.id).toBe(open.id);
  });

  it('mengembalikan none bila tidak ada permohonan terbuka', async () => {
    await seed({ status: 'REJECTED' });

    const result = await resolver.resolve({
      sessionId: 'sess-1',
      senderIdentity: SENDER,
      quotedMessageId: null,
      reference: null,
    });

    expect(result.request).toBeNull();
    expect(result.source).toBe('none');
  });

  it('tidak mencocokkan permohonan dari sesi lain', async () => {
    await seed({ sessionId: 'sess-2' });

    const result = await resolver.resolve({
      sessionId: 'sess-1',
      senderIdentity: SENDER,
      quotedMessageId: null,
      reference: null,
    });

    expect(result.request).toBeNull();
    expect(result.source).toBe('none');
  });

  it('mengembalikan none untuk identitas kosong', async () => {
    const result = await resolver.resolve({
      sessionId: 'sess-1',
      senderIdentity: '',
      quotedMessageId: null,
      reference: null,
    });

    expect(result.source).toBe('none');
  });
});
