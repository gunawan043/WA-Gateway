import type { ApprovalRequestStatus } from './entities/approval-request.entity';

/**
 * Aturan status internal Connect.
 *
 * Status izin yang sah tetap berasal dari Core; modul ini tidak pernah menyimpulkan
 * persetujuan dari teks balasan. Alur dan statusnya didokumentasikan di docs/36.
 */

/**
 * Permohonan masih boleh diputuskan.
 *
 * `PROCESSING` sengaja tidak termasuk: command sudah terkirim dan hasilnya belum diketahui,
 * jadi balasan baru tidak boleh membuat keputusan kedua.
 */
export function isDecidable(status: ApprovalRequestStatus): boolean {
  return status === 'PENDING_APPROVAL' || status === 'NEEDS_CLARIFICATION';
}
