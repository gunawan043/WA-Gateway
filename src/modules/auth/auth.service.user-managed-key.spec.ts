import 'reflect-metadata';
import { ConflictException } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { DataSource, Repository } from 'typeorm';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';
import { User } from './entities/user.entity';
import { AuthService } from './auth.service';
import { ApiKeyUsageTracker } from './api-key-usage-tracker.service';

/**
 * A dashboard account's key is a key row, so it shows up in `GET /auth/api-keys` like any other. The
 * lifecycle routes must refuse to edit or delete it: doing so would silently break that account's
 * login (or demote it out of its own role) with nothing pointing at the cause.
 */
describe('AuthService lifecycle guards on a user-managed key', () => {
  let ds: DataSource;
  let keys: Repository<ApiKey>;
  let users: Repository<User>;
  let service: AuthService;
  let withoutUsers: AuthService;

  const moduleRef = { get: () => undefined } as unknown as ModuleRef;

  beforeAll(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [ApiKey, User],
      synchronize: true,
    });
    await ds.initialize();
    keys = ds.getRepository(ApiKey);
    users = ds.getRepository(User);
  });

  afterAll(async () => {
    await ds.destroy();
  });

  beforeEach(async () => {
    await users.clear();
    await keys.clear();
    service = new AuthService(keys, new ApiKeyUsageTracker(keys), moduleRef, undefined, users);
    // The pre-feature shape: no users repository, so the guard has nothing to consult.
    withoutUsers = new AuthService(keys, new ApiKeyUsageTracker(keys), moduleRef);
  });

  const key = async (name: string, role = ApiKeyRole.ADMIN): Promise<ApiKey> =>
    keys.save(
      keys.create({
        name,
        keyPrefix: 'owa_k1_abcdef',
        keyHash: `hash-${Math.random()}`,
        role,
        isActive: true,
        expiresAt: null,
        allowedIps: null,
        allowedSessions: null,
        allowedChats: null,
      }),
    );

  const account = async (): Promise<{ apiKey: ApiKey; user: User }> => {
    const apiKey = await key('Dashboard account');
    const user = await users.save(
      users.create({
        email: 'owner@example.com',
        name: 'Dashboard account',
        passwordHash: 'scrypt$32768$8$1$c2FsdA==$aGFzaA==',
        role: ApiKeyRole.ADMIN,
        isActive: true,
        apiKeyId: apiKey.id,
        lastLoginAt: null,
      }),
    );
    return { apiKey, user };
  };

  it('refuses to update the key of an account, naming the account', async () => {
    const { apiKey } = await account();
    await expect(service.update(apiKey.id, { name: 'renamed elsewhere' })).rejects.toBeInstanceOf(ConflictException);
    await expect(service.update(apiKey.id, { name: 'x' })).rejects.toThrow(/Users page/);
    expect(await keys.findOneByOrFail({ id: apiKey.id })).toMatchObject({ name: 'Dashboard account' });
  });

  it('refuses to revoke it, so the account cannot be locked out from the key list', async () => {
    const { apiKey } = await account();
    await expect(service.revoke(apiKey.id)).rejects.toBeInstanceOf(ConflictException);
    expect(await keys.findOneByOrFail({ id: apiKey.id })).toMatchObject({ isActive: true });
  });

  it('refuses to delete it, so no account is left pointing at a missing key', async () => {
    const { apiKey } = await account();
    await expect(service.delete(apiKey.id)).rejects.toBeInstanceOf(ConflictException);
    expect(await keys.findOneBy({ id: apiKey.id })).not.toBeNull();
  });

  it('leaves every other key manageable', async () => {
    const { apiKey } = await account();
    const minted = await key('CI runner', ApiKeyRole.OPERATOR);

    await expect(service.update(minted.id, { name: 'CI runner renamed' })).resolves.toMatchObject({
      name: 'CI runner renamed',
    });
    await expect(service.revoke(minted.id)).resolves.toMatchObject({ isActive: false });
    await expect(service.delete(minted.id)).resolves.toBeUndefined();
    // The account's key is untouched by all of that.
    expect(await keys.findOneBy({ id: apiKey.id })).not.toBeNull();
  });

  it('behaves as before when no users repository is wired (a spec or a key-only deployment)', async () => {
    const { apiKey } = await account();
    await expect(withoutUsers.update(apiKey.id, { name: 'renamed' })).resolves.toMatchObject({ name: 'renamed' });
  });
});
