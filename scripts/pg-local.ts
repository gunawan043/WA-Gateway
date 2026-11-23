/**
 * A PostgreSQL server on this machine, for the PostgreSQL lane only.
 *
 * `DATABASE_*` in this checkout points at a managed host that does not resolve, so the pg-only
 * suites cannot run against it. Production and the staging database are off limits — a lane that
 * creates, migrates and drops databases must never be pointed at them — so this runs its own
 * throwaway cluster instead:
 *
 *   1. the Postgres 16 binaries into `.cache/postgres/` (git-ignored) from the zetabytes
 *      `postgres-embedded` distribution, unpacked without a build step;
 *   2. `initdb` into `.cache/postgres/data`, listening on 127.0.0.1 only, on 5432 or the next
 *      free port;
 *   3. the role, password and database the repository's own suites expect: `openwa` everywhere.
 *
 * It never starts on boot and nothing else depends on it. Nothing here reads `.env`, so the
 * managed credentials are never sent anywhere.
 *
 *   npm run pg:local:start [-- --reset]   # prepare + start (or start), print the export line
 *   npm run pg:local:stop                 # stop the server
 *   npm run pg:local:status               # running? on which port?
 *
 * Exit codes: 0 started / already running / stopped; 1 failed, naming the step.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

/** Newest 16.x theseus-rs ships, so the lane runs the same major version as the CI service. */
const PG_VERSION = '16.16.0';
const ROLE = 'openwa';
const PASSWORD = 'openwa';
const DATABASE = 'openwa';
/** The lanes' default port; a busy one is not an error, the next free port is used instead. */
const PREFERRED_PORT = 5432;

const repoRoot = path.resolve(__dirname, '..');
const cacheRoot = path.join(repoRoot, '.cache', 'postgres');
const binRoot = path.join(cacheRoot, 'bin');
const dataDir = path.join(cacheRoot, 'data');
const logFile = path.join(cacheRoot, 'server.log');
const portFile = path.join(cacheRoot, 'port');

const args = process.argv.slice(2);
const command = args.find(arg => ['--stop', '--status'].includes(arg)) ?? '--start';
const fresh = args.includes('--reset');

function fail(step: string, detail: string): never {
  process.exitCode = 1;
  console.error(`pg-local: ${step} failed\n${detail}`);
  process.exit(1);
}

const bin = (name: string): string => path.join(binRoot, 'bin', name);

/** Downloads the embedded distribution for this platform and unpacks it into `binRoot`. */
function installBinaries(): void {
  // The release tag was named after the version itself for this major.
  const version = PG_VERSION;
  const arch = os.arch() === 'arm64' ? 'aarch64' : 'x86_64';
  const triple = process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-musl';
  const name = `postgresql-${PG_VERSION}-${arch}-${triple}`;
  const url = `https://github.com/theseus-rs/postgresql-binaries/releases/download/${version}/${name}.tar.gz`;
  fs.mkdirSync(cacheRoot, { recursive: true });
  const tarball = path.join(cacheRoot, `${name}.tar.gz`);

  console.log(`pg-local: downloading PostgreSQL ${PG_VERSION} binaries…`);
  // The download is ~90 MB from a release CDN; a reset mid-transfer is normal enough to retry.
  const download = spawnSync('curl', ['-fsSL', '--retry', '3', '--retry-all-errors', '-o', tarball, url], {
    stdio: 'inherit',
  });
  if (download.status !== 0) fail('download', `could not fetch ${url}`);

  fs.mkdirSync(binRoot, { recursive: true });
  const untar = spawnSync('tar', ['-xzf', tarball, '-C', binRoot, '--strip-components=1'], { stdio: 'inherit' });
  if (untar.status !== 0) fail('extract', 'tar could not unpack the PostgreSQL archive');
  fs.rmSync(tarball, { force: true });

  // macOS quarantines anything downloaded; the binaries are unsigned, so clear the flag on them.
  // Only `bin/` and `lib/` are run or dlopen-ed, and xattr stops at the notice files otherwise.
  if (process.platform === 'darwin') {
    for (const dir of [path.join(binRoot, 'bin'), path.join(binRoot, 'lib')]) {
      spawnSync('xattr', ['-dr', 'com.apple.quarantine', dir]);
    }
  }
}

function ensureBinaries(): void {
  if (fs.existsSync(bin('postgres')) && fs.existsSync(bin('initdb')) && fs.existsSync(bin('pg_ctl'))) return;
  installBinaries();
}

/**
 * `initdb` and `pg_ctl` shell out to `postgres`, `createdb` and `psql` by name, so the brand-new
 * binaries directory has to be on PATH before any of them runs.
 */
function toolEnv(): NodeJS.ProcessEnv {
  const dir = path.join(binRoot, 'bin');
  return { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}`, PGPASSWORD: PASSWORD };
}

function run(name: string, argv: string[]): string {
  const result = spawnSync(bin(name), argv, { encoding: 'utf8', env: toolEnv() });
  if (result.status !== 0) fail(name, `${result.stdout ?? ''}${result.stderr ?? ''}`);
  return (result.stdout ?? '').trim();
}

function isRunning(): boolean {
  if (!fs.existsSync(path.join(dataDir, 'PG_VERSION')) || !fs.existsSync(bin('pg_ctl'))) return false;
  return spawnSync(bin('pg_ctl'), ['-D', dataDir, 'status'], { encoding: 'utf8', env: toolEnv() }).status === 0;
}

function portFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function freePort(): Promise<number> {
  for (let port = PREFERRED_PORT; port < PREFERRED_PORT + 40; port += 1) {
    if (await portFree(port)) return port;
  }
  return fail('port', `no free port between ${PREFERRED_PORT} and ${PREFERRED_PORT + 40}`);
}

/**
 * initdb, then one entry point that starts listening with the demo superuser already in place.
 * The superuser IS the role the suites use: nothing else holds a password that could reach it.
 */
function initialise(port: number): void {
  console.log(`pg-local: initialising a cluster in ${dataDir}`);
  fs.mkdirSync(dataDir, { recursive: true });
  const pwFile = path.join(cacheRoot, '.pw');
  fs.writeFileSync(pwFile, `${PASSWORD}\n`, { mode: 0o600 });

  // Loopback only, password required: no socket, no wildcard address. The server default locale is the
  // operating system's, as the CI service's is: a C default would make every database here classify
  // characters with the C library, which changes pg_trgm's term rule (see the search provider's
  // POSTGRES_ASCII_TRIGRAM_SOURCE) for every scratch database a suite creates.
  run('initdb', ['-D', dataDir, '-U', ROLE, `--pwfile=${pwFile}`, '-A', 'scram-sha-256', '-E', 'UTF8']);
  fs.rmSync(pwFile, { force: true });
  fs.appendFileSync(path.join(dataDir, 'postgresql.conf'), `\nport = ${port}\nlisten_addresses = '127.0.0.1'\n`);
  fs.writeFileSync(portFile, String(port));

  run('pg_ctl', ['-D', dataDir, '-l', logFile, '-w', 'start']);
  // createdb can fail on a half-built cluster; stop the server so the next run starts from a
  // clean slate rather than a running server whose database is missing.
  const created = spawnSync(bin('createdb'), ['-h', '127.0.0.1', '-p', String(port), '-U', ROLE, DATABASE], {
    encoding: 'utf8',
    env: toolEnv(),
  });
  if (created.status !== 0) {
    spawnSync(bin('pg_ctl'), ['-D', dataDir, '-m', 'fast', '-w', 'stop'], { encoding: 'utf8', env: toolEnv() });
    fail('createdb', `${created.stdout ?? ''}${created.stderr ?? ''}`);
  }
  console.log(`pg-local: cluster ready for 127.0.0.1:${port}`);
}

function printEnv(port: number): void {
  // pg_dump and psql are on PATH only after this, and two suites in the lane skip without them rather than
  // fail, so the export line has to carry the binaries directory too.
  const dir = path.join(binRoot, 'bin');
  console.log('');
  console.log('Export these before running the PostgreSQL lane:');
  console.log(`  export PATH="${dir}:$PATH"`);
  console.log(`  export DATABASE_TYPE=postgres DATABASE_HOST=127.0.0.1 DATABASE_PORT=${port} \\`);
  console.log(`         DATABASE_USERNAME=${ROLE} DATABASE_PASSWORD=${PASSWORD} DATABASE_NAME=${DATABASE}`);
  console.log('  npm run test:pg-lane');
}

function start(): void {
  ensureBinaries();
  if (isRunning()) {
    const port = Number(fs.readFileSync(portFile, 'utf8').trim());
    console.log(`pg-local: already running on 127.0.0.1:${port}`);
    printEnv(port);
    return;
  }
  if (fresh && fs.existsSync(dataDir)) {
    console.log('pg-local: --reset removes the previous cluster');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  // A directory that initdb never finished is not a cluster; booting it fails on pg_filenode.map.
  const built = fs.existsSync(path.join(dataDir, 'PG_VERSION'));
  if (!built) {
    if (fs.existsSync(dataDir)) {
      console.log('pg-local: the previous cluster is incomplete, building it again');
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
    void freePort().then(port => {
      initialise(port);
      printEnv(port);
    });
    return;
  }
  const port = Number(fs.readFileSync(portFile, 'utf8').trim());
  console.log(`pg-local: starting on 127.0.0.1:${port}`);
  run('pg_ctl', ['-D', dataDir, '-l', logFile, '-w', 'start']);
  printEnv(port);
}

function stop(): void {
  if (!isRunning()) {
    console.log('pg-local: not running');
    return;
  }
  run('pg_ctl', ['-D', dataDir, '-m', 'fast', '-w', 'stop']);
  console.log('pg-local: stopped');
}

function status(): void {
  if (!isRunning()) {
    console.log('pg-local: not running');
    process.exitCode = 1;
    return;
  }
  console.log(`pg-local: running on 127.0.0.1:${fs.readFileSync(portFile, 'utf8').trim()} (data: ${dataDir})`);
}

if (command === '--stop') stop();
else if (command === '--status') status();
else start();
