import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource, type Repository } from 'typeorm';
import { AssignmentsService } from './assignments.service';
import { PermissionService } from './permission.service';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';
import { RoleAssignment } from './entities/role-assignment.entity';
import { User } from './entities/user.entity';
import type { AuthService } from './auth.service';

/**
 * The write rules of docs/35 §35.5.6, exercised against a real in-memory `main` schema so the
 * unique index, the transaction and the `authzVersion` increment are the real ones.
 */
describe('AssignmentsService', () => {
  let ds: DataSource;
  let service: AssignmentsService;
  let assignments: Repository<RoleAssignment>;
  let apiKeys: Repository<ApiKey>;
  const invalidate = jest.fn();
  const auth = { invalidateAuthorization: invalidate } as unknown as AuthService;

  const sessionCount = jest.fn();
  const divisionCount = jest.fn();

  const actor = { id: 'k-root', name: 'Root' } as ApiKey;

  const makeKey = async (id: string, role: ApiKeyRole = ApiKeyRole.OPERATOR): Promise<ApiKey> => {
    const row = apiKeys.create({
      id,
      name: id,
      keyHash: `h-${id}`,
      keyPrefix: `p-${id}`,
      role,
      allowedIps: null,
      allowedSessions: null,
      allowedChats: null,
      expiresAt: null,
      isActive: true,
    });
    return apiKeys.save(row);
  };

  beforeAll(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [ApiKey, RoleAssignment, User],
      synchronize: true,
    });
    await ds.initialize();
    assignments = ds.getRepository(RoleAssignment);
    apiKeys = ds.getRepository(ApiKey);

    const permissions = new PermissionService(assignments);
    service = new AssignmentsService(
      assignments,
      apiKeys,
      ds.getRepository(User),
      { count: sessionCount } as never,
      { count: divisionCount } as never,
      ds,
      permissions,
      auth,
    );
  });

  afterAll(async () => {
    await ds.destroy();
  });

  beforeEach(async () => {
    await assignments.clear();
    await apiKeys.clear();
    await makeKey('k-root', ApiKeyRole.ADMIN);
    await makeKey('k-agent');
    sessionCount.mockResolvedValue(1);
    divisionCount.mockResolvedValue(1);
    invalidate.mockClear();
  });

  it('writes a global grant, bumps authzVersion and invalidates after the commit', async () => {
    const row = await service.create({ apiKeyId: 'k-agent', role: 'agent', scopeType: 'global' }, actor);

    expect(row).toMatchObject({ apiKeyId: 'k-agent', role: 'agent', scopeType: 'global', scopeId: '' });
    expect((await apiKeys.findOneByOrFail({ id: 'k-agent' })).authzVersion).toBe(1);
    expect(invalidate).toHaveBeenCalledWith('k-agent');
  });

  it('refuses a duplicate grant with 409', async () => {
    await service.create({ apiKeyId: 'k-agent', role: 'agent', scopeType: 'global' }, actor);
    await expect(
      service.create({ apiKeyId: 'k-agent', role: 'agent', scopeType: 'global' }, actor),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses scopeType unit with the Fase 4 message', async () => {
    await expect(
      service.create({ apiKeyId: 'k-agent', role: 'agent', scopeType: 'unit', scopeId: 'u1' }, actor),
    ).rejects.toThrow(/Fase 4/);
  });

  it('requires scopeId for a scoped grant and refuses an unknown session or division', async () => {
    await expect(
      service.create({ apiKeyId: 'k-agent', role: 'agent', scopeType: 'session' }, actor),
    ).rejects.toBeInstanceOf(BadRequestException);

    sessionCount.mockResolvedValue(0);
    await expect(
      service.create({ apiKeyId: 'k-agent', role: 'agent', scopeType: 'session', scopeId: 's-missing' }, actor),
    ).rejects.toThrow(/No session/);

    divisionCount.mockResolvedValue(0);
    await expect(
      service.create({ apiKeyId: 'k-agent', role: 'agent', scopeType: 'team', scopeId: 'd-missing' }, actor),
    ).rejects.toThrow(/No division/);
  });

  it('refuses an object scope that is not a chat id', async () => {
    await expect(
      service.create({ apiKeyId: 'k-agent', role: 'agent', scopeType: 'object', scopeId: 'not-a-chat' }, actor),
    ).rejects.toThrow(/chat id/);
  });

  it('refuses a validity window that has already ended', async () => {
    await expect(
      service.create(
        { apiKeyId: 'k-agent', role: 'agent', scopeType: 'global', validTo: '2020-01-01T00:00:00Z' },
        actor,
      ),
    ).rejects.toThrow(/in the past/);
  });

  it('refuses to remove the last global administrator', async () => {
    const row = await service.create({ apiKeyId: 'k-agent', role: 'system_admin', scopeType: 'global' }, actor);
    // The only other key (k-root) has no assignment, so the legacy fallback counts it as an admin.
    // Remove that fallback by giving it a non-admin grant, leaving one global admin.
    await service.create({ apiKeyId: 'k-root', role: 'agent', scopeType: 'global' }, actor);

    await expect(service.remove(row.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it('allows removing a global admin when another one survives', async () => {
    const row = await service.create({ apiKeyId: 'k-agent', role: 'system_admin', scopeType: 'global' }, actor);
    await service.create({ apiKeyId: 'k-root', role: 'system_admin', scopeType: 'global' }, actor);

    await expect(service.remove(row.id)).resolves.toMatchObject({ id: row.id });
    expect((await apiKeys.findOneByOrFail({ id: 'k-agent' })).authzVersion).toBe(2);
  });

  it('refuses to downgrade the last global administrator through update', async () => {
    const row = await service.create({ apiKeyId: 'k-agent', role: 'system_admin', scopeType: 'global' }, actor);
    await service.create({ apiKeyId: 'k-root', role: 'agent', scopeType: 'global' }, actor);

    await expect(service.update(row.id, { role: 'agent' }, actor)).rejects.toBeInstanceOf(ConflictException);
  });

  it('does not let a scoped grantor hand out global scope or a scope it cannot reach', async () => {
    // A team-scoped supervisor: its own authority reaches d1 only.
    await service.create({ apiKeyId: 'k-root', role: 'supervisor', scopeType: 'team', scopeId: 'd1' }, actor);
    const scopedActor = await apiKeys.findOneByOrFail({ id: 'k-root' });
    const permissions = new PermissionService(assignments);
    const scopedService = new AssignmentsService(
      assignments,
      apiKeys,
      ds.getRepository(User),
      { count: sessionCount } as never,
      { count: divisionCount } as never,
      ds,
      permissions,
      auth,
    );

    await expect(
      scopedService.create({ apiKeyId: 'k-agent', role: 'agent', scopeType: 'global' }, scopedActor),
    ).rejects.toBeInstanceOf(ForbiddenException);

    await expect(
      scopedService.create({ apiKeyId: 'k-agent', role: 'agent', scopeType: 'team', scopeId: 'd2' }, scopedActor),
    ).rejects.toThrow(/outside your own/);

    await expect(
      scopedService.create({ apiKeyId: 'k-agent', role: 'agent', scopeType: 'team', scopeId: 'd1' }, scopedActor),
    ).resolves.toMatchObject({ scopeId: 'd1' });
  });

  it('404s an unknown key and an unknown assignment', async () => {
    await expect(
      service.create({ apiKeyId: 'nope', role: 'agent', scopeType: 'global' }, actor),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.remove('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lists assignments for a key and refuses an unknown key', async () => {
    await service.create({ apiKeyId: 'k-agent', role: 'agent', scopeType: 'global' }, actor);
    await expect(service.list('k-agent')).resolves.toHaveLength(1);
    await expect(service.list('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('writes the grants of a new account inside the caller’s transaction', async () => {
    const specs = await service.prepareForNewUser([{ role: 'agent', scopeType: 'global' }]);
    await ds.transaction(manager =>
      service.insertForNewUser(manager, { apiKeyId: 'k-agent', userId: 'u1', specs, grantedByKeyId: 'k-root' }),
    );
    const rows = await assignments.findBy({ apiKeyId: 'k-agent' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: 'u1', role: 'agent', grantedByKeyId: 'k-root' });
  });
});
