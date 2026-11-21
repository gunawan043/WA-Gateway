import { randomBytes } from 'crypto';
import { hashApiKey } from './api-key-hash';

/**
 * Dashboard session tokens.
 *
 * Opaque and revocable, not a JWT: the row in `user_sessions` is the authority, so logging out or
 * resetting a password cuts a live browser off immediately instead of waiting for an expiry. The
 * prefix lets the API-key guard tell the two credentials apart without a second header or a lookup
 * attempt against `api_keys`.
 *
 * `owa_s1_` is deliberately distinct from `owa_k1_` (API keys). A master key that happened to start
 * with this prefix would be read as a session token and never authenticate, which is why
 * `resolveSeedApiKey` refuses one.
 */
export const SESSION_TOKEN_PREFIX = 'owa_s1_';

export function isSessionToken(raw: string | null | undefined): boolean {
  return typeof raw === 'string' && raw.trim().startsWith(SESSION_TOKEN_PREFIX);
}

export function generateSessionToken(): string {
  return `${SESSION_TOKEN_PREFIX}${randomBytes(32).toString('hex')}`;
}

/**
 * Same hashing as an API key (SHA-256, or HMAC when API_KEY_PEPPER is set): the token is 256 random
 * bits, so a slow KDF buys nothing here. Trimmed for the same reason validateApiKey trims.
 */
export function hashSessionToken(raw: string): string {
  return hashApiKey(raw.trim(), process.env.API_KEY_PEPPER);
}
