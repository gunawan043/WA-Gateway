import type { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { SsoHandoffController } from './sso-handoff.controller';
import type { HandoffResult, SsoHandoffService } from './sso-handoff.service';

const CORE_ORIGIN = 'https://core.example.com';
const CODE = 'one-time-code-abc123';

interface FakeResponse {
  statusCode: number;
  contentType: string;
  body: string;
  headers: Record<string, string>;
  locals: Record<string, unknown>;
  status(code: number): FakeResponse;
  type(value: string): FakeResponse;
  send(value: string): FakeResponse;
  json(value: unknown): FakeResponse;
  setHeader(name: string, value: string): FakeResponse;
  getHeader(name: string): string | undefined;
  removeHeader(name: string): void;
}

function makeResponse(): FakeResponse {
  const res: FakeResponse = {
    statusCode: 0,
    contentType: '',
    body: '',
    headers: {},
    locals: {},
    status(code) {
      res.statusCode = code;
      return res;
    },
    type(value) {
      res.contentType = value;
      return res;
    },
    send(value) {
      res.body = value;
      return res;
    },
    json(value) {
      res.body = JSON.stringify(value);
      return res;
    },
    setHeader(name, value) {
      res.headers[name] = value;
      return res;
    },
    getHeader(name) {
      return res.headers[name];
    },
    removeHeader(name) {
      delete res.headers[name];
    },
  };
  return res;
}

function makeRequest(
  overrides: { origin?: string; referer?: string; accept?: string; userAgent?: string } = {},
): Request {
  const headers: Record<string, string | undefined> = {
    accept: overrides.accept ?? 'text/html',
  };
  if (overrides.origin !== undefined) headers.origin = overrides.origin;
  if (overrides.referer !== undefined) headers.referer = overrides.referer;
  if (overrides.userAgent !== undefined) headers['user-agent'] = overrides.userAgent;
  return { headers, socket: { remoteAddress: '203.0.113.9' } } as unknown as Request;
}

function makeController(options: { configured?: boolean; coreOrigin?: string | null } = {}) {
  const configured = options.configured ?? true;
  const values: Record<string, unknown> = {
    'connect.sso.coreWebOrigin': options.coreOrigin === undefined ? CORE_ORIGIN : options.coreOrigin,
    'connect.sso.coreBaseUrl': configured ? 'https://core.example.com' : '',
    'connect.sso.apiKey': configured ? 'test-key' : '',
    'security.trustedProxies': [],
  };
  const config = { get: (key: string) => values[key] } as unknown as ConfigService;

  const complete = jest.fn<Promise<HandoffResult>, [unknown]>();
  complete.mockResolvedValue({
    ok: true,
    token: 'session-token-xyz',
    sessionId: 'sess-9',
    userId: 'user-7',
    expiresAt: '2026-11-24T00:00:00.000Z',
  });
  const handoff = { complete } as unknown as SsoHandoffService;

  return { controller: new SsoHandoffController(handoff, config), complete };
}

describe('SsoHandoffController.loading', () => {
  it('serves the loading document with no-store, no-referrer and no-index headers', () => {
    const { controller } = makeController();
    const res = makeResponse();

    controller.loading(res as unknown as Response);

    expect(res.statusCode).toBe(200);
    expect(res.contentType).toBe('html');
    expect(res.headers['Cache-Control']).toBe('no-store, max-age=0');
    expect(res.headers['Referrer-Policy']).toBe('no-referrer');
    expect(res.headers['X-Robots-Tag']).toBe('noindex, nofollow');
    // The loading page names the flow and holds nothing else: no token, no code, no Core URL.
    expect(res.body).toContain('ALIM Core');
    expect(res.body).not.toContain('owa_s1_');
    expect(res.body).toMatch(/nonce="[A-Za-z0-9_-]{16,}"/);
  });
});

// Embedding is the one thing this endpoint exists to make possible, and it must not be bought by
// weakening every other response: the handoff documents themselves are where the policy changes.
describe('SsoHandoffController.loading - framing policy', () => {
  const GLOBAL_CSP = "default-src 'self'; frame-ancestors 'self'; object-src 'none'";

  function withGlobalPolicy() {
    const res = makeResponse();
    res.setHeader('Content-Security-Policy', GLOBAL_CSP);
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    return res;
  }

  it('names the configured Core origin in frame-ancestors and drops X-Frame-Options', () => {
    const { controller } = makeController();
    const res = withGlobalPolicy();

    controller.loading(res as unknown as Response);

    expect(res.headers['Content-Security-Policy']).toContain("frame-ancestors 'self' https://core.example.com");
    expect(res.headers['Content-Security-Policy']).not.toBe(GLOBAL_CSP);
    expect(res.headers['X-Frame-Options']).toBeUndefined();
  });

  it('leaves the rest of the policy byte-identical', () => {
    const { controller } = makeController();
    const res = withGlobalPolicy();

    controller.loading(res as unknown as Response);

    const policy = res.headers['Content-Security-Policy'];
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("object-src 'none'");
  });

  it('relaxes nothing when no Core origin is configured', () => {
    const { controller } = makeController({ coreOrigin: null });
    const res = withGlobalPolicy();

    controller.loading(res as unknown as Response);

    expect(res.headers['Content-Security-Policy']).toBe(GLOBAL_CSP);
    expect(res.headers['X-Frame-Options']).toBe('SAMEORIGIN');
  });

  it('refuses to widen framing to a foreign origin the operator did not configure', () => {
    const { controller } = makeController({ coreOrigin: 'https://alim.example.org' });
    const res = withGlobalPolicy();

    controller.loading(res as unknown as Response);

    expect(res.headers['Content-Security-Policy']).not.toContain('alim.abuhurairah.id');
    expect(res.headers['Content-Security-Policy']).toContain('https://alim.example.org');
  });

  it('applies the same widening to the error document a refused handoff renders', async () => {
    const { controller } = makeController();
    const res = withGlobalPolicy();

    await controller.receive(
      { code: CODE } as never,
      makeRequest({ origin: 'https://evil.example' }),
      res as unknown as Response,
    );

    expect(res.statusCode).toBe(403);
    expect(res.headers['Content-Security-Policy']).toContain("frame-ancestors 'self' https://core.example.com");
    expect(res.headers['X-Frame-Options']).toBeUndefined();
  });
});

describe('SsoHandoffController.receive - configuration and origin', () => {
  it('answers 503 when the deployment has no Core origin, without calling Core', async () => {
    const { controller, complete } = makeController({ coreOrigin: null });
    const res = makeResponse();

    await controller.receive(
      { code: CODE },
      makeRequest({ origin: CORE_ORIGIN, accept: 'application/json' }),
      res as unknown as Response,
    );

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, code: 'not_configured' });
    expect(complete).not.toHaveBeenCalled();
  });

  it('answers 503 when the key is missing even though an origin is configured', async () => {
    const { controller, complete } = makeController({ configured: false });
    const res = makeResponse();

    await controller.receive(
      { code: CODE },
      makeRequest({ origin: CORE_ORIGIN, accept: 'application/json' }),
      res as unknown as Response,
    );

    expect(res.statusCode).toBe(503);
    expect(complete).not.toHaveBeenCalled();
  });

  it('refuses a request with neither Origin nor Referer as origin_required', async () => {
    const { controller, complete } = makeController();
    const res = makeResponse();

    await controller.receive({ code: CODE }, makeRequest(), res as unknown as Response);

    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('ALIM Core');
    expect(complete).not.toHaveBeenCalled();
  });

  it('refuses a foreign origin before Core is called', async () => {
    const { controller, complete } = makeController();
    const res = makeResponse();

    await controller.receive(
      { code: CODE },
      makeRequest({ origin: 'https://evil.example.com', accept: 'application/json' }),
      res as unknown as Response,
    );

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, code: 'origin_not_allowed' });
    expect(complete).not.toHaveBeenCalled();
  });

  it('accepts the Referer origin when a client strips Origin', async () => {
    const { controller, complete } = makeController();
    const res = makeResponse();

    await controller.receive(
      { code: CODE },
      makeRequest({ referer: `${CORE_ORIGIN}/dashboard/permits` }),
      res as unknown as Response,
    );

    expect(complete).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });
});

describe('SsoHandoffController.receive - a request with no code', () => {
  // The field used to be required, so the global validation pipe answered a bare "Bad Request"
  // before the handler ran. A frame reload or an empty form submit is ordinary, and the person on the
  // other side needs to be told the flow starts from Core.
  it('answers code_required instead of a bare validation error, without calling Core', async () => {
    const { controller, complete } = makeController();
    const res = makeResponse();

    await controller.receive({} as never, makeRequest({ origin: CORE_ORIGIN }), res as unknown as Response);

    expect(res.statusCode).toBe(422);
    expect(complete).not.toHaveBeenCalled();
    expect(res.body).toContain('ALIM Core');
  });

  it('treats a whitespace-only code as absent', async () => {
    const { controller, complete } = makeController();
    const res = makeResponse();

    await controller.receive(
      { code: '   ' } as never,
      makeRequest({ origin: CORE_ORIGIN }),
      res as unknown as Response,
    );

    expect(res.statusCode).toBe(422);
    expect(complete).not.toHaveBeenCalled();
  });

  it('gives a JSON caller the code_required reason', async () => {
    const { controller } = makeController();
    const res = makeResponse();

    await controller.receive(
      {} as never,
      makeRequest({ origin: CORE_ORIGIN, accept: 'application/json' }),
      res as unknown as Response,
    );

    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).code).toBe('code_required');
  });
});

describe('SsoHandoffController.receive - success', () => {
  it('exchanges the code with the client IP and user agent, then renders the success page', async () => {
    const { controller, complete } = makeController();
    const res = makeResponse();

    await controller.receive(
      { code: CODE, state: 'state-1' },
      makeRequest({ origin: CORE_ORIGIN, userAgent: 'Mozilla/5.0 test' }),
      res as unknown as Response,
    );

    expect(complete).toHaveBeenCalledWith({
      code: CODE,
      state: 'state-1',
      ipAddress: '203.0.113.9',
      userAgent: 'Mozilla/5.0 test',
    });
    expect(res.statusCode).toBe(200);
    expect(res.contentType).toBe('html');
    expect(res.headers['Cache-Control']).toBe('no-store, max-age=0');
  });

  it('never puts the code in the page it returns', async () => {
    const { controller } = makeController();
    const res = makeResponse();

    await controller.receive({ code: CODE }, makeRequest({ origin: CORE_ORIGIN }), res as unknown as Response);

    expect(res.body).not.toContain(CODE);
  });

  it('gives a JSON caller the outcome but not the session token', async () => {
    const { controller } = makeController();
    const res = makeResponse();

    await controller.receive(
      { code: CODE },
      makeRequest({ origin: CORE_ORIGIN, accept: 'application/json' }),
      res as unknown as Response,
    );

    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body).toEqual({ ok: true, userId: 'user-7', expiresAt: '2026-11-24T00:00:00.000Z' });
    expect(res.body).not.toContain('session-token-xyz');
  });
});

describe('SsoHandoffController.receive - failures map to the documented status', () => {
  it.each([
    ['code_required', 422],
    ['code_not_found', 400],
    ['code_already_used', 409],
    ['code_expired', 410],
    ['audience_mismatch', 403],
    ['scope_mismatch', 403],
    ['permission_revoked', 403],
    ['user_inactive', 403],
    ['identity_not_mapped', 403],
    ['account_disabled', 403],
    ['invalid_key', 502],
    ['insufficient_scope', 502],
    ['contract_mismatch', 502],
    ['core_error', 502],
    ['core_unreachable', 502],
    ['core_timeout', 504],
    ['session_issue_failed', 500],
  ])('answers %s as HTTP %i', async (reason, status) => {
    const { controller, complete } = makeController();
    complete.mockResolvedValue({ ok: false, reason, message: 'ditolak' } as HandoffResult);
    const res = makeResponse();

    await controller.receive(
      { code: CODE },
      makeRequest({ origin: CORE_ORIGIN, accept: 'application/json' }),
      res as unknown as Response,
    );

    expect(res.statusCode).toBe(status);
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, code: reason });
  });

  it('renders an error page, not JSON, for a browser navigation', async () => {
    const { controller, complete } = makeController();
    complete.mockResolvedValue({ ok: false, reason: 'code_expired', message: 'Kode handoff sudah kedaluwarsa.' });
    const res = makeResponse();

    await controller.receive({ code: CODE }, makeRequest({ origin: CORE_ORIGIN }), res as unknown as Response);

    expect(res.statusCode).toBe(410);
    expect(res.contentType).toBe('html');
    expect(res.headers['X-Robots-Tag']).toBe('noindex, nofollow');
    expect(res.body).not.toContain(CODE);
  });

  it('treats an Accept that allows HTML as a browser even when it lists JSON', async () => {
    const { controller, complete } = makeController();
    complete.mockResolvedValue({ ok: false, reason: 'code_not_found', message: 'tidak dikenali' });
    const res = makeResponse();

    await controller.receive(
      { code: CODE },
      makeRequest({ origin: CORE_ORIGIN, accept: 'application/json, text/html;q=0.9' }),
      res as unknown as Response,
    );

    expect(res.contentType).toBe('html');
  });
});
