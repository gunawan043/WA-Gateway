import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createLogger } from '../../../common/services/logger.service';
import {
  AlimCoreSsoClient,
  SsoExchangeError,
  SsoExchangeFailure,
  SsoExchangeInput,
  SsoExchangeResult,
} from './alim-core-sso.client';

interface CoreEnvelope {
  success?: boolean;
  message?: string;
  data?: Record<string, unknown> | null;
  errors?: { code?: string; context?: Record<string, unknown> } | null;
  code?: string;
}

/** The Core error codes the exchange contract names, keyed to the Connect outcome. */
const CORE_CODE_REASONS: Record<string, SsoExchangeFailure> = {
  insufficient_scope: 'insufficient_scope',
  audience_mismatch: 'audience_mismatch',
  scope_mismatch: 'scope_mismatch',
  user_inactive: 'user_inactive',
  permission_revoked: 'permission_revoked',
  code_not_found: 'code_not_found',
  code_already_used: 'code_already_used',
  code_expired: 'code_expired',
  invalid_payload: 'invalid_payload',
  code_required: 'code_required',
};

/**
 * The real HTTP client for `POST /api/connect/v1/sso/exchange`.
 *
 * Three rules the class exists to keep:
 *
 *  1. **No retry.** The code is one-time. Retrying a request whose response was lost would burn the
 *     code and could make a second session look like a first redemption; the person restarts the
 *     handoff from Core instead.
 *  2. **No secrets in the log.** The SSO key and the raw code never appear in a log line. Only the
 *     classified reason, the HTTP status and Core's error code are recorded.
 *  3. **No inference from a timeout.** A timeout is `core_timeout`, never "probably fine". A
 *     session is only minted from an explicit, successful exchange response.
 */
@Injectable()
export class HttpAlimCoreSsoClient implements AlimCoreSsoClient {
  private readonly logger = createLogger(HttpAlimCoreSsoClient.name);

  constructor(private readonly config: ConfigService) {}

  async exchange(input: SsoExchangeInput): Promise<SsoExchangeResult> {
    const baseUrl = (this.config.get<string>('connect.sso.coreBaseUrl') ?? '').replace(/\/+$/, '');
    const apiKey = this.config.get<string>('connect.sso.apiKey') ?? '';
    const header = this.config.get<string>('connect.sso.apiHeader') ?? 'X-ALIM-CONNECT-SSO-KEY';
    const timeoutMs = this.config.get<number>('connect.sso.timeoutMs') ?? 5000;
    const audience = this.config.get<string>('connect.sso.audience') ?? 'connect';
    const scope = this.config.get<string>('connect.sso.scope') ?? 'whatsapp.embed';

    if (baseUrl === '' || apiKey === '') {
      // Deliberately not a request: an unconfigured integration must not look like a Core refusal,
      // and it must never fall back to a mock that could mint a session without Core.
      return this.failure('not_configured', 0, null, 'ALIM Core SSO belum dikonfigurasi pada Connect.');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${baseUrl}/api/connect/v1/sso/exchange`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          [header]: apiKey,
        },
        body: JSON.stringify({
          code: input.code,
          audience,
          scope,
          ...(input.state ? { state: input.state } : {}),
        }),
        signal: controller.signal,
      });

      const body = (await response.json().catch(() => null)) as CoreEnvelope | null;
      return this.mapResponse(response.status, body, audience, scope);
    } catch (error) {
      // Node wraps an abort in `TypeError: fetch failed` with an AbortError cause; the signal is
      // the authoritative check.
      const aborted = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
      const reason: SsoExchangeFailure = aborted ? 'core_timeout' : 'core_unreachable';
      // The error's message can contain the request URL but never the body, so it is safe; the code
      // is not part of it. Kept to one line and no key.
      this.logger.warn(`SSO exchange gagal menghubungi Core: ${reason}`);
      return this.failure(
        reason,
        aborted ? 504 : 0,
        null,
        aborted ? 'ALIM Core tidak merespons tepat waktu.' : 'ALIM Core tidak dapat dihubungi.',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private mapResponse(
    status: number,
    body: CoreEnvelope | null,
    expectedAudience: string,
    expectedScope: string,
  ): SsoExchangeResult {
    // Core's other integration endpoints answer with `{ success, data, errors }`; the SSO contract
    // describes the fields directly. Both shapes are accepted so a wrapper is never mistaken for a
    // missing identity, and neither is guessed at.
    const payload = isRecord(body?.data) ? body.data : body;
    const code = body?.errors?.code ?? body?.code ?? null;

    if (status >= 200 && status < 300 && body?.success !== false) {
      return this.mapSuccess(payload, expectedAudience, expectedScope, code);
    }

    const reason = this.reasonFor(status, code);
    const message = body?.message ?? `ALIM Core menjawab HTTP ${status}.`;
    // Only the classification is logged. Core's message is returned to the caller (it is written
    // for an operator and never carries the code), but the code itself is not echoed.
    this.logger.warn(`SSO exchange ditolak: ${reason} (HTTP ${status}${code ? `, ${code}` : ''})`);
    return this.failure(reason, status, code, message);
  }

  private mapSuccess(
    payload: CoreEnvelope | Record<string, unknown> | null,
    expectedAudience: string,
    expectedScope: string,
    code: string | null,
  ): SsoExchangeResult {
    if (!isRecord(payload)) {
      return this.failure('contract_mismatch', 200, code, 'ALIM Core tidak mengirim data exchange.');
    }

    const coreUserId = typeof payload.core_user_id === 'string' ? payload.core_user_id.trim() : '';
    if (coreUserId === '') {
      return this.failure('contract_mismatch', 200, code, 'ALIM Core tidak mengirim core_user_id.');
    }

    const audience = typeof payload.audience === 'string' ? payload.audience : null;
    const scope = typeof payload.scope === 'string' ? payload.scope : null;
    if (audience !== null && audience !== expectedAudience) {
      return this.failure('audience_mismatch', 200, code, 'Audience exchange tidak sesuai.');
    }
    if (scope !== null && scope !== expectedScope) {
      return this.failure('scope_mismatch', 200, code, 'Scope exchange tidak sesuai.');
    }

    return {
      ok: true,
      identity: {
        coreUserId,
        name: typeof payload.name === 'string' ? payload.name : null,
        email: typeof payload.email === 'string' ? payload.email : null,
        audience: audience ?? expectedAudience,
        scope: scope ?? expectedScope,
        issuedAt: typeof payload.issued_at === 'string' ? payload.issued_at : null,
        redeemedAt: typeof payload.redeemed_at === 'string' ? payload.redeemed_at : null,
      },
    };
  }

  private reasonFor(status: number, code: string | null): SsoExchangeFailure {
    if (code && CORE_CODE_REASONS[code]) return CORE_CODE_REASONS[code];
    if (status === 401) return 'invalid_key';
    if (status === 404) return 'code_not_found';
    if (status === 409) return 'code_already_used';
    if (status === 410) return 'code_expired';
    if (status === 422) return 'invalid_payload';
    return 'core_error';
  }

  private failure(
    reason: SsoExchangeFailure,
    httpStatus: number,
    code: string | null,
    message: string,
  ): SsoExchangeError {
    return { ok: false, reason, httpStatus, code, message };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
