import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { createServer, Server } from 'http';
import type { AddressInfo } from 'net';
import supertest from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { configureApp } from '../src/configure-app';
import { applyGlobalValidation } from '../src/config/app-validation';
import { ApiKeyRole } from '../src/modules/auth/entities/api-key.entity';
import { UserSession } from '../src/modules/auth/entities/user-session.entity';
import { UsersService } from '../src/modules/auth/users.service';

/**
 * The WhatsApp Connect SSO handoff over real HTTP, with a mock Core at the HTTP boundary.
 *
 * What this proves that a unit test cannot: the global guard chain and `/api` prefix, the
 * urlencoded body parser and the DTO pipe, the real `fetch` client (timeout included), the
 * `configureApp` stack (CSP nonce, the `/sso/handoff` alias), and — most importantly — that a
 * session row exists only after Core said yes.
 *
 * The mock Core implements the one-time-code semantics the contract describes: a code can be
 * redeemed once, an unknown code is 404, a redeemed one is 409. Tests that need a different
 * refusal replace the responder.
 */

const CORE_ORIGIN = 'https://core.e2e.test';
const SSO_KEY = 'e2e-sso-key';
const SSO_HEADER = 'x-alim-connect-sso-key';
const CORE_USER_ID = 'core-user-e2e-1';
const CORE_USER_EMAIL = 'sso-operator@example.com';

process.env.TRUSTED_PROXIES = '127.0.0.1';
process.env.ALIM_CORE_WEB_ORIGIN = CORE_ORIGIN;
process.env.ALIM_CONNECT_SSO_KEY = SSO_KEY;
process.env.ALIM_CONNECT_SSO_TIMEOUT_MS = '300';
process.env.AUTH_SESSION_IDLE_TIMEOUT_MINUTES = '5';
process.env.METRICS_TOKEN = 'e2e-metrics-token-0123456789abcdef';

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
  /** Drop the connection instead of answering, to exercise the unreachable path. */
  destroy?: boolean;
}

type CodeState = 'valid' | 'used' | 'expired';

interface CodeRecord {
  coreUserId: string;
  state: CodeState;
}

const successBody = (coreUserId: string): unknown => ({
  core_user_id: coreUserId,
  name: 'Operator SSO',
  email: CORE_USER_EMAIL,
  audience: 'connect',
  scope: 'whatsapp.embed',
  issued_at: '2026-11-23T10:00:00Z',
  redeemed_at: '2026-11-23T10:00:01Z',
});

const errorBody = (code: string, message = 'refused'): unknown => ({
  success: false,
  message,
  data: null,
  errors: { code },
});

describe('WhatsApp Connect SSO handoff over HTTP (e2e)', () => {
  let app: INestApplication<App>;
  let coreServer: Server;
  let coreBaseUrl: string;
  let coreCalls: CoreCall[] = [];
  let codes: Map<string, CodeRecord>;
  let responder: ((call: CoreCall) => MockReply) | null = null;

  let users: UsersService;
  let sessions: Repository<UserSession>;
  let userId: string;

  let ipCounter = 10;

  const nextIp = (): string => `10.10.0.${ipCounter++}`;

  const issueCode = (code: string, coreUserId = CORE_USER_ID, state: CodeState = 'valid'): void => {
    codes.set(code, { coreUserId, state });
  };

  const defaultResponder = (call: CoreCall): MockReply => {
    // Core checks its own key first. Connect must send the configured one and nothing from the
    // browser; a mismatch is a 401 exactly as the contract says.
    if (call.headers[SSO_HEADER] !== SSO_KEY) {
      return { status: 401, body: { success: false, message: 'invalid key', data: null, errors: null } };
    }

    const code = typeof call.body.code === 'string' ? call.body.code : '';
    if (code === '') return { status: 422, body: errorBody('code_required') };

    const record = codes.get(code);
    if (!record) return { status: 404, body: errorBody('code_not_found') };
    if (record.state === 'expired') return { status: 410, body: errorBody('code_expired') };
    if (record.state === 'used') return { status: 409, body: errorBody('code_already_used') };

    // Redeem atomically: the response may be delayed, but the code is spent now.
    record.state = 'used';
    return { status: 200, body: successBody(record.coreUserId) };
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
        const call: CoreCall = { path: req.url ?? '', method: req.method ?? '', headers: req.headers, body };
        coreCalls.push(call);

        const reply = (responder ?? defaultResponder)(call);
        if (reply.destroy) {
          res.destroy();
          return;
        }
        const send = (): void => {
          if (res.writableEnded || res.destroyed) return;
          res.writeHead(reply.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(reply.body));
        };
        if (reply.delayMs) setTimeout(send, reply.delayMs);
        else send();
      });
    });
    coreServer.on('clientError', () => undefined);
    await new Promise<void>(resolve => coreServer.listen(0, '127.0.0.1', resolve));
    coreBaseUrl = `http://127.0.0.1:${(coreServer.address() as AddressInfo).port}`;
  };

  const tokenFrom = (html: string): string => {
    const match = /sessionStorage\.setItem\('openwa_api_key', "([^"]+)"\)/.exec(html);
    if (!match) throw new Error('success page did not carry a session token');
    return match[1];
  };

  const postHandoff = (
    code: string,
    options: {
      origin?: string | null;
      accept?: string;
      ip?: string;
      path?: string;
      cookie?: string;
      state?: string;
    } = {},
  ) => {
    const origin = options.origin === undefined ? CORE_ORIGIN : options.origin;
    let request = supertest(app.getHttpServer())
      .post(options.path ?? '/api/sso/handoff')
      .set('X-Forwarded-For', options.ip ?? nextIp())
      .set('Accept', options.accept ?? 'text/html,application/xhtml+xml')
      .type('form');
    if (origin !== null) request = request.set('Origin', origin);
    if (options.cookie) request = request.set('Cookie', options.cookie);
    return request.send({ code, ...(options.state ? { state: options.state } : {}) });
  };

  const liveSessionCount = async (): Promise<number> => sessions.count({ where: { userId } });

  beforeAll(async () => {
    await startMockCore();
    process.env.ALIM_CORE_BASE_URL = coreBaseUrl;

    // Loaded here, not at the top: ConfigModule reads process.env when the module is evaluated.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppModule } = require('../src/app.module') as typeof import('../src/app.module');
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    applyGlobalValidation(app);
    await app.init();

    users = app.get(UsersService);
    sessions = app.get<Repository<UserSession>>(getRepositoryToken(UserSession, 'main'));

    const created = await users.create({
      email: CORE_USER_EMAIL,
      name: 'Operator SSO',
      role: ApiKeyRole.OPERATOR,
      password: 'a-long-passphrase',
      assignments: [],
    });
    userId = created.id;
    await users.update(userId, { coreUserId: CORE_USER_ID });
  });

  afterAll(async () => {
    await app?.close();
    await new Promise<void>(resolve => coreServer?.close(() => resolve()));
  });

  beforeEach(async () => {
    coreCalls = [];
    codes = new Map();
    responder = null;
    // Every test starts with no session for the mapped account, so "no session was created" is a
    // real assertion rather than a comparison against rows left by an earlier test.
    await sessions.delete({ userId });
  });

  describe('A. A valid handoff becomes a Connect session', () => {
    it('exchanges server-to-server and returns a page that installs the session', async () => {
      issueCode('code-valid-1');

      const response = await postHandoff('code-valid-1', { state: 'state-1' });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.headers['cache-control']).toContain('no-store');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      // The browser never receives the SSO key, and the app never sets a cookie.
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(JSON.stringify(response.headers)).not.toContain(SSO_KEY);

      const token = tokenFrom(response.text);
      expect(token.startsWith('owa_s1_')).toBe(true);

      // Exactly one server-to-server call, with the configured key and the contract body.
      expect(coreCalls).toHaveLength(1);
      expect(coreCalls[0].path).toBe('/api/connect/v1/sso/exchange');
      expect(coreCalls[0].headers[SSO_HEADER]).toBe(SSO_KEY);
      expect(coreCalls[0].body).toEqual({
        code: 'code-valid-1',
        audience: 'connect',
        scope: 'whatsapp.embed',
        state: 'state-1',
      });

      // The session is real and resolves to the mapped Connect account.
      const me = await supertest(app.getHttpServer()).get('/api/auth/me').set('X-API-Key', token);
      expect(me.status).toBe(200);
      expect(me.body).toMatchObject({ user: { id: userId, email: CORE_USER_EMAIL } });
      expect(await liveSessionCount()).toBe(1);
    });

    it('accepts the documented /sso/handoff address through the production surface', async () => {
      issueCode('code-alias-1');

      const response = await postHandoff('code-alias-1', { path: '/sso/handoff' });

      expect(response.status).toBe(200);
      expect(response.text).toContain('Berhasil masuk');
      expect(coreCalls).toHaveLength(1);
    });

    it('answers a JSON client without ever returning the session token', async () => {
      issueCode('code-json-1');

      const response = await postHandoff('code-json-1', { accept: 'application/json' });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ ok: true, userId });
      expect(JSON.stringify(response.body)).not.toContain('owa_s1_');
    });
  });

  describe('B. Core refusals are distinguished and never create a session', () => {
    it('rejects an expired handoff with 410 and the expired page', async () => {
      issueCode('code-expired-1', CORE_USER_ID, 'expired');

      const response = await postHandoff('code-expired-1');

      expect(response.status).toBe(410);
      expect(response.text).toContain('kedaluwarsa');
      expect(await liveSessionCount()).toBe(0);
    });

    it('rejects an already-used handoff with 409', async () => {
      issueCode('code-used-1');
      const first = await postHandoff('code-used-1');
      expect(first.status).toBe(200);

      const second = await postHandoff('code-used-1');

      expect(second.status).toBe(409);
      expect(second.text).toContain('sudah dipakai');
      // The second attempt added no session: one handoff, one session.
      expect(await liveSessionCount()).toBe(1);
    });

    it('rejects a tampered code by asking Core, not by trusting the browser', async () => {
      issueCode('code-real-1');

      const response = await postHandoff('code-tampered-1');

      expect(response.status).toBe(400);
      expect(response.text).toContain('tidak dikenali');
      // Connect forwarded the tampered value; it did not decide validity locally.
      expect(coreCalls).toHaveLength(1);
      expect(coreCalls[0].body.code).toBe('code-tampered-1');
      expect(await liveSessionCount()).toBe(0);
    });

    it('rejects an audience or scope mismatch from Core', async () => {
      responder = () => ({ status: 403, body: errorBody('audience_mismatch') });
      const audience = await postHandoff('code-aud-1');
      expect(audience.status).toBe(403);
      expect(audience.text).toContain('aplikasi lain');

      responder = () => ({ status: 403, body: errorBody('scope_mismatch') });
      const scope = await postHandoff('code-scope-1');
      expect(scope.status).toBe(403);
      expect(scope.text).toContain('Cakupan tidak sesuai');

      expect(await liveSessionCount()).toBe(0);
    });

    it('turns a Core 401 into a failed verification, not a session', async () => {
      // Core rejects the key Connect sent. The browser still sent none.
      responder = () => ({ status: 401, body: { success: false, message: 'invalid key', data: null, errors: null } });

      const response = await postHandoff('code-key-1');

      expect(response.status).toBe(502);
      expect(response.text).toContain('tidak dapat memverifikasi');
      expect(coreCalls[0].headers[SSO_HEADER]).toBe(SSO_KEY);
      expect(await liveSessionCount()).toBe(0);
    });

    it('rejects a handoff whose permission was revoked in Core', async () => {
      responder = () => ({ status: 403, body: errorBody('permission_revoked') });

      const response = await postHandoff('code-revoked-1');

      expect(response.status).toBe(403);
      expect(response.text).toContain('Akses dicabut');
      expect(await liveSessionCount()).toBe(0);
    });

    it('rejects a Core user that is inactive', async () => {
      responder = () => ({ status: 403, body: errorBody('user_inactive') });

      const response = await postHandoff('code-inactive-1');

      expect(response.status).toBe(403);
      expect(response.text).toContain('tidak aktif');
      expect(await liveSessionCount()).toBe(0);
    });
  });

  describe('C. Identity mapping and availability', () => {
    it('refuses an unmapped Core identity and creates no Connect account', async () => {
      const before = await users.count();
      issueCode('code-unmapped-1', 'core-user-not-mapped');

      const response = await postHandoff('code-unmapped-1');

      expect(response.status).toBe(403);
      expect(response.text).toContain('belum dipetakan');
      expect(await users.count()).toBe(before);
      expect(await liveSessionCount()).toBe(0);
    });

    it('refuses a disabled Connect account', async () => {
      await users.update(userId, { isActive: false });
      try {
        issueCode('code-disabled-1');
        const response = await postHandoff('code-disabled-1');

        expect(response.status).toBe(403);
        expect(response.text).toContain('dinonaktifkan');
        expect(await liveSessionCount()).toBe(0);
      } finally {
        await users.update(userId, { isActive: true });
      }
    });

    it('does not create a session when Core is unreachable', async () => {
      // A dropped connection is what an outage looks like to `fetch`; the server stays up for the
      // rest of the suite.
      responder = () => ({ status: 0, body: null, destroy: true });
      issueCode('code-unreachable-1');

      const response = await postHandoff('code-unreachable-1');

      expect([502, 504]).toContain(response.status);
      expect(response.text).toMatch(/tidak dapat dihubungi|tidak merespons/);
      expect(await liveSessionCount()).toBe(0);
    });
  });

  describe('D. Session security', () => {
    it('mints a different session on every handoff (no fixation)', async () => {
      issueCode('code-fix-1');
      const first = await postHandoff('code-fix-1', { cookie: 'openwa_api_key=attacker-chosen' });
      issueCode('code-fix-2');
      const second = await postHandoff('code-fix-2');

      const firstToken = tokenFrom(first.text);
      const secondToken = tokenFrom(second.text);

      expect(firstToken).not.toBe(secondToken);
      expect(firstToken).not.toBe('attacker-chosen');
      // Both resolve to the same account through two distinct session rows.
      const me = await supertest(app.getHttpServer()).get('/api/auth/me').set('X-API-Key', firstToken);
      expect(me.status).toBe(200);
    });

    it('stops honouring a session after its absolute expiry', async () => {
      issueCode('code-expiry-1');
      const response = await postHandoff('code-expiry-1');
      const token = tokenFrom(response.text);
      const session = await sessions.findOneOrFail({ where: { userId }, order: { createdAt: 'DESC' } });

      await sessions.update({ id: session.id }, { expiresAt: new Date(Date.now() - 1000) });

      const me = await supertest(app.getHttpServer()).get('/api/auth/me').set('X-API-Key', token);
      expect(me.status).toBe(401);
    });

    it('stops honouring an idle session and revokes it', async () => {
      issueCode('code-idle-1');
      const response = await postHandoff('code-idle-1');
      const token = tokenFrom(response.text);
      const session = await sessions.findOneOrFail({ where: { userId }, order: { createdAt: 'DESC' } });

      // The configured idle bound is 5 minutes; 10 minutes of silence is past it.
      await sessions.update({ id: session.id }, { lastSeenAt: new Date(Date.now() - 10 * 60_000) });

      const me = await supertest(app.getHttpServer()).get('/api/auth/me').set('X-API-Key', token);
      expect(me.status).toBe(401);
      const revoked = await sessions.findOneOrFail({ where: { id: session.id } });
      expect(revoked.revokedAt).not.toBeNull();
    });

    it('ends the session on Connect logout', async () => {
      issueCode('code-logout-1');
      const response = await postHandoff('code-logout-1');
      const token = tokenFrom(response.text);

      const logout = await supertest(app.getHttpServer()).post('/api/auth/logout').set('X-API-Key', token);
      expect(logout.status).toBe(204);

      const me = await supertest(app.getHttpServer()).get('/api/auth/me').set('X-API-Key', token);
      expect(me.status).toBe(401);
    });

    it('refuses direct workspace access without a credential', async () => {
      expect((await supertest(app.getHttpServer()).get('/api/auth/me')).status).toBe(401);
      expect((await supertest(app.getHttpServer()).get('/api/sessions')).status).toBe(401);
    });
  });

  describe('E. Origin allowlist and iframe policy', () => {
    it('refuses a request from an origin that is not Core, before calling Core', async () => {
      issueCode('code-evil-1');

      const response = await postHandoff('code-evil-1', { origin: 'https://evil.example' });

      expect(response.status).toBe(403);
      expect(response.text).toContain('tidak diizinkan');
      expect(coreCalls).toHaveLength(0);
    });

    it('refuses a request with no Origin and no Referer', async () => {
      issueCode('code-noorigin-1');

      const response = await postHandoff('code-noorigin-1', { origin: null });

      expect(response.status).toBe(403);
      expect(coreCalls).toHaveLength(0);
    });

    it('publishes frame-ancestors for the configured Core origin and no wildcard', async () => {
      const response = await supertest(app.getHttpServer()).get('/api/sso/handoff').set('X-Forwarded-For', nextIp());

      expect(response.status).toBe(200);
      const csp = String(response.headers['content-security-policy']);
      expect(csp).toContain(`frame-ancestors 'self' ${CORE_ORIGIN}`);
      expect(csp).not.toContain('frame-ancestors *');
      // X-Frame-Options would forbid the Core embed; CSP is the sole framing policy here.
      expect(response.headers['x-frame-options']).toBeUndefined();
      // The loading page carries no token.
      expect(response.text).not.toContain('openwa_api_key');
    });
  });

  describe('F. Parallel redemption', () => {
    it('creates exactly one session when two browsers race the same code', async () => {
      issueCode('code-race-1');
      // Delay the response AFTER the code is spent, so both requests overlap in flight.
      responder = call => {
        const reply = defaultResponder(call);
        return { ...reply, delayMs: 120 };
      };

      const [first, second] = await Promise.all([
        postHandoff('code-race-1', { ip: '10.20.0.1' }),
        postHandoff('code-race-1', { ip: '10.20.0.2' }),
      ]);

      const statuses = [first.status, second.status].sort((a, b) => a - b);
      expect(statuses).toEqual([200, 409]);
      expect(await liveSessionCount()).toBe(1);
    });
  });

  describe('G. Secrets never reach the log', () => {
    it('does not log the SSO key or the handoff code, on success or refusal', async () => {
      const written: string[] = [];
      const stdout = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });
      const stderr = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });

      try {
        issueCode('code-log-secret-1');
        await postHandoff('code-log-secret-1');
        await postHandoff('code-log-secret-unknown');
      } finally {
        stdout.mockRestore();
        stderr.mockRestore();
      }

      const log = written.join('\n');
      expect(log).not.toContain('code-log-secret-1');
      expect(log).not.toContain('code-log-secret-unknown');
      expect(log).not.toContain(SSO_KEY);
    });
  });
});
