import { randomBytes, scrypt, timingSafeEqual } from 'crypto';

/**
 * Password hashing for dashboard accounts.
 *
 * scrypt from `node:crypto`, so a shared-hosting deployment never needs a native build (bcrypt and
 * argon2 both do). A user-chosen password must not go through `hashApiKey`: that is a single SHA-256,
 * fast by design because API keys are 256 random bits, and trivially brute-forced over a wordlist.
 *
 * The encoded form carries its own parameters, `scrypt$N$r$p$saltB64$hashB64`, so raising the cost
 * later leaves old rows verifiable instead of locking everyone out.
 */

// 2^15 blocks of 8 KiB ≈ 33.5 MB per hash. Node's default maxmem is 32 MiB, which this exceeds, so
// every call passes its own ceiling. A login costs ~100 ms on a small VPS, which is the point.
const COST = 2 ** 15;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const KEY_LENGTH = 64;
const MAXMEM = 64 * 1024 * 1024;

// Bounds on a stored hash, so a tampered row cannot ask for a gigabyte of memory per attempt.
const MAX_COST = 2 ** 20;
const MAX_BLOCK_SIZE = 32;
const MAX_PARALLELIZATION = 16;

const scryptAsync = (password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number }) =>
  new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, keylen, { ...options, maxmem: MAXMEM }, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });

/** NFKC so a password typed on another keyboard layout or macOS still matches its stored hash. */
function normalize(password: string): string {
  return password.normalize('NFKC');
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(normalize(password), salt, KEY_LENGTH, {
    N: COST,
    r: BLOCK_SIZE,
    p: PARALLELIZATION,
  });
  return ['scrypt', COST, BLOCK_SIZE, PARALLELIZATION, salt.toString('base64'), hash.toString('base64')].join('$');
}

/** False for any malformed or unparseable row, never a throw: a bad row must not 500 the login route. */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const cost = Number(parts[1]);
  const blockSize = Number(parts[2]);
  const parallelization = Number(parts[3]);
  if (
    !Number.isInteger(cost) ||
    cost < 2 ||
    cost > MAX_COST ||
    !Number.isInteger(blockSize) ||
    blockSize < 1 ||
    blockSize > MAX_BLOCK_SIZE ||
    !Number.isInteger(parallelization) ||
    parallelization < 1 ||
    parallelization > MAX_PARALLELIZATION
  ) {
    return false;
  }

  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = await scryptAsync(normalize(password), salt, expected.length, {
      N: cost,
      r: blockSize,
      p: parallelization,
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

let dummyHash: Promise<string> | null = null;

/**
 * A hash of a random string, verified against when the email matches no account.
 *
 * Without it an unknown email answers in microseconds while a known one spends ~100 ms in scrypt,
 * which tells an attacker which addresses exist. Created once per process.
 */
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(32).toString('hex'));
  return dummyHash;
}
