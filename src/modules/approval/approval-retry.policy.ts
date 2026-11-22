/**
 * Kebijakan retry command persetujuan.
 *
 * Satu tempat untuk batas percobaan dan jeda, dipakai baik oleh pengiriman pertama
 * maupun worker retry, sehingga keduanya tidak dapat memakai jadwal yang berbeda.
 *
 * Jeda bersifat eksponensial dan dibatasi: percobaan ke-n menunggu
 * `baseDelayMs * 2^(n-1)`, tidak pernah melebihi `maxDelayMs`.
 */

export interface ApprovalRetryPolicy {
  /** Percobaan maksimum untuk satu command, termasuk pengiriman pertama. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Lease untuk klaim baris; worker lain tidak menyentuh baris sebelum waktu ini. */
  leaseMs: number;
}

export const DEFAULT_APPROVAL_RETRY_POLICY: ApprovalRetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 30_000,
  maxDelayMs: 15 * 60_000,
  leaseMs: 60_000,
};

/** Jeda sebelum percobaan berikutnya, setelah `attempts` percobaan gagal. */
export function retryDelayMs(attempts: number, policy: ApprovalRetryPolicy = DEFAULT_APPROVAL_RETRY_POLICY): number {
  const exponent = Math.max(0, attempts - 1);
  const delay = policy.baseDelayMs * 2 ** exponent;

  return Math.min(delay, policy.maxDelayMs);
}

export function nextAttemptAt(attempts: number, now: Date, policy?: ApprovalRetryPolicy): Date {
  return new Date(now.getTime() + retryDelayMs(attempts, policy));
}

/** True bila command sudah tidak boleh dicoba lagi dan masuk pemeriksaan manual. */
export function isRetryExhausted(
  attempts: number,
  policy: ApprovalRetryPolicy = DEFAULT_APPROVAL_RETRY_POLICY,
): boolean {
  return attempts >= policy.maxAttempts;
}

/** Alasan yang disimpan saat command diparkir: satu teks untuk worker dan processor. */
export const RETRY_EXHAUSTED_MESSAGE = 'Batas percobaan tercapai tanpa kepastian dari Core.';

/** Sumber konfigurasi minimal; cukup `get`, sehingga tes tidak perlu ConfigService penuh. */
export interface ApprovalRetryConfigSource {
  get<T = number>(key: string): T | undefined;
}

/**
 * Baca kebijakan retry dari konfigurasi. Dipakai worker dan processor supaya keduanya tidak
 * pernah memakai batas percobaan atau jadwal yang berbeda.
 */
export function readRetryPolicy(config: ApprovalRetryConfigSource): ApprovalRetryPolicy {
  const value = (key: string, fallback: number): number => {
    const configured = config.get<number>(key);

    return typeof configured === 'number' && Number.isFinite(configured) && configured >= 0 ? configured : fallback;
  };

  return {
    maxAttempts: value('connect.approval.retry.maxAttempts', DEFAULT_APPROVAL_RETRY_POLICY.maxAttempts),
    baseDelayMs: value('connect.approval.retry.baseDelayMs', DEFAULT_APPROVAL_RETRY_POLICY.baseDelayMs),
    maxDelayMs: value('connect.approval.retry.maxDelayMs', DEFAULT_APPROVAL_RETRY_POLICY.maxDelayMs),
    leaseMs: value('connect.approval.retry.leaseMs', DEFAULT_APPROVAL_RETRY_POLICY.leaseMs),
  };
}
