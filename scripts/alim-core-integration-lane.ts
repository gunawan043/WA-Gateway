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
 * Exit codes: 0 ready / lane passed; 1 a test failed; 2 configuration incomplete;
 * 3 a spec named here does not exist (a silent skip waiting to happen).
 *
 * Presence is reported as set / MISSING. No value is ever printed.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** Specs that carry a real-Core section, so the lane is meaningless without them. */
const LANE_SPECS = ['test/sso-handoff-http.e2e-spec.ts', 'test/approval-http.e2e-spec.ts'];

const SSO_KEYS = ['ALIM_CORE_BASE_URL', 'ALIM_CONNECT_SSO_KEY'];
const APPROVAL_KEYS = ['ALIM_CORE_BASE_URL', 'ALIM_CORE_APPROVAL_API_KEY'];

const args = process.argv.slice(2);
const guardOnly = args.includes('--lane-guard');
const wantApproval = args.includes('--approval') || args.includes('--all');
const ssoCode = args.find(arg => arg.startsWith('--sso-code='))?.slice('--sso-code='.length);

const repoRoot = path.resolve(__dirname, '..');
const isSet = (key: string): boolean => (process.env[key] ?? '').trim() !== '';

function report(label: string, keys: string[]): boolean {
  const absent = keys.filter(key => !isSet(key));
  console.log(`  ${label.padEnd(26)} ${absent.length === 0 ? 'ready' : `MISSING ${absent.join(', ')}`}`);
  return absent.length === 0;
}

function runJest(specs: string[]): void {
  console.log('');
  console.log(`Running: jest --config ./test/jest-e2e.json ${specs.join(' ')} --maxWorkers=1`);
  try {
    execFileSync('npx', ['jest', '--config', './test/jest-e2e.json', ...specs, '--maxWorkers=1'], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
  } catch {
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

  const ssoReady = report('SSO (exchange)', SSO_KEYS);
  const approvalReady = report('approval (command)', APPROVAL_KEYS);

  if (guardOnly) {
    console.log('');
    console.log(ssoReady && approvalReady ? 'Both integrations have what the real sections need.' : 'Not ready.');
    process.exitCode = ssoReady && approvalReady ? 0 : 2;
    return;
  }

  if (!ssoReady) {
    console.log('');
    console.log('Nothing was run: the SSO credentials are not set, so the real sections would skip and only');
    console.log('the mock sections would pass. Set ALIM_CORE_BASE_URL and ALIM_CONNECT_SSO_KEY first.');
    process.exitCode = 2;
    return;
  }

  console.log('');
  if (ssoCode === undefined) {
    console.log('SSO: no --sso-code=<code> given, so only the refusal path is exercised (a success needs');
    console.log('a code Core issued; it is one-time and this lane will spend it).');
  }

  // Approval runs only when its own credential is there; otherwise its real section would skip and
  // read as a pass.
  const specs = wantApproval && approvalReady ? LANE_SPECS : [LANE_SPECS[0]];
  if (wantApproval && !approvalReady) {
    console.log('Approval: skipped — ALIM_CORE_APPROVAL_API_KEY is not set.');
  }
  runJest(specs);
}

main();
