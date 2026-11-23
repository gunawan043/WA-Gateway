import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { AuthSessionController } from './auth-session.controller';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';
import { User } from './entities/user.entity';
import { UserSession } from './entities/user-session.entity';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { EngineFactory } from '../../engine/engine.factory';
import { getRequestActor, runWithRequestId } from '../../common/services/request-context';
import { allowUnauthenticatedAuditRow } from '../audit/auth-failure-audit-limiter';

jest.mock('../audit/auth-failure-audit-limiter', () => ({
  allowUnauthenticatedAuditRow: jest.fn(() => true),
}));

interface AuditPayload {
  metadata?: Record<string, unknown>;
  ipAddress?: string;
}
type AuditFn = jest.MockedFunction<(action: string, payload: AuditPayload) => Promise<void>>;

describe('AuthSessionController', () => {
  const audit = { logInfo: jest.fn() as AuditFn, logWarn: jest.fn() as AuditFn };
  const usersService = {
    authenticate: jest.fn(),
    changeOwnPassword: jest.fn(),
  };
  const sessions = {
    issue: jest.fn(),
    revoke: jest.fn(),
  };
  const engineFactory = { getCurrentEngine: () => 'baileys' } as unknown as EngineFactory;
  const config = { get: (_key: string, fallback?: unknown) => fallback };

  let controller: AuthSessionController;

  const user = (over: Partial<User> = {}): User => ({
    id: 'u1',
    email: 'admin@example.com',
    name: 'Admin',
    passwordHash: 'scrypt$…',
    role: ApiKeyRole.ADMIN,
    isActive: true,
    apiKeyId: 'k1',
    coreUserId: null,
    lastLoginAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...over,
  });

  const key = (over: Partial<ApiKey> = {}): ApiKey =>
    ({
      id: 'k1',
      name: 'Admin',
      role: ApiKeyRole.ADMIN,
      isActive: true,
      allowedSessions: null,
      ...over,
    }) as ApiKey;

  const session = (over: Partial<UserSession> = {}): UserSession => ({
    id: 's1',
    userId: 'u1',
    tokenHash: 'h',
    expiresAt: new Date('2026-12-01T00:00:00.000Z'),
    revokedAt: null,
    lastSeenAt: null,
    userAgent: null,
    ipAddress: null,
    createdAt: new Date('2026-11-21T00:00:00.000Z'),
    ...over,
  });

  const request = (over: Partial<Request> = {}): Request =>
    ({
      method: 'POST',
      path: '/api/auth/login',
      headers: {},
      socket: { remoteAddress: '203.0.113.5' },
      ...over,
    }) as unknown as Request;

  beforeEach(() => {
    jest.clearAllMocks();
    (allowUnauthenticatedAuditRow as jest.Mock).mockReturnValue(true);
    controller = new AuthSessionController(
      usersService as never,
      sessions as never,
      audit as never,
      engineFactory,
      config as never,
    );
  });

  describe('login', () => {
    it('issues a session and answers with the token, expiry and account', async () => {
      const account = user();
      usersService.authenticate.mockResolvedValue(account);
      sessions.issue.mockResolvedValue({ token: 'owa_s1_abc', session: session() });

      const result = await controller.login({ email: 'admin@example.com', password: 'pw' }, request());

      expect(usersService.authenticate).toHaveBeenCalledWith('admin@example.com', 'pw');
      expect(result).toMatchObject({
        token: 'owa_s1_abc',
        expiresAt: '2026-12-01T00:00:00.000Z',
        role: ApiKeyRole.ADMIN,
        scoped: false,
        engineType: 'baileys',
      });
      expect(result.user).toMatchObject({ id: 'u1', email: 'admin@example.com' });
      // The hash never leaves the server, not even on the sign-in response.
      expect(JSON.stringify(result)).not.toContain('scrypt$');
      expect(audit.logInfo).toHaveBeenCalledWith(
        AuditAction.USER_LOGIN_SUCCEEDED,
        expect.objectContaining({
          ipAddress: '203.0.113.5',
          metadata: { userId: 'u1', sessionId: 's1', role: ApiKeyRole.ADMIN },
        }),
      );
    });

    it('stamps the account as the audit actor, so later rows in the request are attributed', async () => {
      usersService.authenticate.mockResolvedValue(user());
      sessions.issue.mockResolvedValue({ token: 't', session: session() });

      const actor = await runWithRequestId('req-1', async () => {
        await controller.login({ email: 'admin@example.com', password: 'pw' }, request());
        return getRequestActor();
      });

      expect(actor).toMatchObject({ apiKeyId: 'k1', apiKeyName: 'Admin' });
    });

    it('answers one generic 401 and records the attempt without the password', async () => {
      usersService.authenticate.mockResolvedValue(null);

      await expect(controller.login({ email: '  Nobody@Example.com ', password: 'guess' }, request())).rejects.toThrow(
        new UnauthorizedException('Email or password is incorrect'),
      );

      expect(sessions.issue).not.toHaveBeenCalled();
      const [, payload] = audit.logWarn.mock.calls[0];
      expect(audit.logWarn).toHaveBeenCalledWith(AuditAction.USER_LOGIN_FAILED, expect.anything());
      expect(payload.metadata).toEqual({ email: 'nobody@example.com' });
      expect(JSON.stringify(payload)).not.toContain('guess');
    });

    it('bounds failed-login rows per IP', async () => {
      usersService.authenticate.mockResolvedValue(null);
      (allowUnauthenticatedAuditRow as jest.Mock).mockReturnValue(false);

      await expect(controller.login({ email: 'a@b.c', password: 'x' }, request())).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(audit.logWarn).not.toHaveBeenCalled();
    });

    it('resolves the client IP through a trusted proxy, and ignores a spoofed header otherwise', async () => {
      usersService.authenticate.mockResolvedValue(user());
      sessions.issue.mockResolvedValue({ token: 't', session: session() });

      const trusted = new AuthSessionController(
        usersService as never,
        sessions as never,
        audit as never,
        engineFactory,
        {
          get: () => ['10.0.0.0/8'],
        } as never,
      );
      await trusted.login(
        { email: 'admin@example.com', password: 'pw' },
        request({
          headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.2' },
          socket: { remoteAddress: '10.0.0.2' },
        } as unknown as Partial<Request>),
      );
      expect(sessions.issue).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ ipAddress: '203.0.113.9' }),
      );

      await controller.login(
        { email: 'admin@example.com', password: 'pw' },
        request({
          headers: { 'x-forwarded-for': '198.51.100.1' },
          socket: { remoteAddress: '203.0.113.5' },
        } as unknown as Partial<Request>),
      );
      expect(sessions.issue).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ ipAddress: '203.0.113.5' }),
      );
    });
  });

  describe('logout', () => {
    it('revokes the calling session and audits it', async () => {
      sessions.revoke.mockResolvedValue(true);
      await controller.logout(session(), request());

      expect(sessions.revoke).toHaveBeenCalledWith('s1');
      expect(audit.logInfo).toHaveBeenCalledWith(
        AuditAction.USER_SESSION_REVOKED,
        expect.objectContaining({ metadata: { sessionId: 's1', userId: 'u1', reason: 'logout' } }),
      );
    });

    it('refuses an API-key caller instead of pretending to log out', async () => {
      await expect(controller.logout(undefined, request())).rejects.toBeInstanceOf(BadRequestException);
      expect(sessions.revoke).not.toHaveBeenCalled();
    });
  });

  describe('me', () => {
    it('describes a session caller with its account', () => {
      const me = controller.me(key(), user());
      expect(me).toMatchObject({
        role: ApiKeyRole.ADMIN,
        scoped: false,
        engineType: 'baileys',
        keyId: 'k1',
        keyName: 'Admin',
      });
      expect(me.user).toMatchObject({ id: 'u1', email: 'admin@example.com', role: ApiKeyRole.ADMIN });
    });

    it('describes a plain API key with no account', () => {
      expect(controller.me(key({ role: ApiKeyRole.OPERATOR, name: 'CI' }), undefined)).toEqual({
        user: null,
        role: ApiKeyRole.OPERATOR,
        scoped: false,
        engineType: 'baileys',
        keyId: 'k1',
        keyName: 'CI',
      });
    });

    it('reports a session-restricted key as scoped, which is what gates the stats reads', () => {
      expect(controller.me(key({ allowedSessions: ['s1'] }), undefined)).toMatchObject({ scoped: true });
      expect(controller.me(key({ allowedSessions: [] }), undefined)).toMatchObject({ scoped: false });
    });
  });

  describe('changePassword', () => {
    it('delegates with the caller session id, so the caller stays signed in', async () => {
      usersService.changeOwnPassword.mockResolvedValue(undefined);
      await controller.changePassword(
        { currentPassword: 'old', newPassword: 'new' },
        user(),
        session(),
        request({ path: '/api/auth/change-password' }),
      );

      expect(usersService.changeOwnPassword).toHaveBeenCalledWith('u1', 'old', 'new', 's1');
      expect(audit.logInfo).toHaveBeenCalledWith(
        AuditAction.USER_PASSWORD_CHANGED,
        expect.objectContaining({ metadata: { userId: 'u1' } }),
      );
    });

    it('refuses an API-key caller', async () => {
      await expect(
        controller.changePassword({ currentPassword: 'a', newPassword: 'b' }, undefined, undefined, request()),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(usersService.changeOwnPassword).not.toHaveBeenCalled();
    });
  });
});
