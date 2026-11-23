import { CORE_BODY_PREVIEW_BYTES, MAX_STORED_CORE_BODY_BYTES, boundCoreBody } from './core-response-body';

/**
 * The stored Core reply is bounded. A normal body must survive untouched — this is an audit
 * artifact, not a summary — while a body large enough to bloat the table must not.
 */
describe('boundCoreBody', () => {
  it('stores a normal reply exactly as received', () => {
    const raw = { success: true, data: { status: 'approved', duplicate: false } };

    expect(boundCoreBody(raw)).toBe(raw);
  });

  it('keeps a body that sits exactly on the limit', () => {
    const filler = 'x'.repeat(MAX_STORED_CORE_BODY_BYTES - '{"a":""}'.length);
    const raw = { a: filler };

    expect(Buffer.byteLength(JSON.stringify(raw))).toBe(MAX_STORED_CORE_BODY_BYTES);
    expect(boundCoreBody(raw)).toBe(raw);
  });

  it('bounds an oversized reply but keeps its size and a readable prefix', () => {
    const raw = { message: 'y'.repeat(MAX_STORED_CORE_BODY_BYTES * 4), nested: { status: 'approved' } };

    const stored = boundCoreBody(raw);

    expect(stored).toMatchObject({ truncated: true });
    expect(stored?.originalBytes).toBeGreaterThan(MAX_STORED_CORE_BODY_BYTES);
    expect(String(stored?.preview)).toHaveLength(CORE_BODY_PREVIEW_BYTES);
    expect(String(stored?.preview).startsWith('{"message":"yyy')).toBe(true);
    // The point of the bound: what lands in the row is smaller than what arrived.
    expect(Buffer.byteLength(JSON.stringify(stored))).toBeLessThan(MAX_STORED_CORE_BODY_BYTES);
  });

  it('treats a missing reply as nothing to store', () => {
    expect(boundCoreBody(null)).toBeNull();
    expect(boundCoreBody(undefined)).toBeNull();
  });
});
