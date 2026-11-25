/**
 * The latency probe exists because one exchange answering "it worked" is not the question. The same
 * host measured 1.8 s to 7.6 s for the same call against a 5000 ms budget, so a handoff could fail
 * at random while every configuration check passed. These cases pin the verdict an operator acts on:
 * under budget passes, over budget fails with a number to set, and a Core that redeems an invented
 * code is still reported as a contract violation.
 */
import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.join(__dirname, '..', '..');
const probeSource = fs.readFileSync(path.join(repoRoot, 'scripts', 'alim-core-probe.ts'), 'utf8');

/** Answers each exchange after `delays[i]` ms, refusing the invented code. */
async function runLatencyProbe(
  delays: number[],
  budgetMs: number | undefined,
): Promise<{ output: string; exitCode: number | undefined; calls: number }> {
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  let calls = 0;
  const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
    const delay = delays[Math.min(calls, delays.length - 1)];
    calls += 1;
    return new Promise(resolve => {
      setTimeout(
        () =>
          resolve(
            new Response(JSON.stringify({ success: false, errors: { code: 'code_not_found' } }), {
              status: 404,
              headers: { 'content-type': 'application/json' },
            }),
          ),
        delay,
      );
    });
  });

  const saved = { ...process.env };
  const savedArgv = process.argv;
  process.argv = ['node', 'scripts/alim-core-probe.ts', '--latency'];
  process.env.ALIM_CORE_BASE_URL = 'https://core.invalid';
  process.env.ALIM_CONNECT_SSO_KEY = 'probe-key-not-a-real-credential';
  if (budgetMs === undefined) delete process.env.ALIM_CONNECT_SSO_TIMEOUT_MS;
  else process.env.ALIM_CONNECT_SSO_TIMEOUT_MS = String(budgetMs);
  process.exitCode = undefined;
  try {
    jest.isolateModules(() => {
      jest.requireActual('../../scripts/alim-core-probe');
    });
    // The probe awaits each exchange, so waiting for the last delay is enough for all of them.
    const total = delays.reduce((sum, ms) => sum + ms, 0);
    const deadline = Date.now() + total + 2000;
    while (calls < delays.length && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await new Promise(resolve => setTimeout(resolve, 50));
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

describe('ALIM Core latency probe', () => {
  it('measures five exchanges and passes when every one fits the budget', async () => {
    const run = await runLatencyProbe([5, 5, 5, 5, 5], 15000);
    // `--latency` without `--approval` still runs the SSO exchange probe first (its own flag rule),
    // so the count is the one exchange plus the five latency samples.
    expect(run.calls).toBe(6);
    expect(run.output).toContain('PASS  SSO latency');
    expect(run.output).toContain('over 5 calls (budget 15000 ms)');
    expect(run.exitCode ?? 0).toBe(0);
  });

  it('fails and names a larger budget when a call takes longer than the budget', async () => {
    const run = await runLatencyProbe([5, 5, 900, 5, 5], 500);
    expect(run.output).toContain('FAIL  SSO latency');
    expect(run.output).toMatch(/Raise ALIM_CONNECT_SSO_TIMEOUT_MS to at least \d+/);
    expect(run.exitCode).toBe(1);
  });

  it('warns when Core does not refuse the invented code', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    // A 2xx would be a contract violation; the latency probe reports it rather than hiding it behind
    // a green latency number.
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ success: true, data: { core_user_id: 'u1' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const saved = { ...process.env };
    const savedArgv = process.argv;
    process.argv = ['node', 'scripts/alim-core-probe.ts', '--latency'];
    process.env.ALIM_CORE_BASE_URL = 'https://core.invalid';
    process.env.ALIM_CONNECT_SSO_KEY = 'probe-key-not-a-real-credential';
    process.exitCode = undefined;
    try {
      jest.isolateModules(() => {
        jest.requireActual('../../scripts/alim-core-probe');
      });
      for (let i = 0; i < 40; i++) await new Promise(resolve => setTimeout(resolve, 10));
      const output = log.mock.calls.map(call => call.join(' ')).join('\n');
      expect(output).toContain('WARN  SSO latency');
      expect(output).toContain('were NOT refused');
    } finally {
      fetchSpy.mockRestore();
      log.mockRestore();
      process.env = saved;
      process.argv = savedArgv;
      process.exitCode = undefined;
    }
  });

  it('reads the budget from ALIM_CONNECT_SSO_TIMEOUT_MS, the same key the client reads', () => {
    // The probe stands in for the client when it measures, so it must resolve the budget the same
    // way: the environment first, then the default configuration.ts applies.
    expect(probeSource).toContain('env.ALIM_CONNECT_SSO_TIMEOUT_MS ?? DEFAULT_SSO_TIMEOUT_MS');
    expect(probeSource).toContain("values['connect.sso.timeoutMs']");
    const configuration = fs.readFileSync(path.join(repoRoot, 'src', 'config', 'configuration.ts'), 'utf8');
    const configured = /ALIM_CONNECT_SSO_TIMEOUT_MS,\s*(\d[\d_]*)\)/.exec(configuration);
    expect(configured).not.toBeNull();
    const defaultValue = Number(configured![1].replace(/_/g, ''));
    expect(probeSource).toContain(`const DEFAULT_SSO_TIMEOUT_MS = ${defaultValue};`);
  });
});
