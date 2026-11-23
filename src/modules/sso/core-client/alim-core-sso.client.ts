/**
 * The Connect side of `POST /api/connect/v1/sso/exchange`.
 *
 * Core is the only party that can redeem a handoff code. Connect never decides that a code is
 * valid from anything the browser sent: the browser supplies an opaque string, Connect asks Core,
 * and only Core's answer is used.
 */

export const ALIM_CORE_SSO_CLIENT = Symbol('ALIM_CORE_SSO_CLIENT');

/**
 * Every way an exchange can fail, as the Connect UI and the audit trail need to distinguish them.
 *
 * `invalid_key` is a Connect configuration fault (502 to the browser), not something the person
 * can fix. The rest are outcomes Core decided, and each gets its own page so the person knows
 * whether to restart the handoff from Core or ask an administrator.
 */
export type SsoExchangeFailure =
  | 'not_configured'
  | 'invalid_key'
  | 'insufficient_scope'
  | 'audience_mismatch'
  | 'scope_mismatch'
  | 'user_inactive'
  | 'permission_revoked'
  | 'code_not_found'
  | 'code_already_used'
  | 'code_expired'
  | 'invalid_payload'
  | 'code_required'
  | 'contract_mismatch'
  | 'core_unreachable'
  | 'core_timeout'
  | 'core_error';

export interface SsoIdentity {
  coreUserId: string;
  /** Descriptive only. Never used to find the Connect account. */
  name: string | null;
  /** Descriptive only. Never used to find the Connect account. */
  email: string | null;
  audience: string;
  scope: string;
  issuedAt: string | null;
  redeemedAt: string | null;
}

export interface SsoExchangeSuccess {
  ok: true;
  identity: SsoIdentity;
}

export interface SsoExchangeError {
  ok: false;
  reason: SsoExchangeFailure;
  /** 0 when no HTTP response was received (connection refused, DNS failure, timeout). */
  httpStatus: number;
  /** Core's `errors.code`, when it sent one. Never contains the code or the key. */
  code: string | null;
  message: string;
}

export type SsoExchangeResult = SsoExchangeSuccess | SsoExchangeError;

export interface SsoExchangeInput {
  code: string;
  state?: string;
}

export interface AlimCoreSsoClient {
  exchange(input: SsoExchangeInput): Promise<SsoExchangeResult>;
}
