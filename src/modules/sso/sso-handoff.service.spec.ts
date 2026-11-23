import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';
import { SessionAuthService } from '../auth/session-auth.service';
import { User } from '../auth/entities/user.entity';
import { UsersService } from '../auth/users.service';
import { SsoExchangeResult } from './core-client/alim-core-sso.client';
import { SsoHandoffService } from './sso-handoff.service';

const user = {
  id: 'user-1',
  email: 'operator@example.com',
  name: 'Operator',
  role: 'operator',
  isActive: true,
  apiKeyId: 'key-1',
  coreUserId: 'core-1',
} as unknown as User;

function build(options: {
  exchange: SsoExchangeResult;
  mappedUser?: User | null;
  issue?: jest.Mock;
  ttlHours?: number;
}): {
  service: SsoHandoffService;
  client: { exchange: jest.Mock };
  users: { findByCoreUserId: jest.Mock };
  sessions: { issue: jest.Mock };
  audit: { logInfo: jest.Mock; logWarn: jest.Mock };
} {
  const client = { exchange: jest.fn().mockResolvedValue(options.exchange) };
  const users = {
    findByCoreUserId: jest.fn().mockResolvedValue('mappedUser' in options ? options.mappedUser : user),
  };
  const issue =
    options.issue ??
    jest.fn().mockResolvedValue({
      token: 'owa_s1_deadbeef',
      session: { id: 'session-1', expiresAt: new Date('2026-12-01T00:00:00Z') },
    });
  const sessions = { issue };
  const audit = { logInfo: jest.fn().mockResolvedValue(undefined), logWarn: jest.fn().mockResolvedValue(undefined) };
  const config = {
    get: (key: string) => (key === 'connect.sso.sessionTtlHours' ? (options.ttlHours ?? 0) : undefined),
  } as unknown as ConfigService;

  return {
    service: new SsoHandoffService(
      client,
      users as unknown as UsersService,
      sessions as unknown as SessionAuthService,
      audit as unknown as AuditService,
      config,
    ),
    client,
    users,
    sessions,
    audit,
  };
}

const success: SsoExchangeResult = {
  ok: true,
  identity: {
    coreUserId: 'core-1',
    name: 'Operator',
    email: 'operator@example.com',
    audience: 'connect',
    scope: 'whatsapp.embed',
    issuedAt: null,
    redeemedAt: null,
  },
};

describe('SsoHandoffService', () => {
  it('exchanges, maps by core_user_id, then issues exactly one session', async () => {
    const { service, client, users, sessions, audit } = build({ exchange: success });

    const result = await service.complete({ code: 'code-1', state: 's1', ipAddress: '10.0.0.1' });

    expect(result).toMatchObject({ ok: true, userId: 'user-1', token: 'owa_s1_deadbeef' });
    expect(client.exchange).toHaveBeenCalledWith({ code: 'code-1', state: 's1' });
    expect(users.findByCoreUserId).toHaveBeenCalledWith('core-1');
    expect(sessions.issue).toHaveBeenCalledTimes(1);
    const [, auditPayload] = audit.logInfo.mock.calls[0] as [unknown, { metadata: Record<string, unknown> }];
    expect(auditPayload.metadata).toMatchObject({ via: 'alim_core_sso' });
  });

  it('does not issue a session when the exchange is refused', async () => {
    const { service, sessions, users } = build({
      exchange: { ok: false, reason: 'code_expired', httpStatus: 410, code: 'code_expired', message: 'expired' },
    });

    const result = await service.complete({ code: 'code-1' });

    expect(result).toMatchObject({ ok: false, reason: 'code_expired' });
    expect(users.findByCoreUserId).not.toHaveBeenCalled();
    expect(sessions.issue).not.toHaveBeenCalled();
  });

  it('refuses an unmapped identity without creating an account', async () => {
    const { service, sessions } = build({ exchange: success, mappedUser: null });

    const result = await service.complete({ code: 'code-1' });

    expect(result).toMatchObject({ ok: false, reason: 'identity_not_mapped' });
    expect(sessions.issue).not.toHaveBeenCalled();
  });

  it('refuses a disabled Connect account', async () => {
    const { service, sessions } = build({
      exchange: success,
      mappedUser: { ...user, isActive: false },
    });

    const result = await service.complete({ code: 'code-1' });

    expect(result).toMatchObject({ ok: false, reason: 'account_disabled' });
    expect(sessions.issue).not.toHaveBeenCalled();
  });

  it('refuses a blank code before calling Core', async () => {
    const { service, client } = build({ exchange: success });

    const result = await service.complete({ code: '   ' });

    expect(result).toMatchObject({ ok: false, reason: 'code_required' });
    expect(client.exchange).not.toHaveBeenCalled();
  });

  it('never lets a session-issue failure look like a success', async () => {
    const { service } = build({
      exchange: success,
      issue: jest.fn().mockRejectedValue(new Error('database is locked')),
    });

    const result = await service.complete({ code: 'code-1' });

    expect(result).toMatchObject({ ok: false, reason: 'session_issue_failed' });
  });

  it('passes a configured SSO session TTL to the session service', async () => {
    const { service, sessions } = build({ exchange: success, ttlHours: 2 });

    await service.complete({ code: 'code-1' });

    expect(sessions.issue).toHaveBeenCalledWith(expect.anything(), expect.anything(), { ttlMs: 7_200_000 });
  });

  it('leaves the default TTL in place when none is configured', async () => {
    const { service, sessions } = build({ exchange: success });

    await service.complete({ code: 'code-1' });

    expect(sessions.issue).toHaveBeenCalledWith(expect.anything(), expect.anything(), { ttlMs: undefined });
  });

  it('still returns a session when the audit write fails', async () => {
    const { service, audit } = build({ exchange: success });
    audit.logInfo.mockRejectedValue(new Error('audit down'));

    const result = await service.complete({ code: 'code-1' });

    expect(result.ok).toBe(true);
  });

  describe('refusal after Core said yes', () => {
    // A deployment with only the file logger shows nothing for these, so the audit row is the only
    // record an operator can reconcile with Core. It must exist, and it must stay free of secrets.
    it('records an unmapped identity with the Core user id and nothing else sensitive', async () => {
      const { service, audit } = build({ exchange: success, mappedUser: null });

      await service.complete({ code: 'code-secret-1', ipAddress: '10.0.0.9', userAgent: 'jest' });

      expect(audit.logInfo).not.toHaveBeenCalled();
      expect(audit.logWarn).toHaveBeenCalledTimes(1);

      const [action, payload] = audit.logWarn.mock.calls[0] as [
        string,
        { path: string; ipAddress: string; metadata: Record<string, unknown> },
      ];

      expect(action).toBe('user_login_failed');
      expect(payload.path).toBe('/sso/handoff');
      expect(payload.ipAddress).toBe('10.0.0.9');
      expect(payload.metadata).toEqual({ reason: 'identity_not_mapped', via: 'alim_core_sso', coreUserId: 'core-1' });

      const serialised = JSON.stringify(payload);
      expect(serialised).not.toContain('code-secret-1');
      expect(serialised).not.toContain('owa_s1_');
      expect(serialised).not.toContain('jest');
    });

    it('records a disabled account against both identities', async () => {
      const { service, audit } = build({ exchange: success, mappedUser: { ...user, isActive: false } });

      await service.complete({ code: 'code-1' });

      const [, payload] = audit.logWarn.mock.calls[0] as [string, { metadata: Record<string, unknown> }];
      expect(payload.metadata).toEqual({
        reason: 'account_disabled',
        via: 'alim_core_sso',
        coreUserId: 'core-1',
        userId: 'user-1',
      });
    });

    it('records a session-issue failure', async () => {
      const { service, audit } = build({
        exchange: success,
        issue: jest.fn().mockRejectedValue(new Error('database is locked')),
      });

      await service.complete({ code: 'code-1' });

      const [, payload] = audit.logWarn.mock.calls[0] as [string, { metadata: Record<string, unknown> }];
      expect(payload.metadata).toMatchObject({ reason: 'session_issue_failed', coreUserId: 'core-1' });
      expect(JSON.stringify(payload)).not.toContain('database is locked');
    });

    it('does not record Core refusals, which Core already owns', async () => {
      const { service, audit } = build({
        exchange: {
          ok: false,
          reason: 'code_already_used',
          httpStatus: 409,
          code: 'code_already_used',
          message: 'used',
        },
      });

      const result = await service.complete({ code: 'code-1' });

      expect(result).toMatchObject({ ok: false, reason: 'code_already_used' });
      expect(audit.logWarn).not.toHaveBeenCalled();
    });

    it('still refuses when the audit write for a refusal fails', async () => {
      const { service, audit, sessions } = build({ exchange: success, mappedUser: null });
      audit.logWarn.mockRejectedValue(new Error('audit down'));

      const result = await service.complete({ code: 'code-1' });

      expect(result).toMatchObject({ ok: false, reason: 'identity_not_mapped' });
      expect(sessions.issue).not.toHaveBeenCalled();
    });
  });
});
