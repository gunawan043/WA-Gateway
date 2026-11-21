import { createHash, createHmac } from 'crypto';
import { generateSessionToken, hashSessionToken, isSessionToken, SESSION_TOKEN_PREFIX } from './session-token';

describe('session tokens', () => {
  const originalPepper = process.env.API_KEY_PEPPER;

  afterEach(() => {
    if (originalPepper === undefined) delete process.env.API_KEY_PEPPER;
    else process.env.API_KEY_PEPPER = originalPepper;
  });

  describe('isSessionToken', () => {
    it('recognises the prefix and nothing else', () => {
      expect(isSessionToken('owa_s1_' + 'a'.repeat(64))).toBe(true);
      expect(isSessionToken('  owa_s1_abc')).toBe(true); // the guard trims before hashing
      expect(isSessionToken('owa_k1_' + 'a'.repeat(64))).toBe(false);
      expect(isSessionToken('dev-admin-key')).toBe(false);
      expect(isSessionToken('')).toBe(false);
      expect(isSessionToken(null)).toBe(false);
      expect(isSessionToken(undefined)).toBe(false);
    });

    it('is not fooled by a prefix appearing later in the string', () => {
      expect(isSessionToken('owa_k1_owa_s1_abc')).toBe(false);
    });
  });

  describe('generateSessionToken', () => {
    it('produces the documented shape', () => {
      const token = generateSessionToken();
      expect(token.startsWith(SESSION_TOKEN_PREFIX)).toBe(true);
      expect(token).toHaveLength(SESSION_TOKEN_PREFIX.length + 64);
      expect(token.slice(SESSION_TOKEN_PREFIX.length)).toMatch(/^[0-9a-f]{64}$/);
    });

    it('never repeats', () => {
      const tokens = new Set(Array.from({ length: 200 }, () => generateSessionToken()));
      expect(tokens.size).toBe(200);
    });

    it('is always recognised by isSessionToken', () => {
      for (let i = 0; i < 20; i++) expect(isSessionToken(generateSessionToken())).toBe(true);
    });
  });

  describe('hashSessionToken', () => {
    it('is plain SHA-256 without a pepper, like an API key hash', () => {
      delete process.env.API_KEY_PEPPER;
      const token = 'owa_s1_' + 'b'.repeat(64);
      expect(hashSessionToken(token)).toBe(createHash('sha256').update(token).digest('hex'));
    });

    it('is HMAC-SHA256 with API_KEY_PEPPER, and different from the unpeppered value', () => {
      const token = 'owa_s1_' + 'c'.repeat(64);
      delete process.env.API_KEY_PEPPER;
      const plain = hashSessionToken(token);
      process.env.API_KEY_PEPPER = 'server-pepper';
      const peppered = hashSessionToken(token);
      expect(peppered).toBe(createHmac('sha256', 'server-pepper').update(token).digest('hex'));
      expect(peppered).not.toBe(plain);
    });

    it('trims, so a token pasted with whitespace still resolves', () => {
      delete process.env.API_KEY_PEPPER;
      const token = 'owa_s1_' + 'd'.repeat(64);
      expect(hashSessionToken(`  ${token}\n`)).toBe(hashSessionToken(token));
    });

    it('is 64 hex characters, which is the column width', () => {
      expect(hashSessionToken(generateSessionToken())).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
