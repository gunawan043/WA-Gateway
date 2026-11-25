import { isIP } from 'net';

/** `localhost`, any `127.x.x.x`, or IPv6 `::1`. `URL` reports the IPv6 form with its brackets. */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
}

/**
 * Whether a configured ALIM Core URL is one a production Connect may send credentials to.
 *
 * The approval key and the SSO key travel in request headers, and the handoff code travels in a body
 * that Core then redeems: over plain HTTP any hop between Connect and Core can read and replay them.
 * Loopback is the one place `http://` stays valid — the local Core a developer runs, where there is no
 * hop to intercept — and it is named as a loopback address, never as "anything not https" so a
 * staging or production host cannot slip through a typo.
 *
 * Returns a reason naming what to fix (never echoing a credential), or `null` when the URL is
 * acceptable. A URL that cannot be parsed is refused: a typo must fail loudly here rather than turn
 * every Core call into an unreachable-host error later.
 */
export function insecureCoreUrlReason(rawUrl: string): string | null {
  const value = (rawUrl ?? '').trim();
  if (value === '') return null; // unset is another guard's business (the approval client policy)

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'ALIM_CORE_BASE_URL is not a URL';
  }

  if (url.protocol === 'https:') return null;
  if (url.protocol !== 'http:') return 'ALIM_CORE_BASE_URL must be https://';

  // `[::1]` comes back from URL with its brackets.
  if (isLoopbackHost(url.hostname)) return null;

  return 'ALIM_CORE_BASE_URL must be https:// outside loopback: the approval and SSO keys travel in its headers';
}

/**
 * Whether production may trust the configured browser origin of ALIM Core.
 *
 * That origin is the ONE site allowed to embed the Connect workspace in an iframe and to post a
 * one-time handoff code to it. A plaintext origin in production lets anyone on the path substitute
 * that site, so it is refused rather than accepted-and-logged. Local development against a loopback
 * Core stays possible for the same reason as {@link insecureCoreUrlReason}.
 *
 * `null`/empty and unparseable values are not this check's business: they already resolve to
 * "SSO not configured" in parseCoreWebOrigin.
 */
export function insecureCoreOriginReason(rawOrigin: string | undefined | null): string | null {
  const value = (rawOrigin ?? '').trim();
  if (value === '') return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:') return null;
  if (isLoopbackHost(url.hostname)) return null;

  return 'ALIM_CORE_WEB_ORIGIN must be https:// in production: it is the only site allowed to embed Connect and post a handoff code';
}

/**
 * Every transport problem a production boot must refuse, named by variable. Used by the boot guard so
 * one message lists all of them instead of the operator fixing one, restarting, and meeting the next.
 */
export function coreTransportProblems(env: { coreBaseUrl?: string; coreWebOrigin?: string }): string[] {
  const reasons: Array<string | null> = [];
  const reason = insecureCoreUrlReason(env.coreBaseUrl ?? '');
  if (reason) reasons.push(reason);
  const origin = insecureCoreOriginReason(env.coreWebOrigin);
  if (origin) reasons.push(origin);
  return reasons.filter((reason): reason is string => reason !== null);
}

/**
 * The production gate for the two Core URLs. Mirrors {@link assertApprovalCoreClientAllowed}: an
 * unsafe production configuration must fail the boot, not run until the first reply exposes it.
 *
 * `coreIntegrationDisabled` is the one way past this gate, and it does NOT relax the check: with the
 * integration switched off there is no Core URL in use and no key to send, so there is no transport
 * to judge. Any URL that IS configured is still validated, so turning the integration off cannot be
 * used to sneak a plaintext URL into a config file.
 */
export function assertCoreTransportAllowed(
  env: { coreBaseUrl?: string; coreWebOrigin?: string },
  nodeEnv: string | undefined = process.env.NODE_ENV,
  coreIntegrationDisabled = false,
): void {
  if (nodeEnv !== 'production') return;
  // Disabling the integration excuses an ABSENT Core URL, never an unsafe one: a plaintext URL left
  // in the config would be waiting for whoever flips the flag back on.
  const coreBaseUrl =
    coreIntegrationDisabled && !(env.coreBaseUrl ?? '').trim() ? 'https://unused.invalid' : env.coreBaseUrl;
  const problems = coreTransportProblems({ coreBaseUrl, coreWebOrigin: env.coreWebOrigin });
  if (problems.length > 0) throw new Error(`ALIM Core transport refused in production: ${problems.join('; ')}`);
}
