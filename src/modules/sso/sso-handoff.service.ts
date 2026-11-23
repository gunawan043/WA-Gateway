import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createLogger } from '../../common/services/logger.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { SessionAuthService } from '../auth/session-auth.service';
import { UsersService } from '../auth/users.service';
import {
  ALIM_CORE_SSO_CLIENT,
  type AlimCoreSsoClient,
  type SsoExchangeFailure,
} from './core-client/alim-core-sso.client';

export type HandoffFailure = SsoExchangeFailure | 'identity_not_mapped' | 'account_disabled' | 'session_issue_failed';

export interface HandoffSuccess {
  ok: true;
  token: string;
  sessionId: string;
  userId: string;
  expiresAt: string;
}

export interface HandoffError {
  ok: false;
  reason: HandoffFailure;
  message: string;
}

export type HandoffResult = HandoffSuccess | HandoffError;

export interface HandoffInput {
  code: string;
  state?: string;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Turns a handoff code into a Connect session, in the only order that is safe:
 *
 *   1. Core redeems the code (server-to-server, one-time).
 *   2. The returned `core_user_id` is mapped to an EXISTING, ACTIVE Connect account.
 *   3. Only then is a session row written.
 *
 * A failure at any step returns without touching `user_sessions`, so an invalid, expired, reused or
 * revoked handoff can never leave a session behind. Core's role/assignment data is never read: the
 * mapped account's own Connect role and grants are what the workspace enforces afterwards.
 *
 * Every refusal in steps 2 and 3 is also recorded in the audit trail. Step 1 (Core's verdict) is not:
 * a wrong code is far more often a mistyped URL than an attack, and Core keeps the authoritative
 * record of its own redemption. The gap that mattered was the opposite one — a code that Core said
 * yes to, refused by Connect's own mapping, left no trace at all in a deployment shipping with the
 * file logger. That is exactly what an operator has to reconstruct by hand, so it is recorded here.
 */
@Injectable()
export class SsoHandoffService {
  private readonly logger = createLogger(SsoHandoffService.name);

  constructor(
    @Inject(ALIM_CORE_SSO_CLIENT) private readonly client: AlimCoreSsoClient,
    private readonly users: UsersService,
    private readonly sessions: SessionAuthService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  async complete(input: HandoffInput): Promise<HandoffResult> {
    const code = input.code.trim();
    if (code === '') {
      return { ok: false, reason: 'code_required', message: 'Kode handoff tidak dikirim.' };
    }

    const exchange = await this.client.exchange({ code, state: input.state });
    if (!exchange.ok) {
      // The code and the key are not in this line, and never will be. `reason` is enough to tell an
      // expired handoff from a revoked permission in the log and in the audit trail.
      this.logger.warn(`SSO handoff ditolak pada exchange: ${exchange.reason}`);
      return { ok: false, reason: exchange.reason, message: exchange.message };
    }

    // `core_user_id` is the only mapping key. Name and email are deliberately not consulted: Core
    // may change either, and an account created by guessing is exactly what must not happen.
    const user = await this.users.findByCoreUserId(exchange.identity.coreUserId);
    if (!user) {
      this.logger.warn('SSO handoff ditolak: identitas Core belum dipetakan ke akun Connect');
      await this.auditRefusal('identity_not_mapped', exchange.identity.coreUserId, input);
      return {
        ok: false,
        reason: 'identity_not_mapped',
        message: 'Akun ALIM Core ini belum dipetakan ke akun ALIM Connect.',
      };
    }
    if (!user.isActive) {
      this.logger.warn(`SSO handoff ditolak: akun Connect ${user.id} dinonaktifkan`);
      await this.auditRefusal('account_disabled', exchange.identity.coreUserId, input, user.id);
      return {
        ok: false,
        reason: 'account_disabled',
        message: 'Akun ALIM Connect untuk pengguna ini dinonaktifkan.',
      };
    }

    // A brand-new session id every time: the token is generated here, so there is no identifier an
    // attacker could pre-set (session fixation). The row is what makes logout and expiry immediate.
    const configuredTtl = Number(this.config.get<number>('connect.sso.sessionTtlHours', 0));
    const ttlMs = Number.isFinite(configuredTtl) && configuredTtl > 0 ? configuredTtl * 3_600_000 : undefined;

    try {
      const { token, session } = await this.sessions.issue(
        user,
        { ipAddress: input.ipAddress, userAgent: input.userAgent },
        { ttlMs },
      );

      // Best effort: a failed audit write must not cost the person a session that already exists.
      await this.audit
        .logInfo(AuditAction.USER_LOGIN_SUCCEEDED, {
          ipAddress: input.ipAddress,
          method: 'POST',
          path: '/sso/handoff',
          metadata: { userId: user.id, sessionId: session.id, via: 'alim_core_sso' },
        })
        .catch(error => {
          this.logger.warn(`Audit login SSO gagal ditulis: ${(error as Error).message}`);
        });

      return {
        ok: true,
        token,
        sessionId: session.id,
        userId: user.id,
        expiresAt: new Date(session.expiresAt).toISOString(),
      };
    } catch (error) {
      this.logger.error(`Gagal membuat sesi SSO: ${(error as Error).message}`);
      await this.auditRefusal('session_issue_failed', exchange.identity.coreUserId, input, user.id);
      return {
        ok: false,
        reason: 'session_issue_failed',
        message: 'Sesi ALIM Connect tidak dapat dibuat. Coba lagi dari ALIM Core.',
      };
    }
  }

  /**
   * Records a refusal that happens *after* Core said yes.
   *
   * `core_user_id` is Core's own identifier for a person, which is exactly what an operator needs to
   * reconcile a refused handoff with Core; the code, the key and the token are never part of it.
   * Best effort, like the success row: the person's outcome does not depend on the audit write.
   */
  private async auditRefusal(
    reason: 'identity_not_mapped' | 'account_disabled' | 'session_issue_failed',
    coreUserId: string,
    input: HandoffInput,
    userId?: string,
  ): Promise<void> {
    await this.audit
      .logWarn(AuditAction.USER_LOGIN_FAILED, {
        ipAddress: input.ipAddress,
        method: 'POST',
        path: '/sso/handoff',
        metadata: {
          reason,
          via: 'alim_core_sso',
          coreUserId,
          ...(userId !== undefined ? { userId } : {}),
        },
      })
      .catch(error => {
        this.logger.warn(`Audit penolakan SSO gagal ditulis: ${(error as Error).message}`);
      });
  }
}
