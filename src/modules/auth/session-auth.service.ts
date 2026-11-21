import { Injectable, OnModuleDestroy, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { In, IsNull, LessThanOrEqual, Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { UserSession } from './entities/user-session.entity';
import { ApiKey } from './entities/api-key.entity';
import { AuthService, UnresolvedApiKeyException } from './auth.service';
import { generateSessionToken, hashSessionToken } from './session-token';
import { setRequestActor } from '../../common/services/request-context';
import { createLogger } from '../../common/services/logger.service';

export interface IssuedSession {
  token: string;
  session: UserSession;
}

export interface ResolvedSession {
  user: User;
  session: UserSession;
  apiKey: ApiKey;
}

/** How stale `lastSeenAt` may get before another write. A write per request would be a write per request. */
const TOUCH_INTERVAL_MS = 5 * 60_000;

/**
 * A session lives seven days by default, so hourly is far more often than it needs to be — but the
 * sweep is one indexed DELETE and it keeps a table whose rows nobody reads from growing quietly.
 */
const PRUNE_INTERVAL_MS = 60 * 60_000;

/**
 * Issues and resolves dashboard sessions.
 *
 * A session is not a second principal type: resolving one ends at the user's linked `api_keys` row,
 * which is what the guard, the role hierarchy, the chat fence, the audit actor and the WebSocket
 * socket cap already understand. Nothing downstream needed a `request.user`.
 */
@Injectable()
export class SessionAuthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('SessionAuthService');
  private pruneTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(User, 'main')
    private readonly userRepository: Repository<User>,
    @InjectRepository(UserSession, 'main')
    private readonly sessionRepository: Repository<UserSession>,
    @InjectRepository(ApiKey, 'main')
    private readonly apiKeyRepository: Repository<ApiKey>,
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit(): void {
    void this.pruneExpired();
    this.pruneTimer = setInterval(() => void this.pruneExpired(), PRUNE_INTERVAL_MS);
    this.pruneTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
  }

  private ttlMs(): number {
    const hours = Number(this.configService.get<number>('auth.sessionTtlHours', 168));
    const safe = Number.isFinite(hours) && hours > 0 ? hours : 168;
    return safe * 3_600_000;
  }

  async issue(user: User, context: { ipAddress?: string; userAgent?: string } = {}): Promise<IssuedSession> {
    const token = generateSessionToken();
    const now = new Date();
    const session = this.sessionRepository.create({
      userId: user.id,
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(now.getTime() + this.ttlMs()),
      revokedAt: null,
      lastSeenAt: now,
      ipAddress: context.ipAddress ?? null,
      // The column is 255; a browser sends more than that for a few extensions.
      userAgent: context.userAgent ? context.userAgent.slice(0, 255) : null,
    });
    const saved = await this.sessionRepository.save(session);
    this.logger.log(`Session issued for user ${user.email}`, {
      userId: user.id,
      sessionId: saved.id,
      action: 'session_issued',
    });
    return { token, session: saved };
  }

  /**
   * Turns a raw token into its user and linked key, or throws the same 401 the key path throws.
   *
   * Every refusal is one message: naming whether the session expired, was revoked or belongs to a
   * disabled account would tell a token holder which one to try next, and none of them is actionable
   * to them anyway.
   */
  async resolve(rawToken: string, clientIp?: string): Promise<ResolvedSession> {
    const tokenHash = hashSessionToken(rawToken);
    const session = await this.sessionRepository.findOne({ where: { tokenHash } });
    if (!session) {
      // Same class the key path uses for "matched no row": the caller paid nothing to get here, so
      // its audit row is bounded per IP instead of letting a retry loop fill the log.
      throw new UnresolvedApiKeyException('Session is invalid or has expired');
    }

    const now = Date.now();
    if (session.revokedAt) {
      throw new UnauthorizedException('Session is invalid or has expired');
    }
    const expiresAt = new Date(session.expiresAt).getTime();
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      throw new UnauthorizedException('Session is invalid or has expired');
    }

    const user = await this.userRepository.findOne({ where: { id: session.userId } });
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Session is invalid or has expired');
    }

    const apiKey = await this.apiKeyRepository.findOne({ where: { id: user.apiKeyId } });
    if (!apiKey) {
      throw new UnauthorizedException('Session is invalid or has expired');
    }

    // The linked key carries the role and the scopes, so it is judged exactly as an API key would be:
    // a revoked or expired key, or an IP the key refuses, closes the session too.
    setRequestActor({ apiKeyId: apiKey.id, apiKeyName: apiKey.name });
    this.authService.assertKeyUsable(apiKey, clientIp);

    await this.touch(session);

    return { user, session, apiKey };
  }

  /** Coalesced so a busy dashboard does not write to SQLite on every request. */
  private async touch(session: UserSession): Promise<void> {
    const last = session.lastSeenAt ? new Date(session.lastSeenAt).getTime() : 0;
    if (Number.isFinite(last) && Date.now() - last < TOUCH_INTERVAL_MS) return;
    try {
      await this.sessionRepository.update({ id: session.id }, { lastSeenAt: new Date() });
    } catch {
      // Advisory: a failed touch must not fail the request it rode in on.
    }
  }

  /** Revokes one session. Returns false when the row does not exist or was already revoked. */
  async revoke(sessionId: string): Promise<boolean> {
    const result = await this.sessionRepository.update(
      { id: sessionId, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
    return (result.affected ?? 0) > 0;
  }

  /** Revokes every live session of a user, optionally keeping the one that made the request. */
  async revokeAllForUser(userId: string, exceptSessionId?: string): Promise<number> {
    const sessions = await this.sessionRepository.find({
      where: { userId, revokedAt: IsNull() },
    });
    const targets = sessions.filter(s => s.id !== exceptSessionId);
    if (targets.length === 0) return 0;
    await this.sessionRepository.update({ id: In(targets.map(s => s.id)) }, { revokedAt: new Date() });
    return targets.length;
  }

  async findActiveForUser(userId: string): Promise<UserSession[]> {
    return this.sessionRepository.find({
      where: { userId, revokedAt: IsNull() },
      order: { createdAt: 'DESC' },
    });
  }

  /** Batched state read for the WebSocket sweep: one query for every session-backed socket. */
  async findStates(ids: string[]): Promise<Map<string, UserSession>> {
    if (ids.length === 0) return new Map();
    const rows = await this.sessionRepository.findBy({ id: In(ids) });
    return new Map(rows.map(row => [row.id, row]));
  }

  /** Drops sessions that expired without being revoked, so the table does not grow without bound. */
  async pruneExpired(): Promise<number> {
    try {
      const result = await this.sessionRepository.delete({ expiresAt: LessThanOrEqual(new Date()) });
      const pruned = result.affected ?? 0;
      if (pruned > 0) {
        this.logger.log(`Pruned ${pruned} expired session(s)`, { pruned, action: 'sessions_pruned' });
      }
      return pruned;
    } catch (error) {
      // A background sweep must not crash the process; the next tick tries again.
      this.logger.warn(`Session prune failed: ${(error as Error).message}`);
      return 0;
    }
  }
}
