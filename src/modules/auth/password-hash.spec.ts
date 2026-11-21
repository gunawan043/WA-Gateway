import { createHash, randomBytes } from 'crypto';
import { dummyPasswordHash, hashPassword, verifyPassword } from './password-hash';

/**
 * scrypt is deliberately slow (~100 ms per call), so this file hashes only what it must: a handful of
 * real hashes shared across the assertions rather than one per test.
 */
describe('password hashing', () => {
  jest.setTimeout(30_000);

  let encoded: string;
  const password = 'correct horse battery staple';

  beforeAll(async () => {
    encoded = await hashPassword(password);
  });

  it('verifies the password it hashed and rejects a wrong one', async () => {
    expect(await verifyPassword(password, encoded)).toBe(true);
    expect(await verifyPassword('correct horse battery stapl', encoded)).toBe(false);
    expect(await verifyPassword('', encoded)).toBe(false);
  });

  it('encodes the parameters it used, so a stored row stays verifiable', () => {
    const parts = encoded.split('$');
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe('scrypt');
    // 2^15 / r=8 / p=1, then a 16-byte salt and a 64-byte key in base64.
    expect(parts[1]).toBe('32768');
    expect(parts[2]).toBe('8');
    expect(parts[3]).toBe('1');
    expect(Buffer.from(parts[4], 'base64')).toHaveLength(16);
    expect(Buffer.from(parts[5], 'base64')).toHaveLength(64);
  });

  it('salts every hash, so one password does not produce one stored value', async () => {
    const again = await hashPassword(password);
    expect(again).not.toBe(encoded);
    // Both still verify: the salt lives in the row, not in a global.
    expect(await verifyPassword(password, again)).toBe(true);
  });

  it('normalises to NFKC, so a decomposed and a composed accent are the same password', async () => {
    const composed = await hashPassword('caf\u00e9');
    expect(await verifyPassword('cafe\u0301', composed)).toBe(true);
  });

  it('does not leak the password into the encoded value', () => {
    const sha = createHash('sha256').update(password).digest('hex');
    expect(encoded).not.toContain(password);
    expect(encoded).not.toContain(sha);
  });

  it.each([
    ['empty', ''],
    ['not scrypt', 'bcrypt$32768$8$1$c2FsdA==$aGFzaA=='],
    ['too few parts', 'scrypt$32768$8$1$c2FsdA=='],
    ['non-numeric cost', 'scrypt$abc$8$1$c2FsdA==$aGFzaA=='],
    ['cost below 2', 'scrypt$1$8$1$c2FsdA==$aGFzaA=='],
    ['empty salt', 'scrypt$16384$8$1$$aGFzaA=='],
    ['empty hash', 'scrypt$16384$8$1$c2FsdA==$'],
  ])('answers false (never throws) for a %s row', async (_label, stored) => {
    await expect(verifyPassword(password, stored)).resolves.toBe(false);
  });

  it('refuses an absurd stored cost instead of allocating for it', async () => {
    // 2^30 would be ~1 TiB of memory at r=8. The bound is checked before scrypt is called.
    const hostile = `scrypt$${2 ** 30}$8$1$${randomBytes(16).toString('base64')}$${randomBytes(64).toString('base64')}`;
    const started = Date.now();
    await expect(verifyPassword(password, hostile)).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('refuses an out-of-range block size or parallelization', async () => {
    const salt = randomBytes(16).toString('base64');
    const hash = randomBytes(64).toString('base64');
    await expect(verifyPassword(password, `scrypt$16384$64$1$${salt}$${hash}`)).resolves.toBe(false);
    await expect(verifyPassword(password, `scrypt$16384$8$99$${salt}$${hash}`)).resolves.toBe(false);
  });

  it('builds the dummy hash once and no password matches it', async () => {
    const first = dummyPasswordHash();
    const second = dummyPasswordHash();
    expect(first).toBe(second);
    const stored = await first;
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword(password, stored)).toBe(false);
  });
});
