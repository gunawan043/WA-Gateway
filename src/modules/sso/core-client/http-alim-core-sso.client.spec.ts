import { ConfigService } from '@nestjs/config';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { HttpAlimCoreSsoClient } from './http-alim-core-sso.client';

interface Reply {
  status: number;
  body: unknown;
  delayMs?: number;
  headers?: Record<string, string>;
}

interface Call {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

const KEY = 'unit-sso-key';
const CODE = 'unit-handoff-code';

function configFor(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    'connect.sso.coreBaseUrl': 'http://127.0.0.1:1',
    'connect.sso.apiKey': KEY,
    'connect.sso.apiHeader': 'X-ALIM-CONNECT-SSO-KEY',
    'connect.sso.timeoutMs': 500,
    'connect.sso.audience': 'connect',
    'connect.sso.scope': 'whatsapp.embed',
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function listen(responder: (call: Call, res: ServerResponse) => void): Promise<{ server: Server; baseUrl: string }> {
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk as Buffer));
      req.on('end', () => {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        } catch {
          body = {};
        }
        responder({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body }, res);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

const json = (res: ServerResponse, reply: Reply): void => {
  const send = (): void => {
    res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
    res.end(JSON.stringify(reply.body));
  };
  if (reply.delayMs) setTimeout(send, reply.delayMs);
  else send();
};

describe('HttpAlimCoreSsoClient', () => {
  let server: Server | null = null;
  let baseUrl = '';
  let calls: Call[] = [];

  afterEach(async () => {
    if (server) {
      await new Promise<void>(resolve => server?.close(() => resolve()));
      server = null;
    }
    calls = [];
  });

  async function start(reply: Reply): Promise<HttpAlimCoreSsoClient> {
    const started = await listen((call, res) => {
      calls.push(call);
      json(res, reply);
    });
    server = started.server;
    baseUrl = started.baseUrl;
    return new HttpAlimCoreSsoClient(configFor({ 'connect.sso.coreBaseUrl': baseUrl }));
  }

  it('sends the contract body and the SSO key header, and parses a flat success response', async () => {
    const client = await start({
      status: 200,
      body: {
        core_user_id: 'core-1',
        name: 'Siti',
        email: 'siti@example.com',
        audience: 'connect',
        scope: 'whatsapp.embed',
        issued_at: '2026-11-23T10:00:00Z',
        redeemed_at: '2026-11-23T10:00:01Z',
      },
    });

    const result = await client.exchange({ code: CODE, state: 'state-1' });

    expect(result).toEqual({
      ok: true,
      identity: {
        coreUserId: 'core-1',
        name: 'Siti',
        email: 'siti@example.com',
        audience: 'connect',
        scope: 'whatsapp.embed',
        issuedAt: '2026-11-23T10:00:00Z',
        redeemedAt: '2026-11-23T10:00:01Z',
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].path).toBe('/api/connect/v1/sso/exchange');
    expect(calls[0].headers['x-alim-connect-sso-key']).toBe(KEY);
    expect(calls[0].body).toEqual({
      code: CODE,
      audience: 'connect',
      scope: 'whatsapp.embed',
      state: 'state-1',
    });
  });

  it('accepts the envelope shape Core uses on its other integration endpoints', async () => {
    const client = await start({
      status: 200,
      body: {
        success: true,
        message: 'ok',
        data: { core_user_id: 'core-2', audience: 'connect', scope: 'whatsapp.embed' },
        errors: null,
      },
    });

    const result = await client.exchange({ code: CODE });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.identity.coreUserId).toBe('core-2');
    expect(calls[0].body).toEqual({ code: CODE, audience: 'connect', scope: 'whatsapp.embed' });
  });

  it.each([
    [401, null, 'invalid_key'],
    [403, 'insufficient_scope', 'insufficient_scope'],
    [403, 'audience_mismatch', 'audience_mismatch'],
    [403, 'scope_mismatch', 'scope_mismatch'],
    [403, 'user_inactive', 'user_inactive'],
    [403, 'permission_revoked', 'permission_revoked'],
    [404, 'code_not_found', 'code_not_found'],
    [409, 'code_already_used', 'code_already_used'],
    [410, 'code_expired', 'code_expired'],
    [422, 'invalid_payload', 'invalid_payload'],
    [422, 'code_required', 'code_required'],
  ])('maps HTTP %i / %s to %s without retrying', async (status, code, reason) => {
    const client = await start({
      status,
      body: { success: false, message: 'refused', data: null, errors: code ? { code } : null },
    });

    const result = await client.exchange({ code: CODE });

    expect(result).toMatchObject({ ok: false, reason, httpStatus: status });
    // One-time code: a refusal is never retried.
    expect(calls).toHaveLength(1);
  });

  it('treats a 2xx with success:false as a failure, never a session', async () => {
    const client = await start({
      status: 200,
      body: { success: false, message: 'no', errors: { code: 'permission_revoked' } },
    });

    const result = await client.exchange({ code: CODE });

    expect(result).toMatchObject({ ok: false, reason: 'permission_revoked' });
  });

  it('refuses a response whose audience or scope does not match the request', async () => {
    const client = await start({
      status: 200,
      body: { core_user_id: 'core-3', audience: 'other-app', scope: 'whatsapp.embed' },
    });
    const audience = await client.exchange({ code: CODE });
    expect(audience).toMatchObject({ ok: false, reason: 'audience_mismatch' });

    await new Promise<void>(resolve => server?.close(() => resolve()));
    const second = await start({
      status: 200,
      body: { core_user_id: 'core-3', audience: 'connect', scope: 'other.scope' },
    });
    const scope = await second.exchange({ code: CODE });
    expect(scope).toMatchObject({ ok: false, reason: 'scope_mismatch' });
  });

  it('refuses a success response with no core_user_id', async () => {
    const client = await start({ status: 200, body: { audience: 'connect', scope: 'whatsapp.embed' } });

    const result = await client.exchange({ code: CODE });

    expect(result).toMatchObject({ ok: false, reason: 'contract_mismatch' });
  });

  it('reports a timeout as core_timeout, never as a success', async () => {
    await start({ status: 200, body: { core_user_id: 'core-4' }, delayMs: 300 });
    const fast = new HttpAlimCoreSsoClient(
      configFor({ 'connect.sso.coreBaseUrl': baseUrl, 'connect.sso.timeoutMs': 50 }),
    );

    const result = await fast.exchange({ code: CODE });

    expect(result).toMatchObject({ ok: false, reason: 'core_timeout', httpStatus: 504 });
  });

  it('reports an unreachable Core as core_unreachable', async () => {
    const probe = await listen((_call, res) => json(res, { status: 200, body: {} }));
    const deadPort = (probe.server.address() as AddressInfo).port;
    await new Promise<void>(resolve => probe.server.close(() => resolve()));

    const client = new HttpAlimCoreSsoClient(configFor({ 'connect.sso.coreBaseUrl': `http://127.0.0.1:${deadPort}` }));

    const result = await client.exchange({ code: CODE });

    expect(result).toMatchObject({ ok: false, reason: 'core_unreachable', httpStatus: 0 });
  });

  it('does not call Core at all when the integration is not configured', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const client = new HttpAlimCoreSsoClient(configFor({ 'connect.sso.apiKey': '' }));

    const result = await client.exchange({ code: CODE });

    expect(result).toMatchObject({ ok: false, reason: 'not_configured' });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
