import { HttpAlimCoreApprovalClient } from './http-alim-core-approval.client';
import type { CoreApprovalCommand } from './alim-core-approval.client';

/**
 * The HTTP client is where a Core answer becomes an outcome Connect may act on. The mapping is
 * the safety boundary: only a 2xx with `success !== false` may be treated as applied, a replay
 * must be recognised as `duplicate`, a business 4xx must never be retried, and a timeout must
 * leave the decision UNKNOWN (`unavailable`) rather than guess either way.
 */
describe('HttpAlimCoreApprovalClient', () => {
  const command: CoreApprovalCommand = {
    commandId: 'cmd-1',
    requestId: 'req-1',
    decision: 'approved',
    approvedDurationDays: 2,
    actorExternalId: '628111222333',
    actorCorePersonId: 'person-1',
    source: 'whatsapp',
    externalMessageId: 'wamid.IN',
    messageText: 'SETUJU 2 HARI IZN-2026-00125',
    notes: null,
  };

  const settings: Record<string, unknown> = {
    'connect.approval.coreBaseUrl': 'https://core.test',
    'connect.approval.coreApiKey': 'secret-key',
    'connect.approval.coreApiHeader': 'X-ALIM-CONNECT-APPROVAL-KEY',
    'connect.approval.apiVersion': '1',
    'connect.approval.timeoutMs': 5000,
  };

  const client = (overrides: Record<string, unknown> = {}): HttpAlimCoreApprovalClient =>
    new HttpAlimCoreApprovalClient({
      get: (key: string, fallback?: unknown) => (key in overrides ? overrides[key] : (settings[key] ?? fallback)),
    } as never);

  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('menolak memanggil Core bila belum dikonfigurasi', async () => {
    const result = await client({ 'connect.approval.coreBaseUrl': '' }).sendApprovalCommand(command);

    expect(result.outcome).toBe('unavailable');
    expect(result.code).toBe('core_not_configured');
    expect(result.retryable).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('mengirim body snake_case dan header key ke endpoint kontrak', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      json: jest.fn().mockResolvedValue({ success: true, data: { outcome: 'applied', status: 'approved' } }),
    });

    await client().sendApprovalCommand(command);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://core.test/api/connect/v1/approval-commands');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-ALIM-CONNECT-APPROVAL-KEY']).toBe('secret-key');
    // `Idempotency-Key` harus sama dengan `command_id` di body: dua nilai berbeda berarti Core dapat
    // menerima satu command sebagai dua pengiriman, atau menolak replay yang sebenarnya sah.
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('cmd-1');
    expect((init.headers as Record<string, string>)['X-ALIM-API-Version']).toBe('1');
    expect(JSON.parse(init.body as string)).toMatchObject({
      command_id: 'cmd-1',
      request_id: 'req-1',
      decision: 'approved',
      approved_duration_days: 2,
      external_message_id: 'wamid.IN',
      source: 'whatsapp',
    });
  });

  it('tidak mengirim X-ALIM-API-Version bila versinya dikosongkan', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      json: jest.fn().mockResolvedValue({ success: true, data: { outcome: 'applied' } }),
    });

    await client({ 'connect.approval.apiVersion': '' }).sendApprovalCommand(command);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;

    expect(headers['Idempotency-Key']).toBe('cmd-1');
    expect(headers).not.toHaveProperty('X-ALIM-API-Version');
  });

  it('memetakan 200 applied menjadi keputusan yang diterapkan', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      json: jest.fn().mockResolvedValue({
        success: true,
        data: { outcome: 'applied', status: 'approved', expected_return_datetime: '2026-12-03T08:00:00Z' },
      }),
    });

    const result = await client().sendApprovalCommand(command);

    expect(result.outcome).toBe('applied');
    expect(result.decisionOutcome).toBe('applied');
    expect(result.coreStatus).toBe('approved');
    expect(result.expectedReturnAt).toBe('2026-12-03T08:00:00Z');
    expect(result.retryable).toBe(false);
  });

  it('memetakan 200 duplicate sebagai hasil pemulihan yang sah', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      json: jest.fn().mockResolvedValue({ success: true, data: { outcome: 'duplicate', status: 'approved' } }),
    });

    const result = await client().sendApprovalCommand(command);

    expect(result.outcome).toBe('duplicate');
    expect(result.retryable).toBe(false);
  });

  it.each([
    [401, 'invalid_api_key'],
    [403, 'actor_not_authorized'],
    [404, 'permit_not_found'],
    [409, 'permit_not_decidable'],
    [422, 'validation_failed'],
  ])('memetakan HTTP %i sebagai penolakan yang tidak boleh diulang', async (status, code) => {
    fetchMock.mockResolvedValue({
      status,
      json: jest.fn().mockResolvedValue({ success: false, message: 'ditolak', errors: { code } }),
    });

    const result = await client().sendApprovalCommand(command);

    expect(result.outcome).toBe('rejected');
    expect(result.code).toBe(code);
    expect(result.retryable).toBe(false);
  });

  it.each([429, 500, 503])('memetakan HTTP %i sebagai unavailable yang dapat diulang', async status => {
    fetchMock.mockResolvedValue({
      status,
      json: jest.fn().mockResolvedValue({ success: false, message: 'sibuk' }),
    });

    const result = await client().sendApprovalCommand(command);

    expect(result.outcome).toBe('unavailable');
    expect(result.retryable).toBe(true);
  });

  it('memperlakukan timeout sebagai status tidak diketahui, bukan penolakan', async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new TypeError('fetch failed')));
        }),
    );

    const result = await client({ 'connect.approval.timeoutMs': 5 }).sendApprovalCommand(command);

    expect(result.outcome).toBe('unavailable');
    expect(result.code).toBe('core_timeout');
    expect(result.httpStatus).toBe(504);
    expect(result.retryable).toBe(true);
  });

  it('memetakan kegagalan jaringan sebagai unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const result = await client().sendApprovalCommand(command);

    expect(result.outcome).toBe('unavailable');
    expect(result.code).toBe('core_unreachable');
    expect(result.httpStatus).toBe(0);
    expect(result.retryable).toBe(true);
  });

  it('menangani body yang bukan JSON tanpa melempar', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      json: jest.fn().mockRejectedValue(new SyntaxError('not json')),
    });

    const result = await client().sendApprovalCommand(command);

    expect(result.outcome).toBe('applied');
    expect(result.raw).toBeNull();
  });
});
