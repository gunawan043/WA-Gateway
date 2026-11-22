/**
 * Kontrak klien Approval Command ke ALIM Core.
 *
 * Sumber kebenaran: `docs/integration/alim-connect-approval-command-api.md` di repository
 * ALIM Core (kontrak final, version 1). Connect TIDAK menentukan kewenangan dan TIDAK
 * menyimpan keputusan final; semua hasil di sini adalah jawaban Core atas
 * `POST /api/connect/v1/approval-commands`.
 */

export const ALIM_CORE_APPROVAL_CLIENT = Symbol('ALIM_CORE_APPROVAL_CLIENT');

/** Lima nilai `decision` yang diterima Core (kontrak final §3). */
export type CoreApprovalDecision = 'approved' | 'rejected' | 'needs_clarification' | 'expired' | 'cancelled';

/**
 * Keputusan yang boleh berasal dari balasan Kepala Asrama di WhatsApp.
 *
 * `needs_clarification`, `expired`, dan `cancelled` sengaja tidak termasuk: ketiganya hanya
 * boleh dikirim proses internal yang punya dasar dan kewenangan mengakhiri proses, bukan
 * dari teks WhatsApp.
 */
export type WhatsAppApprovalDecision = Extract<CoreApprovalDecision, 'approved' | 'rejected'>;

export const WHATSAPP_DECISIONS: readonly WhatsAppApprovalDecision[] = ['approved', 'rejected'];

export function isWhatsAppApprovalDecision(value: string): value is WhatsAppApprovalDecision {
  return (WHATSAPP_DECISIONS as readonly string[]).includes(value);
}

/** `data.outcome` yang Core kembalikan (kontrak final §5). */
export type CoreDecisionOutcome = 'applied' | 'needs_clarification' | 'expired' | 'cancelled' | 'duplicate';

export interface CoreApprovalCommand {
  commandId: string;
  requestId: string;
  decision: CoreApprovalDecision;
  approvedDurationDays: number | null;
  actorExternalId: string;
  actorCorePersonId: string | null;
  source: 'whatsapp';
  externalMessageId: string;
  messageText: string | null;
  notes: string | null;
}

/**
 * `applied`     Core menyimpan keputusan.
 * `duplicate`   command_id/pesan yang sama sudah pernah diproses Core.
 * `rejected`    Core menolak command dengan alasan bisnis/otorisasi.
 * `unavailable` Core tidak dapat dihubungi/timeout/5xx — keputusan TIDAK diketahui.
 */
export type CoreApprovalOutcome = 'applied' | 'duplicate' | 'rejected' | 'unavailable';

export interface CoreApprovalResult {
  outcome: CoreApprovalOutcome;
  /** `data.outcome` Core saat menjawab; `null` bila Core tidak menjawab. */
  decisionOutcome: CoreDecisionOutcome | null;
  httpStatus: number;
  code: string | null;
  message: string;
  /** Status izin versi Core setelah keputusan (`approved`/`rejected`/`pending`). */
  coreStatus: string | null;
  /** `secondary_status` Core (`needs_clarification`/`expired`/`cancelled`/…). */
  secondaryStatus: string | null;
  expectedReturnAt: string | null;
  /** Aman untuk dikirim ulang dengan `commandId` yang sama. */
  retryable: boolean;
  raw: unknown;
}

export interface AlimCoreApprovalClient {
  sendApprovalCommand(command: CoreApprovalCommand): Promise<CoreApprovalResult>;
}
