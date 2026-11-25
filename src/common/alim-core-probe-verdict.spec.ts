/**
 * The readiness probe's approval verdict is the one an operator reads instead of Core's body, so it has
 * to tell apart two refusals that look alike: Core refusing a command because the permit does not exist
 * (the route and the key are what the probe is proving), and Core refusing it because the actor the
 * probe names is nobody (which says nothing about whether a mapped actor would be accepted).
 *
 * Two cases: the verdicts, and the one fact the operator is pointed at when the actor check cannot run
 * here — the actor variables are read from the environment, not from the saved configuration file.
 */
import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.join(__dirname, '..', '..');
const probeSource = fs.readFileSync(path.join(repoRoot, 'scripts', 'alim-core-probe.ts'), 'utf8');

/**
 * Run the REAL probe against a Core that answers `answer`, then report what it printed and its exit
 * code. Loaded under `jest.isolateModules` because the probe runs itself on load.
 */
async function runProbe(answer: { status: number; body: unknown }): Promise<{
  output: string;
  exitCode: number | undefined;
  calls: number;
}> {
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  let calls = 0;
  const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
    calls += 1;
    return Promise.resolve(
      new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  const saved = { ...process.env };
  const savedArgv = process.argv;
  process.argv = ['node', 'scripts/alim-core-probe.ts', '--approval'];
  process.env.ALIM_CORE_BASE_URL = 'https://core.invalid';
  process.env.ALIM_CORE_APPROVAL_API_KEY = 'probe-key-not-a-real-credential';
  process.exitCode = undefined;
  try {
    jest.isolateModules(() => {
      jest.requireActual('../../scripts/alim-core-probe');
    });
    for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
    return {
      output: log.mock.calls.map(call => call.join(' ')).join('\n'),
      exitCode: process.exitCode as number | undefined,
      calls,
    };
  } finally {
    fetchSpy.mockRestore();
    log.mockRestore();
    process.env = saved;
    process.argv = savedArgv;
    process.exitCode = undefined;
  }
}

describe('ALIM Core readiness probe, approval verdict', () => {
  const envelope = (code: string): Record<string, unknown> => ({
    success: false,
    errors: { code, context: {} },
  });

  it('warns, rather than passes, when Core refuses the probe because its actor names nobody', async () => {
    const run = await runProbe({ status: 403, body: envelope('actor_identity_missing') });
    expect(run.calls).toBe(1);
    expect(run.output).toContain('WARN  Approval command');
    expect(run.output).toContain('actor_identity_missing');
    expect(run.output).toContain('does not show what a mapped actor gets');
    // A warning is not a failure: the route and the key were still proven.
    expect(run.exitCode ?? 0).toBe(0);
  });

  it('passes when the refusal is about the permit, not the actor', async () => {
    const run = await runProbe({ status: 404, body: envelope('request_not_found') });
    expect(run.output).toContain('PASS  Approval command');
    expect(run.output).not.toContain('does not show what a mapped actor gets');
    expect(run.exitCode ?? 0).toBe(0);
  });
});

describe('the actor check only runs from the environment', () => {
  it('reads the actor from the environment, not from the saved configuration', () => {
    // The probe and the lane load `.env` only. The lane's own text says the actor is filled in "saat
    // menjalankan lane", and the handoff lists it as a run-time value — so an operator who saves it to
    // the generated configuration instead sees the actor section skip while believing it is set.
    for (const key of ['ALIM_CONNECT_STAGING_ACTOR_NUMBER', 'ALIM_CONNECT_STAGING_ACTOR_CORE_USER']) {
      expect(probeSource).not.toContain(key);
    }
    const spec = fs.readFileSync(path.join(repoRoot, 'test', 'approval-http.e2e-spec.ts'), 'utf8');
    expect(spec).toContain('process.env.ALIM_CONNECT_STAGING_ACTOR_NUMBER');
    expect(spec).toContain('process.env.ALIM_CONNECT_STAGING_ACTOR_CORE_USER');
  });
});
