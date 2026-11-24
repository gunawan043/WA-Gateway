/**
 * Integration lane for the two ALIM Core integrations: guard first, then the e2e suites.
 *
 * `ALIM_CORE_BASE_URL` plus a key is what switches the real-Core sections of the e2e suites on.
 * Without the key the same suites run entirely against their loopback mock, so a mistyped staging
 * command would report "green" while proving nothing about Core: the real sections skip and the mock
 * sections pass. This lane refuses that — and refuses it BEFORE anything runs.
 *
 *   npm run test:core-integration:lane                  # guard only, no Core needed
 *   npm run test:core-integration                       # + SSO refusal path against Core
 *   npm run test:core-integration -- --approval         # + one real approval command
 *   npm run test:core-integration -- --sso-code=<code>  # + one real SSO exchange (spends the code)
 *
 * The two SSO success settings are read by the spec, not by the application, so they are reported as
 * an optional line under SSO: without them the success proof skips while everything else passes.
 *
 * Exit codes: 0 ready / lane passed; 1 a test failed; 2 configuration incomplete;
 * 3 a spec named here does not exist (a silent skip waiting to happen).
 *
 * Presence is reported as set / MISSING. No value is ever printed.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Specs that carry a real-Core section, so the lane is meaningless without them. */
const LANE_SPECS = ['test/sso-handoff-http.e2e-spec.ts', 'test/approval-http.e2e-spec.ts'];

/**
 * Checks in the order an operator meets them. `required` is what makes the real Core sections run
 * rather than skip; the rest are conditions under which the feature is silently off or answering 503,
 * which is worth knowing before a run is read as a pass.
 *
 * Exported so a test can assert every name here is one the application actually reads: a lane that
 * asks for a variable nothing consumes reports "ready" for a deployment that is not.
 */
export interface Check {
  env: string;
  required: boolean;
  /** Which integration the value belongs to; the lane reports each one only under its own heading. */
  scope: 'both' | 'sso' | 'approval';
  /** What breaks without it, in the operator's words. */
  why: string;
}

export const CHECKS: Check[] = [
  {
    env: 'ALIM_CORE_BASE_URL',
    required: true,
    scope: 'both',
    why: 'both integrations answer core_not_configured',
  },
  {
    env: 'ALIM_CONNECT_SSO_KEY',
    required: true,
    scope: 'sso',
    why: 'SSO exchange is disabled; the handoff page refuses',
  },
  {
    env: 'ALIM_CORE_WEB_ORIGIN',
    required: true,
    scope: 'sso',
    why: 'no Origin is allowed to post the handoff, so SSO is disabled',
  },
  {
    env: 'ALIM_CORE_APPROVAL_API_KEY',
    required: true,
    scope: 'approval',
    why: 'approval commands are never sent to Core',
  },
  {
    env: 'ALIM_CONNECT_INGEST_KEY',
    required: false,
    scope: 'approval',
    why: 'POST /approval/requests answers 503, so no permit can arrive from Core',
  },
];
const args = process.argv.slice(2);
const guardOnly = args.includes('--lane-guard');
const wantApproval = args.includes('--approval') || args.includes('--all');
const ssoCode = args.find(arg => arg.startsWith('--sso-code='))?.slice('--sso-code='.length);

const repoRoot = path.resolve(__dirname, '..');
const isSet = (key: string): boolean => (process.env[key] ?? '').trim() !== '';

/** Read by `test/sso-handoff-http.e2e-spec.ts` to turn the success proof from "ran" into "proved". */
const SSO_PROOF_KEYS = ['ALIM_CONNECT_SSO_TEST_CODE', 'ALIM_CONNECT_SSO_EXPECTED_CORE_USER'];

/** Read by the approval spec, not by the application: an actor Core already mapped, or a 403. */
const APPROVAL_PROOF_KEYS = ['ALIM_CONNECT_STAGING_ACTOR_NUMBER', 'ALIM_CONNECT_STAGING_ACTOR_CORE_USER'];

function report(label: string, checks: Check[]): boolean {
  const absent = checks.filter(check => !isSet(check.env));
  const hard = absent.filter(check => check.required);
  const detail = absent.length === 0 ? 'ready' : `MISSING ${absent.map(check => check.env).join(', ')}`;
  console.log(`  ${label.padEnd(26)} ${detail}`);
  for (const check of absent) {
    const marker = check.required ? 'blocks  ' : 'degrades';
    console.log(`  ${''.padEnd(26)}   ${marker}  ${check.env} — ${check.why}`);
  }
  if (isSet('ALIM_CONNECT_CORE_CLIENT') && process.env.ALIM_CONNECT_CORE_CLIENT?.trim() !== 'http') {
    console.log(`  ${''.padEnd(26)}   degrades  ALIM_CONNECT_CORE_CLIENT is not "http", so nothing reaches Core`);
  }
  return hard.length === 0;
}

/**
 * The real-Core sections assert on what Connect recorded, not on where it went: with a wrong key or
 * an unreachable host they still report APPLIED and the suite still passes. So when a real key is
 * supplied, the lane reads the output and fails unless at least one line proves a real answer —
 * `[real-core] approval command` carrying `coreResponseCode`, or `[real-core] sso exchange` carrying
 * `httpStatus` (the two names the specs actually print; a mismatch here would make every SSO-only
 * run report MISSING proof). A run that proved nothing must not exit 0.
 */
const REAL_CORE_PROOF = /\[real-core\] approval command \{.*"coreResponseCode":\d+|\[real-core\] sso exchange \{.*"httpStatus":\d+/;

function runJest(specs: string[], requireRealProof: boolean): void {
  console.log('');
  console.log(`Running: jest --config ./test/jest-e2e.json ${specs.join(' ')} --runInBand`);
  // Jest writes its report to the inherited terminal rather than to a pipe here, so the report is
  // captured through a file: a piped run came back empty and the proof check could never fire.
  const reportPath = path.join(os.tmpdir(), `alim-core-lane-${process.pid}.log`);
  let jestFailed = false;
  try {
    execFileSync('npx', ['jest', '--config', './test/jest-e2e.json', ...specs, '--runInBand'], {
      cwd: repoRoot,
      stdio: ['ignore', fs.openSync(reportPath, 'w'), fs.openSync(reportPath, 'a')],
    });
  } catch {
    jestFailed = true;
  }
  const output = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf8') : '';
  process.stdout.write(output);
  fs.rmSync(reportPath, { force: true });

  if (jestFailed) {
    process.exitCode = 1;
    return;
  }

  if (requireRealProof && !REAL_CORE_PROOF.test(output)) {
    console.log('');
    console.log('  real-Core proof      MISSING — every real section skipped or recorded no HTTP answer.');
    console.log('                       The mock sections passing is not evidence that Core was contacted.');
    process.exitCode = 1;
  }
}

function main(): void {
  console.log('ALIM Core integration lane\n');

  const missingSpecs = LANE_SPECS.filter(spec => !fs.existsSync(path.join(repoRoot, spec)));
  if (missingSpecs.length > 0) {
    console.log(`  lane spec                MISSING FILE ${missingSpecs.join(', ')}`);
    process.exitCode = 3;
    return;
  }

  const ssoChecks = CHECKS.filter(check => check.scope !== 'approval');
  const approvalChecks = CHECKS.filter(check => check.scope !== 'sso');
  const ssoReady = report('SSO (exchange)', ssoChecks);
  const approvalReady = report('approval (command)', approvalChecks);

  const missingProof = SSO_PROOF_KEYS.filter(key => !isSet(key));
  if (missingProof.length === 0) {
    console.log(`  ${'SSO success proof'.padEnd(26)} ready`);
  } else {
    console.log(`  ${'SSO success proof'.padEnd(26)} OPTIONAL ${missingProof.join(', ')}`);
    console.log(
      `  ${''.padEnd(26)}   skips     the success path needs a code Core issued; without it only refusals are proven`,
    );
  }

  // The approval section has proof keys of its own: without a staging actor Core answers
  // 403 actor_identity_unmapped, and the section skips. Saying so here keeps a lane that only ran
  // the mock approval sections from reading as a real result.
  const missingActor = APPROVAL_PROOF_KEYS.filter(key => !isSet(key));
  if (missingActor.length === 0) {
    console.log(`  ${'approval actor proof'.padEnd(26)} ready`);
  } else {
    console.log(`  ${'approval actor proof'.padEnd(26)} MISSING ${missingActor.join(', ')}`);
    console.log(
      `  ${''.padEnd(26)}   skips     Core answers 403 actor_identity_unmapped for an actor it never mapped`,
    );
  }

  if (guardOnly) {
    console.log('');
    console.log(ssoReady && approvalReady && missingActor.length === 0 && missingProof.length === 0
      ? 'Both integrations have what the real sections need.'
      : 'Not ready.');
    process.exitCode = ssoReady && approvalReady && missingActor.length === 0 && missingProof.length === 0 ? 0 : 2;
    return;
  }

  if (!ssoReady) {
    console.log('');
    console.log('Nothing was run: the SSO configuration is incomplete, so the real sections would skip and');
    console.log('only the mock sections would pass. Provide the values listed above first.');
    process.exitCode = 2;
    return;
  }

  console.log('');
  if (ssoCode === undefined) {
    console.log('SSO: no --sso-code=<code> given, so only the refusal path is exercised (a success needs');
    console.log('a code Core issued; it is one-time and this lane will spend it).');
  }

  // Approval runs only when its own credential AND an actor Core knows are there; otherwise its real
  // section would skip and read as a pass.
  const approvalRunnable = approvalReady && missingActor.length === 0;
  const specs = wantApproval && approvalRunnable ? LANE_SPECS : [LANE_SPECS[0]];
  if (wantApproval && !approvalRunnable) {
    console.log('Approval: skipped — its configuration or its staging actor is incomplete.');
  }
  runJest(specs, approvalRunnable && wantApproval);
}

// Importable by the spec that cross-checks CHECKS without running the lane.
if (require.main === module) main();
