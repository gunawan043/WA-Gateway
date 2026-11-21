/**
 * One keyword, normalised for storage and for matching: NFKC (so full-width and composed forms
 * agree), lowercase, punctuation to spaces, whitespace collapsed.
 *
 * The result is matched as a whole token sequence — `smp putra` matches "mau tanya smp putra" but
 * not "smp putraaa" — which is why punctuation is removed rather than kept: "smp-putra" and
 * "SMP Putra" must be the same keyword.
 */
export function normalizeKeyword(raw: string): string {
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
