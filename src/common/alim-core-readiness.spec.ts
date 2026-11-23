import * as fs from 'fs';
import * as path from 'path';

/**
 * The readiness guard is only worth running if the names it asks for are names the application reads.
 * A typo, or a variable that belongs to Core (the `CONNECT_*` family), reports "MISSING" for a
 * deployment that is complete — or "ready" for one that is not — and both send an operator to the
 * wrong place. These cases derive the set from the source rather than repeating it, so the two cannot
 * drift.
 */
const repoRoot = path.join(__dirname, '..', '..');

// The lane is CLI-shaped: it runs itself on load. Only its CHECKS export is read here.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { CHECKS } = require('../../scripts/alim-core-integration-lane') as {
  CHECKS: Array<{ env: string; required: boolean; scope: 'both' | 'sso' | 'approval'; why: string }>;
};

const read = (...parts: string[]): string => fs.readFileSync(path.join(repoRoot, ...parts), 'utf8');

describe('ALIM Core readiness guard', () => {
  const configuration = read('src', 'config', 'configuration.ts');
  const envPrecedence = read('src', 'config', 'env-precedence.ts');

  it('names only variables that src/config/configuration.ts actually reads', () => {
    for (const check of CHECKS) {
      expect(configuration).toContain(`process.env.${check.env}`);
    }
  });

  it('names only variables that survive a blank compose forward', () => {
    // A blank `${KEY:-}` forward sits in process.env and, with dotenv override:false, shadows .env.
    // Every variable the lane treats as optional must be cleared when blank or "unset" lies.
    for (const check of CHECKS) {
      expect(envPrecedence).toContain(`'${check.env}'`);
    }
  });

  it('never asks for a Core-owned CONNECT_* variable', () => {
    // CONNECT_SSO_API_KEY, CONNECT_APPROVAL_API_KEY, CONNECT_SSO_FRAME_ORIGIN and friends are read by
    // ALIM Core's config/services.php. A Connect deployment that sets them changes nothing.
    for (const check of CHECKS) {
      expect(check.env.startsWith('CONNECT_')).toBe(false);
    }
  });

  it('explains every check it reports', () => {
    for (const check of CHECKS) {
      expect(check.why.trim().length).toBeGreaterThan(10);
      expect(['both', 'sso', 'approval']).toContain(check.scope);
    }
  });

  it('requires the three settings that make a staging run prove something', () => {
    const required = (scope: 'sso' | 'approval'): string[] =>
      CHECKS.filter(check => check.required && (check.scope === scope || check.scope === 'both'))
        .map(check => check.env)
        .sort();

    // Without the origin, SSO is off; without the key, nothing is sent. Both would let a run pass
    // against the mock while proving nothing about Core.
    expect(required('sso')).toEqual(['ALIM_CONNECT_SSO_KEY', 'ALIM_CORE_BASE_URL', 'ALIM_CORE_WEB_ORIGIN']);
    expect(required('approval')).toEqual(['ALIM_CORE_APPROVAL_API_KEY', 'ALIM_CORE_BASE_URL']);
  });
});
