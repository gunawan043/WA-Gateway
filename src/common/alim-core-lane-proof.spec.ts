import * as fs from 'fs';
import * as path from 'path';

/**
 * The lane's real-Core proof is a regex over what the e2e specs print. If its shape drifts from the
 * printed line, the lane reports "MISSING proof" against a run that did reach Core — and an operator
 * learns to ignore the message. That happened once already: the regex required `"status"` while the
 * SSO spec prints `"httpStatus"`, so every SSO-only run would have failed the proof check.
 *
 * The line shapes are read out of the specs themselves, so the two cannot drift apart silently.
 */
const repoRoot = path.join(__dirname, '..', '..');
const read = (...parts: string[]): string => fs.readFileSync(path.join(repoRoot, ...parts), 'utf8');

// Keep in step with REAL_CORE_PROOF in scripts/alim-core-integration-lane.ts.
const REAL_CORE_PROOF =
  /\[real-core\] approval command \{.*"coreResponseCode":\d+|\[real-core\] sso exchange \{.*"httpStatus":\d+/;

describe('the lane counts only a real answer as proof', () => {
  it('recognises the SSO line the spec actually prints', () => {
    // The spec builds this object at test/sso-handoff-http.e2e-spec.ts; its key is what matters.
    const spec = read('test', 'sso-handoff-http.e2e-spec.ts');
    expect(spec).toContain("'[real-core] sso exchange '");
    expect(spec).toContain('httpStatus: res.status');

    const line = `[real-core] sso exchange ${JSON.stringify({ httpStatus: 422, ok: false, reason: 'code_not_found' })}`;
    expect(REAL_CORE_PROOF.test(line)).toBe(true);
  });

  it('recognises the approval line the spec actually prints, with a status Core returned', () => {
    const spec = read('test', 'approval-http.e2e-spec.ts');
    expect(spec).toContain("'[real-core] approval command '");
    expect(spec).toContain('coreResponseCode: command?.coreResponseCode');

    const line = `[real-core] approval command ${JSON.stringify({
      commandId: 'c1',
      status: 'APPLIED',
      attempts: 1,
      coreResponseCode: 201,
    })}`;
    expect(REAL_CORE_PROOF.test(line)).toBe(true);
  });

  it('refuses a line that records no HTTP answer', () => {
    // A timeout or an unreachable host leaves coreResponseCode null; that is not proof of Core.
    const noAnswer = `[real-core] approval command ${JSON.stringify({ status: 'UNKNOWN', coreResponseCode: null })}`;
    expect(REAL_CORE_PROOF.test(noAnswer)).toBe(false);
    expect(REAL_CORE_PROOF.test('[real-core] approval retry {"attempts":1}')).toBe(false);
  });

  it('refuses a passing suite as proof on its own', () => {
    // The whole point: the mock sections pass too, so PASS alone is not evidence.
    expect(REAL_CORE_PROOF.test('PASS test/approval-http.e2e-spec.ts')).toBe(false);
  });
});
