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
  audit: { logInfo: jest.Mock };
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
  const audit = { logInfo: jest.fn().mockResolvedValue(undefined) };
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
});
