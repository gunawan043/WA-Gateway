import type { Repository } from 'typeorm';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';
import { RoleAssignment } from './entities/role-assignment.entity';
import { PermissionService } from './permission.service';

/**
 * The resolver's contract (docs/35 §35.5.1–35.5.4): a union over active assignments, the legacy
 * column only when there is no assignment, a scope that narrows rather than widens, and a cache
 * that `validTo` and `invalidate()` can always cut short.
 */
describe('PermissionService', () => {
  const find = jest.fn();
  const repo = { find } as unknown as Repository<RoleAssignment>;
  let service: PermissionService;

  const key = (over: Partial<ApiKey> = {}): ApiKey => ({
    id: 'k1',
    name: 'Key',
    keyHash: 'h',
    keyPrefix: 'p',
    role: ApiKeyRole.OPERATOR,
    allowedIps: null,
    allowedSessions: null,
    allowedChats: null,
    isActive: true,
    expiresAt: null,
    lastUsedAt: null,
    usageCount: 0,
    authzVersion: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });

  const assignment = (over: Partial<RoleAssignment> = {}): RoleAssignment => ({
    id: `a-${Math.random()}`,
    apiKeyId: 'k1',
    userId: null,
    role: 'agent',
    scopeType: 'global',
    scopeId: '',
    source: 'local',
    externalId: null,
    validFrom: null,
    validTo: null,
    grantedByKeyId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });

  beforeEach(() => {
    find.mockReset();
    service = new PermissionService(repo);
  });

  it('falls back to the legacy role when the key has no assignment, with global scope', async () => {
    find.mockResolvedValue([]);
    const access = await service.effective(key({ role: ApiKeyRole.VIEWER }));

    expect(access.fromAssignments).toBe(false);
    expect([...access.roles]).toEqual(['analyst']);
    expect(access.scope.global).toBe(true);
    expect(access.permissions.has('session.read')).toBe(true);
    expect(access.permissions.has('user.manage')).toBe(false);
  });

  it('unions the permissions and scopes of every active assignment', async () => {
    find.mockResolvedValue([
      assignment({ role: 'agent', scopeType: 'team', scopeId: 'd1' }),
      assignment({ role: 'quality_evaluator', scopeType: 'session', scopeId: 's1' }),
    ]);
    const access = await service.effective(key());

    expect(access.fromAssignments).toBe(true);
    expect([...access.roles].sort()).toEqual(['agent', 'quality_evaluator']);
    expect(access.scope.global).toBe(false);
    expect([...access.scope.divisionIds]).toEqual(['d1']);
    expect([...access.scope.sessionIds]).toEqual(['s1']);
  });

  it('lets one global assignment widen the merged scope', async () => {
    find.mockResolvedValue([
      assignment({ role: 'agent', scopeType: 'team', scopeId: 'd1' }),
      assignment({ role: 'agent' }),
    ]);
    expect((await service.effective(key())).scope.global).toBe(true);
  });

  it('ignores an assignment outside its validity window', async () => {
    const now = new Date('2026-06-01T00:00:00.000Z');
    find.mockResolvedValue([
      assignment({ role: 'agent', validFrom: new Date('2026-07-01T00:00:00.000Z') }),
      assignment({ role: 'analyst', validTo: new Date('2026-05-01T00:00:00.000Z') }),
    ]);
    const access = await service.effective(key(), now);
    expect(access.fromAssignments).toBe(false);
  });

  it('treats an unparseable validTo as expired, never as "never expires"', async () => {
    find.mockResolvedValue([assignment({ role: 'agent', validTo: 'not-a-date' as unknown as Date })]);
    expect((await service.effective(key())).fromAssignments).toBe(false);
  });

  it('answers can() only inside the granted scope', async () => {
    find.mockResolvedValue([assignment({ role: 'agent', scopeType: 'team', scopeId: 'd1' })]);
    const apiKey = key();

    await expect(service.can(apiKey, 'inbox.read', { divisionId: 'd1' })).resolves.toBe(true);
    await expect(service.can(apiKey, 'inbox.read', { divisionId: 'd2' })).resolves.toBe(false);
    // A resource with no field matching the grant is outside it.
    await expect(service.can(apiKey, 'inbox.read', { chatId: 'c1' })).resolves.toBe(false);
    // No resource = "may perform this kind of action"; the list must still be filtered by scope().
    await expect(service.can(apiKey, 'inbox.read')).resolves.toBe(true);
    // A permission the role does not hold is refused even inside the scope.
    await expect(service.can(apiKey, 'team.manage', { divisionId: 'd1' })).resolves.toBe(false);
  });

  it('lets a global grant satisfy any resource', async () => {
    find.mockResolvedValue([assignment({ role: 'supervisor' })]);
    await expect(service.can(key(), 'inbox.assign', { divisionId: 'anything' })).resolves.toBe(true);
  });

  it('assert() names the missing permission, not the role', async () => {
    find.mockResolvedValue([assignment({ role: 'agent' })]);
    await expect(service.assert(key(), ['inbox.read', 'team.manage'])).rejects.toThrow(
      'Missing permission: team.manage',
    );
  });

  it('caps a scoped assignment at OPERATOR on the @RequireRole bridge', async () => {
    find.mockResolvedValue([assignment({ role: 'system_admin', scopeType: 'team', scopeId: 'd1' })]);
    await expect(service.bridgeLevel(key())).resolves.toBe(ApiKeyRole.OPERATOR);
  });

  it('keeps a global system_admin at ADMIN, and a global agent at OPERATOR', async () => {
    find.mockResolvedValue([assignment({ role: 'system_admin' })]);
    await expect(service.bridgeLevel(key())).resolves.toBe(ApiKeyRole.ADMIN);

    service.clearCache();
    find.mockResolvedValue([assignment({ role: 'agent' })]);
    await expect(service.bridgeLevel(key())).resolves.toBe(ApiKeyRole.OPERATOR);
  });

  it('keeps the legacy level exact for a key with no assignment', async () => {
    find.mockResolvedValue([]);
    await expect(service.bridgeLevel(key({ role: ApiKeyRole.ADMIN }))).resolves.toBe(ApiKeyRole.ADMIN);
    service.clearCache();
    await expect(service.bridgeLevel(key({ role: ApiKeyRole.VIEWER }))).resolves.toBe(ApiKeyRole.VIEWER);
  });

  it('intersects the list scope with the credential fences', async () => {
    find.mockResolvedValue([
      assignment({ role: 'agent', scopeType: 'team', scopeId: 'd1' }),
      assignment({ role: 'agent', scopeType: 'session', scopeId: 's1' }),
      assignment({ role: 'agent', scopeType: 'object', scopeId: 'c1@c.us' }),
    ]);
    const scope = await service.scope(key({ allowedSessions: ['s1', 's2'], allowedChats: ['c1@c.us', 'c2@c.us'] }));

    expect([...(scope.sessionIds ?? [])]).toEqual(['s1']);
    expect([...(scope.chatIds ?? [])]).toEqual(['c1@c.us']);
    expect([...(scope.divisionIds ?? [])]).toEqual(['d1']);
  });

  it('caches for the TTL, re-reads after invalidate(), and never outlives validTo', async () => {
    const t0 = new Date('2026-06-01T00:00:00.000Z');
    find.mockResolvedValue([assignment({ role: 'agent', validTo: new Date('2026-06-01T00:00:01.000Z') })]);

    await service.effective(key(), t0);
    await service.effective(key(), new Date(t0.getTime() + 500));
    expect(find).toHaveBeenCalledTimes(1);

    // Past validTo the entry must not be served, even though the 15 s TTL has not elapsed.
    await service.effective(key(), new Date(t0.getTime() + 1_500));
    expect(find).toHaveBeenCalledTimes(2);

    service.invalidate('k1');
    await service.effective(key(), new Date(t0.getTime() + 1_600));
    expect(find).toHaveBeenCalledTimes(3);
  });

  it('re-reads immediately when authzVersion moved, without waiting for invalidate()', async () => {
    find.mockResolvedValue([assignment({ role: 'agent' })]);
    await service.effective(key({ authzVersion: 0 }));
    await service.effective(key({ authzVersion: 1 }));
    expect(find).toHaveBeenCalledTimes(2);
  });

  it('skips a row naming a role this release does not know', async () => {
    find.mockResolvedValue([assignment({ role: 'future_role' })]);
    const access = await service.effective(key());
    expect(access.roles.size).toBe(0);
    expect(access.permissions.size).toBe(0);
  });
});
