import {
  extractReference,
  looksLikeApprovalReply,
  normalizeApprovalBody,
  parseApprovalMessage,
} from './approval-message.parser';

describe('parseApprovalMessage', () => {
  it('parses SETUJU with an explicit duration and reference', () => {
    expect(parseApprovalMessage('SETUJU 2 HARI IZN-2026-00125')).toEqual({
      kind: 'approve',
      durationDays: 2,
      reference: 'IZN-2026-00125',
      raw: 'SETUJU 2 HARI IZN-2026-00125',
    });
  });

  it('is case-insensitive and tolerates punctuation and spacing', () => {
    const parsed = parseApprovalMessage('  setuju   3   hari, izn-2026-00007.  ');

    expect(parsed).toMatchObject({ kind: 'approve', durationDays: 3, reference: 'IZN-2026-00007' });
  });

  it('asks for clarification when SETUJU has no duration', () => {
    expect(parseApprovalMessage('SETUJU IZN-2026-00125')).toEqual({
      kind: 'clarify',
      reason: 'missing_duration',
      reference: 'IZN-2026-00125',
      raw: 'SETUJU IZN-2026-00125',
    });
  });

  it('never invents a duration for a bare SETUJU', () => {
    expect(parseApprovalMessage('SETUJU')).toMatchObject({ kind: 'clarify', reason: 'missing_duration' });
  });

  it('rejects an out-of-range duration', () => {
    expect(parseApprovalMessage('SETUJU 0 HARI IZN-2026-00125')).toEqual({
      kind: 'invalid_duration',
      raw: 'SETUJU 0 HARI IZN-2026-00125',
      value: 0,
    });
    expect(parseApprovalMessage('SETUJU 400 HARI IZN-2026-00125')).toMatchObject({ kind: 'invalid_duration' });
  });

  it('parses TOLAK with and without a reference', () => {
    expect(parseApprovalMessage('TOLAK IZN-2026-00125')).toMatchObject({
      kind: 'reject',
      reference: 'IZN-2026-00125',
    });
    expect(parseApprovalMessage('TOLAK')).toMatchObject({ kind: 'reject', reference: null });
  });

  it('treats trailing words after TOLAK as ambiguous', () => {
    expect(parseApprovalMessage('TOLAK IZN-2026-00125 karena sakit')).toMatchObject({
      kind: 'clarify',
      reason: 'ambiguous',
    });
  });

  it('does not guess from a bare reference', () => {
    expect(parseApprovalMessage('IZN-2026-00125')).toMatchObject({ kind: 'clarify', reason: 'ambiguous' });
  });

  it('returns unrecognized for ordinary chat', () => {
    expect(parseApprovalMessage('assalamualaikum pak')).toEqual({
      kind: 'unrecognized',
      raw: 'assalamualaikum pak',
    });
  });

  it('returns unrecognized for a number without HARI', () => {
    expect(parseApprovalMessage('SETUJU 2')).toMatchObject({ kind: 'clarify', reason: 'missing_duration' });
  });
});

describe('helpers', () => {
  it('normalizes non-breaking spaces and smart quotes', () => {
    expect(normalizeApprovalBody('SETUJU\u00a0 2\tHARI')).toBe('SETUJU 2 HARI');
  });

  it('extracts a reference from surrounding text', () => {
    expect(extractReference('mohon cek IZN-2026-00999 ya')).toBe('IZN-2026-00999');
    expect(extractReference('tidak ada referensi')).toBeNull();
  });

  it('only flags approval-like messages', () => {
    expect(looksLikeApprovalReply('SETUJU 2 HARI')).toBe(true);
    expect(looksLikeApprovalReply('TOLAK')).toBe(true);
    expect(looksLikeApprovalReply('IZN-2026-00125')).toBe(true);
    expect(looksLikeApprovalReply('halo')).toBe(false);
    expect(looksLikeApprovalReply('')).toBe(false);
  });
});
