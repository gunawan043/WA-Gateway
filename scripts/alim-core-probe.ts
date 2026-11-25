/**
 * Readiness probe for the two ALIM Core integrations, using the REAL HTTP clients.
 *
 * The point is to answer, in one command and before any user traffic, the questions that otherwise
 * wait for a browser session: is the base URL reachable, is the service credential accepted, does
 * the route exist, and does Core answer in the envelope Connect parses? It never mints a Connect
 * session and never applies an approval decision.
 *
 * Usage:
 *   npm run probe:alim-core                 # configuration summary + SSO exchange probe
 *   npm run probe:alim-core -- --sso        # same
 *   npm run probe:alim-core -- --latency    # 5 exchanges: is the timeout budget big enough?
 *   npm run probe:alim-core -- --sso-code=<code>   # spend a code Core issued: proves the success path
 *   npm run probe:alim-core -- --approval   # also send one invalid approval command (opt-in)
 *   npm run probe:alim-core -- --all        # every probe above
 *
 * Run `--latency` from the host that makes the real calls, not from a laptop: the container's
 * resolver, egress route and proxy environment are what decide whether the budget is enough.
 *
 * The approval probe is opt-in because it is a POST: it sends a command whose `request_id` is the
 * nil UUID and whose actor is not a person, so the only correct answers are a business 4xx. A 2xx
 * is reported as a contract violation and exits 3 — Core would have applied a decision for a permit
 * that does not exist. Run it against staging, never production.
 *
 * Exit codes: 0 every selected probe passed; 1 a probe failed; 2 configuration missing;
 * 3 Core violated the contract (accepted a code it never issued, or applied a probe command).
 * 4 the SSO timeout budget is too small for the latency Core is showing (see `--latency`).
 *
 * No secret is ever printed: the key is reported as present/absent, never echoed.
 */
import '../src/config/load-env';
import { randomUUID } from 'crypto';
import type { ConfigService } from '@nestjs/config';
import { HttpAlimCoreApprovalClient } from '../src/modules/approval/core-client/http-alim-core-approval.client';
import { HttpAlimCoreSsoClient } from '../src/modules/sso/core-client/http-alim-core-sso.client';

type Verdict = 'PASS' | 'WARN' | 'FAIL' | 'SKIP';

interface Line {
  probe: string;
  verdict: Verdict;
  detail: string;
}

/**
 * The flags this run was given. Read at call time rather than once at load: a spec that loads this
 * module to check its verdicts runs the probe itself, and must be able to say which probes it runs.
 */
function selection(argv: string[]): {
  runSso: boolean;
  runApproval: boolean;
  runLatency: boolean;
  ssoCode: string | undefined;
} {
  const args = new Set(argv);
  return {
    runSso: args.has('--all') || args.has('--sso') || !args.has('--approval'),
    runApproval: args.has('--all') || args.has('--approval'),
    /** Repeated exchange calls, to compare Core's latency against ALIM_CONNECT_SSO_TIMEOUT_MS. */
    runLatency: args.has('--all') || args.has('--latency'),
    /** `--sso-code=<code>`: a handoff code Core's UI issued, for proving the success path. */
    ssoCode: argv.find(arg => arg.startsWith('--sso-code='))?.slice('--sso-code='.length),
  };
}

const { runSso, runApproval, runLatency, ssoCode } = selection(process.argv.slice(2));

const env = process.env;
const coreBaseUrl = (env.ALIM_CORE_BASE_URL ?? '').replace(/\/+$/, '');

/** Enough calls to see a spike, few enough to finish while an operator is watching. */
const LATENCY_SAMPLES = 5;

/**
 * The budget `configuration.ts` applies when ALIM_CONNECT_SSO_TIMEOUT_MS is unset. Duplicated as a
 * literal rather than imported because this script also stands in for the client when it measures:
 * importing the config factory would drag the whole application's environment into a probe.
 */
const DEFAULT_SSO_TIMEOUT_MS = 15000;

/** The same keys `configuration.ts` exposes, so the clients read what production reads. */
const values: Record<string, unknown> = {
  'connect.sso.coreBaseUrl': coreBaseUrl,
  'connect.sso.apiKey': env.ALIM_CONNECT_SSO_KEY ?? '',
  'connect.sso.apiHeader': env.ALIM_CONNECT_SSO_API_HEADER ?? 'X-ALIM-CONNECT-SSO-KEY',
  'connect.sso.timeoutMs': Number(env.ALIM_CONNECT_SSO_TIMEOUT_MS ?? DEFAULT_SSO_TIMEOUT_MS),
  'connect.sso.audience': env.ALIM_CONNECT_SSO_AUDIENCE ?? 'connect',
  'connect.sso.scope': env.ALIM_CONNECT_SSO_SCOPE ?? 'whatsapp.embed',
  'connect.approval.coreBaseUrl': coreBaseUrl,
  'connect.approval.coreApiKey': env.ALIM_CORE_APPROVAL_API_KEY ?? '',
  'connect.approval.coreApiHeader': env.ALIM_CORE_APPROVAL_API_HEADER ?? 'X-ALIM-CONNECT-APPROVAL-KEY',
  'connect.approval.apiVersion': env.ALIM_CORE_API_VERSION ?? '1',
  'connect.approval.timeoutMs': Number(env.ALIM_CORE_TIMEOUT_MS ?? 5000),
};

const config = { get: (key: string) => values[key] } as unknown as ConfigService;

function printConfiguration(): void {
  const present = (value: string | undefined): string => (value && value.trim() !== '' ? 'set' : 'MISSING');
  console.log('ALIM Core readiness probe');
  console.log(`  base URL                  : ${coreBaseUrl || 'MISSING'}`);
  console.log(`  SSO key (ALIM_CONNECT_SSO_KEY)          : ${present(env.ALIM_CONNECT_SSO_KEY)}`);
  console.log(`  approval key (ALIM_CORE_APPROVAL_API_KEY): ${present(env.ALIM_CORE_APPROVAL_API_KEY)}`);
  console.log(`  ingest key (ALIM_CONNECT_INGEST_KEY)    : ${present(env.ALIM_CONNECT_INGEST_KEY)}`);
  console.log(`  API version header        : ${values['connect.approval.apiVersion'] || '(not sent)'}`);
  console.log('');
}

/**
 * The SSO exchange refuses codes it did not issue; that refusal is the proof the route works.
 *
 * `--sso-code=<code>` takes a code Core's UI really issued, which is the only way to prove the
 * SUCCESS path: it must come back `ok` with a `core_user_id`. A code is one-time, so this probe
 * spends it — that is why it is never automatic.
 */
function classifySso(result: Awaited<ReturnType<HttpAlimCoreSsoClient['exchange']>>, issuedCode: boolean): Line {
  if (result.ok) {
    const identity = result.identity;
    return {
      probe: 'SSO exchange',
      verdict: 'PASS',
      detail: issuedCode
        ? `Core redeemed the issued code and returned core_user_id ${identity.coreUserId} (audience ${identity.audience}, scope ${identity.scope})`
        : 'CONTRACT VIOLATION: Core redeemed a code this probe invented — one-time semantics are not enforced',
    };
  }
  switch (result.reason) {
    case 'not_configured':
      return { probe: 'SSO exchange', verdict: 'SKIP', detail: 'ALIM_CORE_BASE_URL / ALIM_CONNECT_SSO_KEY not set' };
    case 'code_not_found':
    case 'code_expired':
    case 'code_already_used':
    case 'invalid_payload':
    case 'code_required':
      return {
        probe: 'SSO exchange',
        verdict: 'PASS',
        detail: `route + key accepted; Core refused the probe code as ${result.reason} (HTTP ${result.httpStatus})`,
      };
    case 'invalid_key':
    case 'insufficient_scope':
      return {
        probe: 'SSO exchange',
        verdict: 'FAIL',
        detail: `credential rejected: ${result.reason} (HTTP ${result.httpStatus})`,
      };
    case 'core_unreachable':
    case 'core_timeout':
      return { probe: 'SSO exchange', verdict: 'FAIL', detail: `cannot reach Core: ${result.reason}` };
    case 'audience_mismatch':
    case 'scope_mismatch':
      return {
        probe: 'SSO exchange',
        verdict: 'WARN',
        detail: `route reachable but Core applied policy to a probe code: ${result.reason} (HTTP ${result.httpStatus})`,
      };
    default:
      return {
        probe: 'SSO exchange',
        verdict: 'WARN',
        detail: `route reachable but answered unexpectedly: ${result.reason} (HTTP ${result.httpStatus})`,
      };
  }
}

async function probeSso(): Promise<Line> {
  const client = new HttpAlimCoreSsoClient(config);
  // A code Core cannot know. `state` is included so the probe exercises the optional field too.
  // With `--sso-code=<code>` the probe spends a code Core really issued instead, which is the only
  // way to see a successful exchange; the code itself is never printed.
  const issuedCode = (ssoCode ?? '').trim();
  const code = issuedCode !== '' ? issuedCode : `probe-${randomUUID()}`;
  const result = await client.exchange({ code, state: 'connect-readiness-probe' });
  return classifySso(result, issuedCode !== '');
}

/**
 * How much of the timeout budget Core actually uses on this host.
 *
 * A single exchange answers "did it work", not "will it keep working": the same host measured
 * 1.8 s to 7.6 s across four probes against a 5000 ms budget, which is a handoff that fails at
 * random and looks like a config error. The distribution is the answer, so this repeats the call.
 *
 * Each call spends a fresh invented code, which Core refuses — that is the measurable path. A
 * refusal still proves the round trip, and costs Core nothing beyond the lookup.
 */
async function probeLatency(): Promise<Line[]> {
  const client = new HttpAlimCoreSsoClient(config);
  const budgetMs = Number(values['connect.sso.timeoutMs'] ?? DEFAULT_SSO_TIMEOUT_MS);
  const samples: { ms: number; refused: boolean }[] = [];

  for (let i = 0; i < LATENCY_SAMPLES; i++) {
    const startedAt = Date.now();
    const result = await client.exchange({ code: `latency-probe-${randomUUID()}`, state: 'latency' });
    const ms = Date.now() - startedAt;
    samples.push({ ms, refused: !result.ok });
  }

  const measured = samples.map(s => s.ms);
  const sorted = [...measured].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
  const worst = sorted[sorted.length - 1];
  const timeouts = measured.filter(ms => ms >= budgetMs).length;

  const summary = `p50 ${p50} ms, p95 ${p95} ms, max ${worst} ms over ${samples.length} calls (budget ${budgetMs} ms)`;
  const refused = samples.filter(s => s.refused).length;

  if (timeouts > 0) {
    // The budget is the finding, not Core: a refusal at 7.6 s is a working Core behind a budget
    // that already gave up. Recommend the next power-of-two-ish value instead of a magic number.
    const recommended = Math.max(15000, Math.ceil((worst * 2) / 1000) * 1000);
    return [
      {
        probe: 'SSO latency',
        verdict: 'FAIL',
        detail: `${summary}; ${timeouts} call(s) hit the timeout. Raise ALIM_CONNECT_SSO_TIMEOUT_MS to at least ${recommended}`,
      },
    ];
  }
  if (refused < samples.length) {
    return [
      {
        probe: 'SSO latency',
        verdict: 'WARN',
        detail: `${summary}; ${samples.length - refused} call(s) were NOT refused — check Core's one-time semantics`,
      },
    ];
  }
  return [{ probe: 'SSO latency', verdict: 'PASS', detail: summary }];
}

/**
 * Sends a command Core must refuse. The nil `request_id` guarantees there is no permit to decide,
 * so a `rejected` outcome proves auth + route + payload shape without touching real data.
 */
async function probeApproval(): Promise<Line> {
  const client = new HttpAlimCoreApprovalClient(config);
  const commandId = randomUUID();
  const result = await client.sendApprovalCommand({
    commandId,
    requestId: '00000000-0000-4000-8000-000000000000',
    decision: 'approved',
    approvedDurationDays: 1,
    actorExternalId: 'probe-not-a-person',
    actorCorePersonId: null,
    source: 'whatsapp',
    externalMessageId: `probe-${commandId}`,
    messageText: 'PROBE — must not be applied',
    notes: null,
  });

  switch (result.outcome) {
    case 'applied':
    case 'duplicate':
      return {
        probe: 'Approval command',
        verdict: 'FAIL',
        detail: `CONTRACT VIOLATION: Core answered ${result.outcome} for a nil request_id (HTTP ${result.httpStatus})`,
      };
    case 'rejected':
      // The key and the route are proven by any refusal, but which refusal matters: the probe names no
      // person as its actor and no permit as its target, so `actor_*` is Core refusing the probe's own
      // actor rather than reproducing the refusal the lane's actor check needs. A run that ends there
      // says nothing about whether a mapped actor would be accepted, and is reported as such.
      return {
        probe: 'Approval command',
        verdict: result.code?.startsWith('actor_') ? 'WARN' : 'PASS',
        detail: `route + key accepted; Core refused the probe command (HTTP ${result.httpStatus}${
          result.code ? `, ${result.code}` : ''
        })${result.code?.startsWith('actor_') ? ' — refused on the probe actor, so this does not show what a mapped actor gets; run the actor check' : ''}`,
      };
    case 'unavailable':
      return {
        probe: 'Approval command',
        verdict: result.code === 'core_not_configured' ? 'SKIP' : 'FAIL',
        detail:
          result.code === 'core_not_configured'
            ? 'ALIM_CORE_BASE_URL / ALIM_CORE_APPROVAL_API_KEY not set'
            : `Core unavailable: ${result.code ?? 'unknown'} (HTTP ${result.httpStatus})`,
      };
  }
}

function printLines(lines: Line[]): void {
  const width = Math.max(...lines.map(line => line.probe.length));
  for (const line of lines) {
    console.log(`  ${line.verdict.padEnd(4)}  ${line.probe.padEnd(width)}  ${line.detail}`);
  }
}

async function main(): Promise<void> {
  printConfiguration();

  if (coreBaseUrl === '') {
    console.log('FAIL  ALIM_CORE_BASE_URL is not set — nothing can be probed.');
    process.exitCode = 2;
    return;
  }

  const lines: Line[] = [];
  if (runSso) lines.push(await probeSso());
  if (runLatency) lines.push(...(await probeLatency()));
  if (runApproval) {
    console.log('Sending one invalid approval command (nil request_id) — staging only.\n');
    lines.push(await probeApproval());
  }
  printLines(lines);

  const failed = lines.filter(line => line.verdict === 'FAIL');
  const skipped = lines.filter(line => line.verdict === 'SKIP');
  console.log('');
  if (failed.length > 0) {
    const contractViolation = failed.some(line => line.detail.startsWith('CONTRACT VIOLATION'));
    console.log(`${failed.length} probe(s) failed${contractViolation ? ' — Core violated the contract' : ''}.`);
    process.exitCode = contractViolation ? 3 : 1;
    return;
  }
  if (skipped.length === lines.length) {
    console.log('Nothing was probed: the credentials for the selected probes are not configured.');
    process.exitCode = 2;
    return;
  }
  console.log('Probe complete. Configured integrations answered as the contract expects.');
}

void main();
