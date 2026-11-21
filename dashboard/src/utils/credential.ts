// The one credential slot. A tab is signed in with either an API key (`owa_k1_…`, a machine
// credential) or a dashboard session token (`owa_s1_…`, what an email + password login returns), and
// both travel in the same `X-API-Key` header — the gateway resolves the token to the account's linked
// key before the guard runs, so every other part of the dashboard needed no change.
//
// Everything that used to read `sessionStorage.getItem('openwa_api_key')` reads `readCredential()`
// instead. The storage key is unchanged on purpose: an existing tab keeps working across the upgrade.

export const CREDENTIAL_STORAGE_KEY = 'openwa_api_key';
export const SESSION_TOKEN_PREFIX = 'owa_s1_';

/** The account behind a session token, cached so the Users page can mark the caller's own row. */
const ACCOUNT_STORAGE_KEY = 'openwa_user';

export interface StoredAccount {
  id: string;
  email: string;
  name: string;
}

export function isSessionToken(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().startsWith(SESSION_TOKEN_PREFIX);
}

export function readCredential(): string | null {
  return sessionStorage.getItem(CREDENTIAL_STORAGE_KEY);
}

export function storeCredential(value: string): void {
  sessionStorage.setItem(CREDENTIAL_STORAGE_KEY, value);
}

export function clearCredential(): void {
  sessionStorage.removeItem(CREDENTIAL_STORAGE_KEY);
  clearStoredAccount();
}

/** True when the tab is signed in with an email/password session rather than a pasted API key. */
export function isSignedInAsUser(): boolean {
  return isSessionToken(readCredential());
}

export function readStoredAccount(): StoredAccount | null {
  const raw = sessionStorage.getItem(ACCOUNT_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof (parsed as StoredAccount).id === 'string' &&
      typeof (parsed as StoredAccount).email === 'string'
    ) {
      return {
        id: (parsed as StoredAccount).id,
        email: (parsed as StoredAccount).email,
        name: typeof (parsed as StoredAccount).name === 'string' ? (parsed as StoredAccount).name : '',
      };
    }
  } catch {
    // A corrupt entry is not worth failing a page render over; the identity is cosmetic.
  }
  return null;
}

export function storeAccount(account: StoredAccount | null): void {
  if (!account) {
    clearStoredAccount();
    return;
  }
  sessionStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(account));
}

export function clearStoredAccount(): void {
  sessionStorage.removeItem(ACCOUNT_STORAGE_KEY);
}
