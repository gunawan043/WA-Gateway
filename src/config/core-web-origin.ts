/**
 * The browser origin of ALIM Core, as configured for the WhatsApp Connect SSO handoff.
 *
 * Two separate trust decisions read this value and must never disagree:
 *
 *  1. `frame-ancestors` in the Content-Security-Policy — the only origin allowed to embed the
 *     Connect workspace in an iframe.
 *  2. The `Origin` allowlist on `POST /api/sso/handoff` — the only browser origin allowed to post a
 *     one-time handoff code into Connect.
 *
 * Both are exact matches. A wildcard is refused rather than narrowed: `https://*.example.com`
 * cannot be expressed in `frame-ancestors` without also matching an origin the operator did not
 * intend, and silently falling back to `'self'` would make the feature look configured while every
 * handoff failed. An invalid value therefore yields `null`, which callers treat as "SSO not
 * configured", and the CSP keeps its default `frame-ancestors 'self'`.
 */
export function parseCoreWebOrigin(raw: string | undefined | null): string | null {
  const value = raw?.trim();
  if (!value) return null;
  // A wildcard is not an origin. Refuse it outright instead of letting `new URL` accept a host it
  // cannot mean.
  if (value.includes('*')) return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  // The handoff posts credentials in a form body and the workspace carries a session token, so a
  // plaintext Core origin is only tolerable for a loopback development host.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  // An origin has no path, query or fragment. `https://core.example/app` is a page, not an origin,
  // and comparing it against a browser's `Origin` header (which never carries a path) would always
  // fail — better to refuse the configuration than to accept a value that cannot work.
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;

  return url.origin;
}

/** The `frame-ancestors` directive for a configured Core origin. Never emits a wildcard. */
export function frameAncestorsFor(coreWebOrigin: string | null): string[] {
  return coreWebOrigin ? ["'self'", coreWebOrigin] : ["'self'"];
}

/**
 * Whether a browser-supplied `Origin` (or a `Referer` fallback) is the configured Core origin.
 *
 * A cross-origin form POST always carries `Origin` in a current browser, so a missing header is
 * refused rather than assumed. `Referer` is only a fallback for a client that strips `Origin`; it
 * is parsed down to its origin, and a value that does not parse is refused.
 */
export function isAllowedHandoffOrigin(
  originHeader: string | undefined,
  refererHeader: string | undefined,
  coreWebOrigin: string | null,
): boolean {
  if (!coreWebOrigin) return false;
  const candidate = normalizeOrigin(originHeader) ?? normalizeOrigin(refererHeader);
  return candidate !== null && candidate === coreWebOrigin;
}

function normalizeOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  // `Origin: null` is what a sandboxed iframe sends. It names no origin and is not an allowlist hit.
  if (raw.trim().toLowerCase() === 'null') return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}
