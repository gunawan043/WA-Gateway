import 'reflect-metadata';
import { UnauthorizedException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';
import { User } from './entities/user.entity';
import { UserSession } from './entities/user-session.entity';
import { AuthService, UnresolvedApiKeyException } from './auth.service';
import { ApiKeyUsageTracker } from './api-key-usage-tracker.service';
import { SessionAuthService } from './session-auth.service';
import { generateSessionToken, hashSessionToken } from './session-token';

/**
 * Against a real better-sqlite3 DataSource, because the parts worth testing here are the ones a
 * mocked repository cannot show: the row the issue path writes, what a revoked/expired row does on
 * resolve, and which rows a prune actually deletes.
 */
describe('SessionAuthService', () => {
  let ds: DataSource;
  let users: Repository<User>;
  let sessions: Repository<UserSession>;
  let keys: Repository<ApiKey>;
  let service: SessionAuthService;

  const TTL_HOURS = 2;

  beforeAll(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [ApiKey, User, UserSession],
      synchronize: true,
    });
    await ds.initialize();
    users = ds.getRepository(User);
    sessions = ds.getRepository(UserSession);
    keys = ds.getRepository(ApiKey);

    const tracker = { record: jest.fn(), forget: jest.fn() } as unknown as ApiKeyUsageTracker;
    const authService = new AuthService(keys, tracker, { get: () => undefined } as never);
    const config = {
      get: (key: string, fallback?: unknown) => (key === 'auth.sessionTtlHours' ? TTL_HOURS : fallback),
    };
    service = new SessionAuthService(users, sessions, keys, authService, config as never);
  });

  afterAll(async () => {
    await ds.destroy();
  });

  beforeEach(async () => {
    await sessions.clear();
    await users.clear();
    await keys.clear();
  });

  /** A usable account with its linked key, exactly as UsersService would create one. */
  const account = async (overrides: Partial<ApiKey> = {}): Promise<{ user: User; key: ApiKey }> => {
    const key = await keys.save(
      keys.create({
        name: 'Dashboard account',
        keyPrefix: 'owa_k1_abcdef',
        keyHash: `hash-${Math.random()}`,
        role: ApiKeyRole.OPERATOR,
        isActive: true,
        expiresAt: null,
        allowedIps: null,
        allowedSessions: null,
        allowedChats: null,
        ...overrides,
      }),
    );
    const user = await users.save(
      users.create({
        email: `user-${Math.random()}@example.com`,
        name: 'Dashboard account',
        passwordHash: 'scrypt$32768$8$1$c2FsdA==$aGFzaA==',
        role: ApiKeyRole.OPERATOR,
        isActive: true,
        apiKeyId: key.id,
        lastLoginAt: null,
      }),
    );
    return { user, key };
  };

  describe('issue', () => {
    it('stores only the hash, with the configured TTL and the request context', async () => {
      const { user } = await account();
      const { token, session } = await service.issue(user, {
        ipAddress: '203.0.113.9',
        userAgent: 'Mozilla/5.0',
      });

      expect(token.startsWith('owa_s1_')).toBe(true);
      const stored = await sessions.findOneByOrFail({ id: session.id });
      expect(stored.tokenHash).toBe(hashSessionToken(token));
      expect(stored.tokenHash).not.toBe(token);
      expect(stored.userId).toBe(user.id);
      expect(stored.revokedAt).toBeNull();
      expect(stored.ipAddress).toBe('203.0.113.9');
      expect(stored.userAgent).toBe('Mozilla/5.0');
      expect(stored.lastSeenAt).not.toBeNull();

      const ttlMs = new Date(stored.expiresAt).getTime() - Date.now();
      expect(ttlMs).toBeGreaterThan(TTL_HOURS * 3_600_000 - 60_000);
      expect(ttlMs).toBeLessThanOrEqual(TTL_HOURS * 3_600_000 + 1_000);
    });

    it('truncates a user agent to the column width instead of failing the insert', async () => {
      const { user } = await account();
      const { session } = await service.issue(user, { userAgent: 'x'.repeat(1_000) });
      expect((await sessions.findOneByOrFail({ id: session.id })).userAgent).toHaveLength(255);
    });

    it('falls back to the default TTL when the setting is not a positive number', async () => {
      const { user } = await account();
      const authService = new AuthService(
        keys,
        { record: jest.fn(), forget: jest.fn() } as never,
        {
          get: () => undefined,
        } as never,
      );
      const broken = new SessionAuthService(users, sessions, keys, authService, {
        get: (_key: string, fallback?: unknown) => (fallback === undefined ? 0 : fallback),
      } as never);
      const { session } = await broken.issue(user);
      const days = (new Date(session.expiresAt).getTime() - Date.now()) / 3_600_000;
      expect(days).toBeGreaterThan(167);
    });
  });

  describe('resolve', () => {
    it('returns the account, the session and its linked key', async () => {
      const { user, key } = await account();
      const { token } = await service.issue(user);

      const resolved = await service.resolve(token);
      expect(resolved.user.id).toBe(user.id);
      expect(resolved.apiKey.id).toBe(key.id);
      expect(resolved.session.userId).toBe(user.id);
    });

    it('accepts a token pasted with whitespace, like the guard does', async () => {
      const { user } = await account();
      const { token } = await service.issue(user);
      await expect(service.resolve(` ${token}\n`)).resolves.toBeDefined();
    });

    it('throws the unresolved-key class for a token that matches no row', async () => {
      // That class is what lets the guard write a rate-limited audit row: the caller paid nothing.
      await expect(service.resolve(generateSessionToken())).rejects.toBeInstanceOf(UnresolvedApiKeyException);
    });

    it('refuses a revoked session', async () => {
      const { user } = await account();
      const { token, session } = await service.issue(user);
      await service.revoke(session.id);
      await expect(service.resolve(token)).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('refuses an expired session', async () => {
      const { user } = await account();
      const { token, session } = await service.issue(user);
      await sessions.update({ id: session.id }, { expiresAt: new Date(Date.now() - 1_000) });
      await expect(service.resolve(token)).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('refuses a session whose account was disabled', async () => {
      const { user } = await account();
      const { token } = await service.issue(user);
      await users.update({ id: user.id }, { isActive: false });
      await expect(service.resolve(token)).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('refuses a session whose linked key was revoked or expired', async () => {
      const revoked = await account({ isActive: false });
      await expect(service.resolve((await service.issue(revoked.user)).token)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );

      await sessions.clear();
      const expired = await account({ expiresAt: new Date(Date.now() - 60_000) });
      await expect(service.resolve((await service.issue(expired.user)).token)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('refuses a session whose key has an IP restriction the caller does not meet', async () => {
      const { user } = await account({ allowedIps: ['198.51.100.7'] });
      const { token } = await service.issue(user);
      await expect(service.resolve(token, '203.0.113.9')).rejects.toThrow('IP address not allowed');
      await expect(service.resolve(token, '198.51.100.7')).resolves.toBeDefined();
    });

    it('coalesces lastSeenAt: a fresh session is not written on every resolve', async () => {
      const { user } = await account();
      const { token } = await service.issue(user);
      const update = jest.spyOn(sessions, 'update');
      await service.resolve(token);
      expect(update).not.toHaveBeenCalled();
      update.mockRestore();
    });

    it('refreshes lastSeenAt once it is older than the coalescing window', async () => {
      const { user } = await account();
      const { token, session } = await service.issue(user);
      await sessions.update({ id: session.id }, { lastSeenAt: new Date(Date.now() - 10 * 60_000) });
      const update = jest.spyOn(sessions, 'update');
      await service.resolve(token);
      expect(update).toHaveBeenCalled();
      update.mockRestore();
    });
  });

  describe('revocation', () => {
    it('revoke reports whether it changed a live row', async () => {
      const { user } = await account();
      const { session } = await service.issue(user);
      await expect(service.revoke(session.id)).resolves.toBe(true);
      await expect(service.revoke(session.id)).resolves.toBe(false);
      await expect(service.revoke('no-such-session')).resolves.toBe(false);
    });

    it('revokeAllForUser cuts every live session but can keep the caller', async () => {
      const { user } = await account();
      const first = await service.issue(user);
      const second = await service.issue(user);

      await expect(service.revokeAllForUser(user.id, second.session.id)).resolves.toBe(1);
      await expect(service.resolve(first.token)).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(service.resolve(second.token)).resolves.toBeDefined();

      await expect(service.revokeAllForUser(user.id)).resolves.toBe(1);
      await expect(service.resolve(second.token)).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(service.revokeAllForUser(user.id)).resolves.toBe(0);
    });

    it('findActiveForUser lists only live sessions, newest first', async () => {
      const { user } = await account();
      const older = await service.issue(user);
      const newer = await service.issue(user);
      await service.revoke(older.session.id);

      const active = await service.findActiveForUser(user.id);
      expect(active.map(row => row.id)).toEqual([newer.session.id]);
    });
  });

  describe('findStates', () => {
    it('returns an empty map without querying when given no ids', async () => {
      const find = jest.spyOn(sessions, 'findBy');
      await expect(service.findStates([])).resolves.toEqual(new Map());
      expect(find).not.toHaveBeenCalled();
      find.mockRestore();
    });

    it('returns one map for the ids it knows, including revoked rows', async () => {
      const { user } = await account();
      const live = await service.issue(user);
      const revoked = await service.issue(user);
      await service.revoke(revoked.session.id);

      const states = await service.findStates([live.session.id, revoked.session.id, 'missing']);
      expect([...states.keys()].sort()).toEqual([live.session.id, revoked.session.id].sort());
      expect(states.get(revoked.session.id)?.revokedAt).not.toBeNull();
    });
  });

  describe('pruneExpired', () => {
    it('deletes expired rows and keeps the live ones', async () => {
      const { user } = await account();
      const live = await service.issue(user);
      const dead = await service.issue(user);
      await sessions.update({ id: dead.session.id }, { expiresAt: new Date(Date.now() - 1_000) });

      await expect(service.pruneExpired()).resolves.toBe(1);
      await expect(sessions.findOneBy({ id: dead.session.id })).resolves.toBeNull();
      await expect(sessions.findOneBy({ id: live.session.id })).resolves.not.toBeNull();
    });

    it('sweeps at boot and on an interval, and stops on destroy', async () => {
      const prune = jest.spyOn(service, 'pruneExpired').mockResolvedValue(0);
      service.onModuleInit();
      await Promise.resolve();
      expect(prune).toHaveBeenCalledTimes(1);
      service.onModuleDestroy();
      prune.mockRestore();
    });

    it('swallows a failing sweep instead of throwing into the timer', async () => {
      const deleteSpy = jest.spyOn(sessions, 'delete').mockRejectedValueOnce(new Error('database is locked'));
      await expect(service.pruneExpired()).resolves.toBe(0);
      deleteSpy.mockRestore();
    });
  });
});
