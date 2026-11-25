import { readFileSync } from 'fs';
import { join } from 'path';
// js-yaml has no bundled types here; require + cast (matches compose-network.spec.ts).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const yaml = require('js-yaml') as { load: (src: string) => unknown };

interface ComposeFile {
  services: Record<string, { image?: string; build?: unknown; ports?: string[]; environment?: string[] }>;
}

// jest's rootDir is `src`, so __dirname is src/config and the repository root is two levels up.
const root = join(__dirname, '../..');
const read = (relative: string): string => readFileSync(join(root, relative), 'utf8');

/**
 * The production overlay is the difference between "deploy a release" and "rebuild whatever is in
 * the working tree on the server". These assertions pin the three properties that make it one:
 * a digest-pinned image, a loopback-only published port, and no secret in the file itself.
 *
 * They read the file as text as well as YAML because the digest guard lives in the `${VAR:?}`
 * interpolation — YAML parses that to a string but cannot say whether the variable was REQUIRED.
 */
describe('production compose overlay', () => {
  const text = read('docker-compose.production.yml');
  const compose = yaml.load(text) as ComposeFile;
  const api = compose.services['openwa-api'];

  it('pins the image by digest and refuses to start without one', () => {
    expect(api.image).toBeDefined();
    // `:?` makes Compose abort with the message instead of substituting an empty image name.
    expect(api.image).toContain('${ALIM_CONNECT_IMAGE:?');
    expect(text).toContain('@sha256:');
  });

  it('makes a source build impossible by default', () => {
    // Compose merges mappings, so the base file's `context: .` would survive unless overridden. The
    // overlay points it at a path that does not exist, so a `--build` fails instead of silently
    // producing an image that is not the release.
    expect(api.build).toEqual({ context: './__production_build_is_forbidden_use_the_pinned_image__' });
  });

  it('publishes the API on loopback only', () => {
    expect(api.ports).toEqual(['127.0.0.1:${API_PORT:-2785}:2785']);
  });

  it('forces the production posture the guards rely on', () => {
    const env = api.environment ?? [];
    expect(env).toContain('NODE_ENV=production');
    // A mock Core can approve a permit Core never approved.
    expect(env).toContain('ALIM_CONNECT_CORE_CLIENT=http');
    expect(env).toContain('ENABLE_SWAGGER=${ENABLE_SWAGGER:-false}');
  });

  it('defaults CORS to the public origin and never to a wildcard', () => {
    const cors = (api.environment ?? []).find(entry => entry.startsWith('CORS_ORIGINS='));
    expect(cors).toBeDefined();
    expect(cors).toContain('https://alim-wa.abuhurairah.id');
    expect(cors).not.toMatch(/\*|http:\/\//);
  });

  it('carries no literal secret', () => {
    // Every credential must arrive from the operator's environment. A value pasted here would be a
    // secret in the repository, which is the one thing the deployment must never have.
    for (const key of [
      'ALIM_CORE_APPROVAL_API_KEY',
      'ALIM_CONNECT_SSO_KEY',
      'ALIM_CONNECT_INGEST_KEY',
      'API_MASTER_KEY',
      'DATABASE_PASSWORD',
    ]) {
      expect(text).not.toContain(`${key}=`);
    }
  });
});

describe('deployment scripts', () => {
  const preflight = read('scripts/deploy/preflight-production.sh');
  const verify = read('scripts/deploy/verify-production.sh');
  const baseline = read('scripts/emit-migration-baseline.ts');

  it('preflight blocks a wildcard CORS origin and a plaintext Core URL', () => {
    expect(preflight).toContain('\'*\') fail "CORS_ORIGINS"');
    expect(preflight).toContain('plaintext http');
  });

  it('preflight refuses a release image that is not digest-pinned', () => {
    expect(preflight).toContain('*@sha256:*)');
    expect(preflight).toContain('not pinned by digest');
  });

  it('preflight catches an admin password UserSeedService would refuse', () => {
    // UserSeedService silently skips the seed below 12 characters, so a short password reaches the
    // operator as "no account" at the login screen rather than as a boot failure.
    expect(preflight).toContain('ADMIN_PASSWORD shorter than 12 characters');
    expect(preflight).toContain('must be set together');
  });

  it('preflight never prints a secret value', () => {
    // Presence-only checks: the strongest way to guarantee it is that no echo line interpolates a
    // credential. Every secret check goes through `present`/`weak_secret`, which print a length or
    // a verdict.
    expect(preflight).not.toMatch(
      /echo[^\n]*\$\{?(API_MASTER_KEY|DATABASE_PASSWORD|ALIM_CORE_APPROVAL_API_KEY|ALIM_CONNECT_SSO_KEY|ALIM_CONNECT_INGEST_KEY)/,
    );
  });

  it('verification separates "route missing" from "route refused"', () => {
    // The whole point: a 404 is a wrong build, a 401 is a correct build refusing an anonymous call.
    expect(verify).toContain('404 | 405 | 000) return 1;');
    expect(verify).toContain('route NOT in this build');
  });

  it('verification refuses to call a 200 to an empty handoff a success', () => {
    expect(verify).toContain('a handoff was accepted without a code');
  });

  it('the baseline generator writes SQL and never connects to a database', () => {
    expect(baseline).not.toMatch(/\bnew Client\b|pg\.Client|createConnection|dataSource\.initialize/);
    expect(baseline).toContain('INSERT INTO public.migrations');
    expect(baseline).toContain('WHERE NOT EXISTS');
  });

  it('the ledger rows it emits match the migration classes TypeORM will look for', () => {
    // Run the generator and check its OUTPUT, not its source: the point is that the SQL it writes
    // agrees with the classes, and prose in the file cannot be mistaken for a statement.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execFileSync } = require('child_process') as typeof import('child_process');
    const sql = execFileSync('npx', ['ts-node', 'scripts/emit-migration-baseline.ts', '--only=headless'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // A re-run must be harmless: the only unique key is `id`, so an ON CONFLICT clause would never
    // fire on a duplicate timestamp and the ledger would gain a second row.
    expect(sql).not.toContain('ON CONFLICT');
    expect(sql.match(/INSERT INTO public\.migrations/g)).toHaveLength(3);
    // Each timestamp must END its class name, which is what TypeORM parses back out.
    expect(sql).toContain("SELECT 1792400000000, 'CreateApprovalWorkflow1792400000000'");
    expect(sql).toContain("SELECT 1792500000000, 'AddApprovalCommandRetry1792500000000'");
    expect(sql).toContain("SELECT 1792600000000, 'AddApprovalLookupIndexes1792600000000'");
    // One transaction: a half-written ledger is worse than an empty one.
    expect(sql.indexOf('BEGIN;')).toBeLessThan(sql.indexOf('INSERT INTO'));
    expect(sql.lastIndexOf('COMMIT;')).toBeGreaterThan(sql.lastIndexOf('INSERT INTO'));
  });
});
