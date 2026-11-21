import 'reflect-metadata';
import { createHash } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import type { ModuleRef } from '@nestjs/core';
import type { ConfigService } from '@nestjs/config';
import type { Socket } from 'socket.io';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { User } from '../auth/entities/user.entity';
import { UserSession } from '../auth/entities/user-session.entity';
import { AuthService } from '../auth/auth.service';
import { ApiKeyUsageTracker } from '../auth/api-key-usage-tracker.service';
import { SessionAuthService } from '../auth/session-auth.service';
import { AuditService } from '../audit/audit.service';
import { EventsGateway } from './events.gateway';
import type { WSErrorResponse, WSSubscribedResponse } from './dto/ws-messages.dto';

/**
 * The WebSocket side of a dashboard session: a token has to connect, subscribe, and stop streaming
 * the moment its session is revoked — while a raw API-key socket on the same linked key keeps going.
 *
 * Real tables again: the sweep's contract is "re-read the rows and drop what no longer resolves", so
 * a mocked repository would only assert that the mock was called.
 */
describe('EventsGateway dashboard sessions', () => {
  const CLIENT_IP = '203.0.113.5';

  let ds: DataSource;
  let keys: Repository<ApiKey>;
  let users: Repository<User>;
  let sessions: Repository<UserSession>;
  let authService: AuthService;
  let sessionAuth: SessionAuthService;
  let gateway: EventsGateway;

  interface MockSocket {
    id: string;
    handshake: {
      headers: Record<string, string>;
      query: Record<string, string>;
      auth: { apiKey?: string };
      address: string;
    };
    data: Record<string, unknown>;
    emit: jest.Mock;
    disconnect: jest.Mock;
    join: jest.Mock;
    leave: jest.Mock;
    rooms: Set<string>;
    disconnected: boolean;
  }

  const makeSocket = (apiKey: string, id = 'sock-1'): MockSocket => {
    const sock: MockSocket = {
      id,
      handshake: { headers: {}, query: {}, auth: { apiKey }, address: CLIENT_IP },
      data: {},
      emit: jest.fn(),
      disconnect: jest.fn(() => {
        sock.disconnected = true;
      }),
      join: jest.fn(),
      leave: jest.fn(),
      rooms: new Set<string>(),
      disconnected: false,
    };
    return sock;
  };

  const asSocket = (s: MockSocket): Socket => s as unknown as Socket;

  const evictionMessage = (sock: MockSocket): string | undefined =>
    sock.emit.mock.calls.map(([, frame]) => frame as WSErrorResponse).find(frame => frame?.code === 'UNAUTHORIZED')
      ?.message;

  const sweep = (now?: number): Promise<void> =>
    (gateway as unknown as { sweepApiKeyAuthorization: (now?: number) => Promise<void> }).sweepApiKeyAuthorization(now);

  const subscribe = async (sock: MockSocket, sessionId: string, events: string[] = ['message.received']) =>
    (await gateway.handleMessage(asSocket(sock), {
      type: 'subscribe',
      sessionId,
      events,
      requestId: 'r1',
    })) as WSSubscribedResponse | WSErrorResponse;

  /** An account with its linked key, and one live session for it. */
  const account = async (): Promise<{ user: User; key: ApiKey; token: string; sessionId: string }> => {
    const key = await keys.save(
      keys.create({
        name: 'Dashboard',
        keyPrefix: 'owa_k1_abcdef',
        keyHash: `hash-${Math.random()}`,
        role: ApiKeyRole.ADMIN,
        isActive: true,
        expiresAt: null,
        allowedIps: null,
        allowedSessions: null,
        allowedChats: null,
      }),
    );
    const user = await users.save(
      users.create({
        email: `u-${Math.random()}@example.com`,
        name: 'Dashboard',
        passwordHash: 'scrypt$32768$8$1$c2FsdA==$aGFzaA==',
        role: ApiKeyRole.ADMIN,
        isActive: true,
        apiKeyId: key.id,
        lastLoginAt: null,
      }),
    );
    const issued = await sessionAuth.issue(user);
    return { user, key, token: issued.token, sessionId: issued.session.id };
  };

  beforeAll(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [ApiKey, User, UserSession],
      synchronize: true,
    });
    await ds.initialize();
    keys = ds.getRepository(ApiKey);
    users = ds.getRepository(User);
    sessions = ds.getRepository(UserSession);
  });

  afterAll(async () => {
    await ds.destroy();
  });

  beforeEach(async () => {
    await sessions.clear();
    await users.clear();
    await keys.clear();

    const moduleRef = { get: () => gateway } as unknown as ModuleRef;
    authService = new AuthService(keys, new ApiKeyUsageTracker(keys), moduleRef);
    sessionAuth = new SessionAuthService(users, sessions, keys, authService, {
      get: (_key: string, fallback?: unknown) => fallback,
    } as never);
    gateway = new EventsGateway(
      authService,
      { logWarn: jest.fn().mockResolvedValue(null) } as unknown as AuditService,
      { get: (_key: string, fallback?: unknown) => fallback } as unknown as ConfigService,
      undefined,
      sessionAuth,
    );
  });

  it('accepts a session token and remembers which session it came from', async () => {
    const { token, sessionId } = await account();
    const sock = makeSocket(token);

    await gateway.handleConnection(asSocket(sock));

    expect(sock.disconnect).not.toHaveBeenCalled();
    expect(sock.data.sessionId).toBe(sessionId);
    expect(sock.data.apiKey).toMatchObject({ role: ApiKeyRole.ADMIN });
    // The raw token is kept for the per-subscribe re-validation, exactly as for an API key.
    expect(sock.data.rawApiKey).toBe(token);
  });

  it('leaves sessionId unset for a raw API key', async () => {
    const { key } = await account();
    const rawKey = 'owa_k1_' + 'b'.repeat(64);
    await keys.update({ id: key.id }, { keyHash: createHash('sha256').update(rawKey).digest('hex') });
    const sock = makeSocket(rawKey);

    await gateway.handleConnection(asSocket(sock));

    expect(sock.disconnect).not.toHaveBeenCalled();
    expect(sock.data.sessionId).toBeUndefined();
  });

  it('lets a session-token socket subscribe, re-validating the token on the way', async () => {
    const { token } = await account();
    const sock = makeSocket(token);
    await gateway.handleConnection(asSocket(sock));

    const reply = await subscribe(sock, '*');

    expect(reply).toMatchObject({ type: 'subscribed' });
    expect(sock.disconnect).not.toHaveBeenCalled();
  });

  it('refuses a revoked token at the handshake', async () => {
    const { token, sessionId } = await account();
    await sessions.update({ id: sessionId }, { revokedAt: new Date() });
    const sock = makeSocket(token);

    await gateway.handleConnection(asSocket(sock));

    expect(sock.disconnect).toHaveBeenCalledWith(true);
    expect(evictionMessage(sock)).toBe('Authentication failed');
  });

  it('ends a socket whose session was revoked, and says why', async () => {
    const { token, sessionId } = await account();
    const sock = makeSocket(token);
    await gateway.handleConnection(asSocket(sock));

    await sessions.update({ id: sessionId }, { revokedAt: new Date() });
    await sweep();

    expect(sock.disconnect).toHaveBeenCalledWith(true);
    expect(evictionMessage(sock)).toBe('Your session has ended; sign in again');
  });

  it('ends a socket whose session expired', async () => {
    const { token, sessionId } = await account();
    const sock = makeSocket(token);
    await gateway.handleConnection(asSocket(sock));

    await sessions.update({ id: sessionId }, { expiresAt: new Date(Date.now() - 1_000) });
    await sweep();

    expect(sock.disconnect).toHaveBeenCalledWith(true);
    expect(evictionMessage(sock)).toBe('Your session has ended; sign in again');
  });

  it('ends a socket whose session row was deleted', async () => {
    const { token, sessionId } = await account();
    const sock = makeSocket(token);
    await gateway.handleConnection(asSocket(sock));

    await sessions.delete({ id: sessionId });
    await sweep();

    expect(sock.disconnect).toHaveBeenCalledWith(true);
    expect(evictionMessage(sock)).toBe('Your session has ended; sign in again');
  });

  it('keeps a live session socket across a sweep', async () => {
    const { token } = await account();
    const sock = makeSocket(token);
    await gateway.handleConnection(asSocket(sock));

    await sweep();

    expect(sock.disconnect).not.toHaveBeenCalled();
  });

  it('drops only the revoked session socket, not a raw-key socket on the same linked key', async () => {
    const { token, sessionId, key } = await account();
    const rawKey = 'owa_k1_' + 'c'.repeat(64);
    await keys.update({ id: key.id }, { keyHash: createHash('sha256').update(rawKey).digest('hex') });

    const viaSession = makeSocket(token, 'sock-session');
    const viaKey = makeSocket(rawKey, 'sock-key');
    await gateway.handleConnection(asSocket(viaSession));
    await gateway.handleConnection(asSocket(viaKey));
    expect(viaKey.data.sessionId).toBeUndefined();

    await sessions.update({ id: sessionId }, { revokedAt: new Date() });
    await sweep();

    expect(viaSession.disconnect).toHaveBeenCalledWith(true);
    expect(viaKey.disconnect).not.toHaveBeenCalled();
  });
});
