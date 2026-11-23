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
 *   npm run probe:alim-core -- --approval   # also send one invalid approval command (opt-in)
 *   npm run probe:alim-core -- --all        # both
 *
 * The approval probe is opt-in because it is a POST: it sends a command whose `request_id` is the
 * nil UUID and whose actor is not a person, so the only correct answers are a business 4xx. A 2xx
 * is reported as a contract violation and exits 3 — Core would have applied a decision for a permit
 * that does not exist. Run it against staging, never production.
 *
 * Exit codes: 0 every selected probe passed; 1 a probe failed; 2 configuration missing;
 * 3 Core violated the contract (accepted a code it never issued, or applied a probe command).
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

const args = new Set(process.argv.slice(2));
const runSso = args.has('--all') || args.has('--sso') || !args.has('--approval');
const runApproval = args.has('--all') || args.has('--approval');

const env = process.env;
const coreBaseUrl = (env.ALIM_CORE_BASE_URL ?? '').replace(/\/+$/, '');

/** The same keys `configuration.ts` exposes, so the clients read what production reads. */
const values: Record<string, unknown> = {
  'connect.sso.coreBaseUrl': coreBaseUrl,
  'connect.sso.apiKey': env.ALIM_CONNECT_SSO_KEY ?? '',
  'connect.sso.apiHeader': env.ALIM_CONNECT_SSO_API_HEADER ?? 'X-ALIM-CONNECT-SSO-KEY',
  'connect.sso.timeoutMs': Number(env.ALIM_CONNECT_SSO_TIMEOUT_MS ?? 5000),
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

/** The SSO exchange refuses codes it did not issue; that refusal is the proof the route works. */
function classifySso(result: Awaited<ReturnType<HttpAlimCoreSsoClient['exchange']>>): Line {
  if (result.ok) {
    return {
      probe: 'SSO exchange',
      verdict: 'FAIL',
      detail: 'Core redeemed a code this probe invented — one-time semantics are not enforced',
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
  const result = await client.exchange({ code: `probe-${randomUUID()}`, state: 'connect-readiness-probe' });
  return classifySso(result);
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
      return {
        probe: 'Approval command',
        verdict: 'PASS',
        detail: `route + key accepted; Core refused the probe command (HTTP ${result.httpStatus}${
          result.code ? `, ${result.code}` : ''
        })`,
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
