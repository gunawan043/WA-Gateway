/**
 * Parser deterministik balasan persetujuan WhatsApp.
 *
 * Format yang didukung (tanpa menebak):
 *   SETUJU 2 HARI IZN-2026-00125
 *   SETUJU IZN-2026-00125        → butuh klarifikasi durasi
 *   TOLAK IZN-2026-00125
 *   TOLAK
 *
 * Referensi opsional hanya bila balasan adalah reply langsung ke notifikasi
 * (diselesaikan oleh Reply Resolver, bukan parser ini).
 */

export const MAX_DURATION_DAYS = 365;

export type ParsedApprovalIntent =
  | { kind: 'approve'; durationDays: number; reference: string | null; raw: string }
  | { kind: 'reject'; reference: string | null; raw: string }
  | {
      kind: 'clarify';
      reason: 'missing_duration' | 'missing_reference' | 'ambiguous';
      reference: string | null;
      raw: string;
    }
  | { kind: 'invalid_duration'; raw: string; value: number | null }
  | { kind: 'unrecognized'; raw: string };

const REFERENCE = /^[A-Z]{2,6}-\d{4}-\d{3,8}$/;
const DURATION = /(\d{1,4})\s*HARI\b/;

export function normalizeApprovalBody(body: string | null | undefined): string {
  return (body ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractReference(body: string): string | null {
  const tokens = normalizeApprovalBody(body)
    .toUpperCase()
    .split(/[^A-Z0-9-]+/);

  for (const token of tokens) {
    const cleaned = token.replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/g, '');

    if (REFERENCE.test(cleaned)) {
      return cleaned;
    }
  }

  return null;
}

export function parseApprovalMessage(body: string | null | undefined): ParsedApprovalIntent {
  const raw = normalizeApprovalBody(body);

  if (raw === '') {
    return { kind: 'unrecognized', raw };
  }

  const upper = raw.toUpperCase();
  const reference = extractReference(upper);

  if (/^SETUJU\b/.test(upper)) {
    const remainder = upper.replace(/^SETUJU\b/, '').trim();
    const duration = DURATION.exec(remainder);

    if (!duration) {
      // "SETUJU" tanpa durasi eksplisit tidak boleh memakai durasi default.
      return {
        kind: 'clarify',
        reason: 'missing_duration',
        reference,
        raw,
      };
    }

    const value = Number.parseInt(duration[1], 10);

    if (!Number.isInteger(value) || value < 1 || value > MAX_DURATION_DAYS) {
      return { kind: 'invalid_duration', raw, value: Number.isFinite(value) ? value : null };
    }

    return { kind: 'approve', durationDays: value, reference, raw };
  }

  if (/^TOLAK\b/.test(upper)) {
    const remainder = upper.replace(/^TOLAK\b/, '').trim();

    // Teks setelah TOLAK hanya boleh berisi referensi; selain itu ambigu.
    if (remainder !== '' && remainder !== reference) {
      return { kind: 'clarify', reason: 'ambiguous', reference, raw };
    }

    return { kind: 'reject', reference, raw };
  }

  // Pesan yang hanya berisi referensi tidak cukup untuk menentukan keputusan.
  if (reference && upper === reference) {
    return { kind: 'clarify', reason: 'ambiguous', reference, raw };
  }

  return { kind: 'unrecognized', raw };
}

/**
 * Apakah pesan ini kandidat balasan persetujuan? Dipakai hook agar pesan biasa
 * tidak membebani jalur pemrosesan.
 */
export function looksLikeApprovalReply(body: string | null | undefined): boolean {
  const upper = normalizeApprovalBody(body).toUpperCase();

  if (upper === '') {
    return false;
  }

  if (/^(SETUJU|TOLAK)\b/.test(upper)) {
    return true;
  }

  return extractReference(upper) !== null;
}
