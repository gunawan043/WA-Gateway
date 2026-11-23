import { CURATED_CAPABILITY_EXCEPTIONS, engineCapabilityMatrix } from './engine-capability-matrix';

/**
 * The matrix is derived from the interface source at call time. These tests pin the two halves of
 * that contract: every interface method appears exactly once (with the supported default), and a
 * curated row survives derivation unchanged — including the copy that stops a consumer writing
 * through into the curated table.
 */
describe('engineCapabilityMatrix', () => {
  it('derives one row per interface method, with the supported default', () => {
    const matrix = engineCapabilityMatrix();

    // `addLabelToChat` is an ordinary interface method with no curated exception.
    expect(matrix.addLabelToChat).toEqual({ wwjs: { status: 'supported' }, baileys: { status: 'supported' } });
    expect(Object.keys(matrix).length).toBeGreaterThan(10);
  });

  it('keys the matrix by interface method name, without duplicates or blanks', () => {
    const keys = Object.keys(engineCapabilityMatrix());

    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every(key => /^[a-zA-Z][a-zA-Z0-9]*$/.test(key))).toBe(true);
  });

  it('carries every curated exception with its status, root cause and evidence', () => {
    const matrix = engineCapabilityMatrix();
    const curated = CURATED_CAPABILITY_EXCEPTIONS.upsertLabel;

    expect(matrix.upsertLabel).toEqual(curated);
    expect(matrix.upsertLabel.wwjs).toEqual({ status: 'not-available', rootCause: 'library-limitation' });
    expect(matrix.upsertLabel.evidence).toBeTruthy();
  });

  it('memoises the derived matrix, so callers share one object', () => {
    expect(engineCapabilityMatrix()).toBe(engineCapabilityMatrix());
  });

  it('hands out a copy: mutating a row cannot write through into the curated table', () => {
    const matrix = engineCapabilityMatrix();

    matrix.upsertLabel.wwjs.status = 'supported';
    delete matrix.upsertLabel.evidence;

    expect(CURATED_CAPABILITY_EXCEPTIONS.upsertLabel.wwjs.status).toBe('not-available');
    expect(CURATED_CAPABILITY_EXCEPTIONS.upsertLabel.evidence).toBeTruthy();
  });
});
