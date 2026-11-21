import 'reflect-metadata';
import type { Request } from 'express';
import { AuthUsersController } from './auth-users.controller';
import { ApiKeyRole } from './entities/api-key.entity';
import { User } from './entities/user.entity';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { REQUIRED_ROLE_KEY, UNSCOPED_KEY } from './decorators/auth.decorators';

interface AuditPayload {
  metadata?: Record<string, unknown>;
  ipAddress?: string;
}
type AuditFn = jest.MockedFunction<(action: string, payload: AuditPayload) => Promise<void>>;

describe('AuthUsersController', () => {
  const usersService = {
    findAll: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    resetPassword: jest.fn(),
    remove: jest.fn(),
  };
  const audit = { logInfo: jest.fn() as AuditFn };
  const assignments = {
    listForKeys: jest.fn().mockResolvedValue([]),
    prepareForNewUser: jest.fn(
      (
        inputs: Array<{ role: string; scopeType: string; scopeId?: string }>,
      ): Promise<Array<{ role: string; scopeType: string; scopeId: string; validFrom: null; validTo: null }>> =>
        Promise.resolve(
          inputs.map(input => ({
            role: input.role,
            scopeType: input.scopeType,
            scopeId: input.scopeId ?? '',
            validFrom: null,
            validTo: null,
          })),
        ),
    ),
    assertGrantable: jest.fn().mockResolvedValue(undefined),
  };
  let controller: AuthUsersController;

  const user = (over: Partial<User> = {}): User => ({
    id: 'u1',
    email: 'someone@example.com',
    name: 'Someone',
    passwordHash: 'scrypt$…',
    role: ApiKeyRole.OPERATOR,
    isActive: true,
    apiKeyId: 'k1',
    lastLoginAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...over,
  });

  const request = (over: Partial<Request> = {}): Request =>
    ({ method: 'POST', path: '/api/auth/users', ...over }) as unknown as Request;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new AuthUsersController(usersService as never, assignments as never, audit as never);
  });

  it('is fenced to ADMIN and to unscoped keys at the class level', () => {
    // Both are load-bearing: the role stops an operator minting accounts, and the unscoped fence
    // stops a session-restricted admin from minting a credential that escapes its confinement.
    expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, AuthUsersController)).toBe(ApiKeyRole.ADMIN);
    expect(Reflect.getMetadata(UNSCOPED_KEY, AuthUsersController)).toBe(true);
  });

  it('lists accounts without the password hash', async () => {
    usersService.findAll.mockResolvedValue([user(), user({ id: 'u2', email: 'two@example.com' })]);

    const result = await controller.findAll();

    expect(result).toHaveLength(2);
    expect(result[0]).not.toHaveProperty('passwordHash');
    expect(JSON.stringify(result)).not.toContain('scrypt$');
  });

  it('creates an account with its required assignment and audits the target', async () => {
    usersService.create.mockResolvedValue(user());

    const result = await controller.create(
      {
        email: 'someone@example.com',
        name: 'Someone',
        password: 'a-long-password-1',
        assignments: [{ role: 'agent', scopeType: 'global' }],
      },
      request(),
    );

    // `role` is derived from the grant (agent -> operator) because the caller omitted it.
    expect(usersService.create).toHaveBeenCalledWith({
      email: 'someone@example.com',
      name: 'Someone',
      role: ApiKeyRole.OPERATOR,
      password: 'a-long-password-1',
      assignments: [{ role: 'agent', scopeType: 'global', scopeId: '', validFrom: null, validTo: null }],
      grantedByKeyId: null,
    });
    expect(result).toMatchObject({ id: 'u1', email: 'someone@example.com', role: ApiKeyRole.OPERATOR });
    const [action, payload] = audit.logInfo.mock.calls[0];
    expect(action).toBe(AuditAction.USER_CREATED);
    expect(payload.metadata).toMatchObject({
      targetUserId: 'u1',
      targetEmail: 'someone@example.com',
      role: ApiKeyRole.OPERATOR,
    });
  });

  it('derives admin from a global system_admin grant and passes an explicit role through', async () => {
    usersService.create.mockResolvedValue(user({ role: ApiKeyRole.ADMIN }));
    await controller.create(
      {
        email: 'a@b.c',
        name: 'A',
        role: ApiKeyRole.ADMIN,
        password: 'a-long-password-1',
        assignments: [{ role: 'system_admin', scopeType: 'global' }],
      },
      request(),
    );
    expect(usersService.create).toHaveBeenCalledWith(expect.objectContaining({ role: ApiKeyRole.ADMIN }));
  });

  it('refuses to create an account without assignments, before writing anything', async () => {
    assignments.prepareForNewUser.mockImplementationOnce(() => Promise.reject(new Error('assignments is required')));
    await expect(
      controller.create({ email: 'a@b.c', name: 'A', password: 'a-long-password-1', assignments: [] }, request()),
    ).rejects.toThrow('assignments is required');
    expect(usersService.create).not.toHaveBeenCalled();
  });

  it('updates an account and audits the resulting state', async () => {
    usersService.update.mockResolvedValue(user({ name: 'Renamed', isActive: false }));

    await controller.update('u1', { name: 'Renamed', isActive: false }, request({ method: 'PATCH' }));

    expect(usersService.update).toHaveBeenCalledWith('u1', { name: 'Renamed', isActive: false });
    const [, payload] = audit.logInfo.mock.calls[0];
    expect(audit.logInfo.mock.calls[0][0]).toBe(AuditAction.USER_UPDATED);
    expect(payload.metadata).toMatchObject({ targetUserId: 'u1', name: 'Renamed', isActive: false });
  });

  it('resets a password without echoing it back or auditing it', async () => {
    usersService.resetPassword.mockResolvedValue(user());

    await controller.resetPassword('u1', { password: 'a-new-long-password' }, request());

    expect(usersService.resetPassword).toHaveBeenCalledWith('u1', 'a-new-long-password');
    const [, payload] = audit.logInfo.mock.calls[0];
    expect(payload.metadata).toEqual({ targetUserId: 'u1', targetEmail: 'someone@example.com' });
    expect(JSON.stringify(payload)).not.toContain('a-new-long-password');
  });

  it('deletes an account and audits who was removed', async () => {
    usersService.remove.mockResolvedValue(user({ role: ApiKeyRole.ADMIN }));

    await controller.remove('u1', request({ method: 'DELETE' }));

    expect(usersService.remove).toHaveBeenCalledWith('u1');
    expect(audit.logInfo).toHaveBeenCalledWith(
      AuditAction.USER_DELETED,
      expect.objectContaining({
        metadata: { targetUserId: 'u1', targetEmail: 'someone@example.com', role: ApiKeyRole.ADMIN },
      }),
    );
  });

  it('carries the client IP the guard resolved into the audit row', async () => {
    usersService.remove.mockResolvedValue(user());
    await controller.remove('u1', request({ method: 'DELETE', clientIp: '203.0.113.9' } as Partial<Request>));
    expect(audit.logInfo).toHaveBeenCalledWith(
      AuditAction.USER_DELETED,
      expect.objectContaining({ ipAddress: '203.0.113.9' }),
    );
  });
});
