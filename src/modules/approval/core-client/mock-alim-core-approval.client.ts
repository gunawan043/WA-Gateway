import { Injectable } from '@nestjs/common';
import { createLogger } from '../../../common/services/logger.service';
import {
  AlimCoreApprovalClient,
  CoreApprovalCommand,
  CoreApprovalDecision,
  CoreApprovalResult,
  CoreDecisionOutcome,
} from './alim-core-approval.client';
/**
 * Skenario yang dapat dipilih tes. Nilainya meniru jawaban nyata Core:
 * sukses, duplikat, keputusan non-final, validasi/otorisasi ditolak, timeout, dan 5xx.
 */
export type MockCoreScenario =
  | 'applied'
  | 'duplicate'
  | 'needs_clarification'
  | 'expired'
  | 'cancelled'
  | 'invalid_duration'
  | 'not_authorized'
  | 'not_decidable'
  | 'timeout'
  | 'server_error';

/**
 * Mock Core untuk pengembangan dan pengujian kontrak.
 *
 * Bukan endpoint palsu di Core: kelas ini hanya hidup di proses Connect dan
 * dipilih lewat konfigurasi `connect.approval.coreClient = 'mock'`.
 */
@Injectable()
export class MockAlimCoreApprovalClient implements AlimCoreApprovalClient {
  private readonly logger = createLogger(MockAlimCoreApprovalClient.name);

  /** Skenario berikutnya; `null` berarti perilaku default mengikuti `decision`. */
  scenario: MockCoreScenario | null = null;

  /** Semua command yang diterima mock, untuk assertion tes. */
  readonly received: CoreApprovalCommand[] = [];

  private readonly decided = new Map<string, CoreApprovalResult>();

  // eslint-disable-next-line @typescript-eslint/require-await -- kontrak klien mengembalikan Promise
  async sendApprovalCommand(command: CoreApprovalCommand): Promise<CoreApprovalResult> {
    // Lapis kedua setelah guard startup: bila konfigurasi produksi entah bagaimana tetap memilih
    // mock, mock tidak boleh menjawab `applied` — Connect akan mengirim konfirmasi persetujuan
    // palsu. Gagal di sini lebih baik daripada keputusan yang tidak pernah ada di Core.
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Mock Core tidak boleh dipakai di produksi: tidak ada keputusan final yang dapat dihasilkan.');
    }

    this.received.push(command);

    const scenario = this.scenario ?? 'applied';

    this.logger.debug(`Mock Core menerima command ${command.commandId} (${scenario})`);

    switch (scenario) {
      case 'timeout':
        return this.result('unavailable', null, 504, 'core_timeout', 'Core tidak merespons tepat waktu.', true);
      case 'server_error':
        return this.result('unavailable', null, 503, 'core_unavailable', 'Core sedang tidak tersedia.', true);
      case 'invalid_duration':
        return this.result(
          'rejected',
          null,
          422,
          'duration_out_of_range',
          'Durasi izin harus antara 1 dan 365 hari.',
          false,
        );
      case 'not_authorized':
        return this.result(
          'rejected',
          null,
          403,
          'actor_not_authorized',
          'Aktor bukan Kepala Asrama aktif pada asrama permohonan ini.',
          false,
        );
      case 'not_decidable':
        return this.result(
          'rejected',
          null,
          409,
          'permit_not_decidable',
          'Permohonan sudah diputuskan atau tidak lagi dapat diputuskan.',
          false,
        );
      case 'duplicate': {
        const previous = this.decided.get(command.commandId);

        if (previous) {
          return { ...previous, outcome: 'duplicate', decisionOutcome: 'duplicate', httpStatus: 200 };
        }

        break;
      }
      case 'needs_clarification':
      case 'expired':
      case 'cancelled':
        return this.apply(command, scenario);
      case 'applied':
        break;
    }

    return this.apply(command, null);
  }

  reset(): void {
    this.scenario = null;
    this.received.length = 0;
    this.decided.clear();
  }

  /**
   * Menerapkan command seperti Core: `approved`/`rejected` menjadi keputusan final,
   * sedangkan `needs_clarification`/`expired`/`cancelled` mempertahankan status
   * `pending` dan hanya mengisi `secondary_status`.
   */
  private apply(command: CoreApprovalCommand, forced: CoreApprovalDecision | null): CoreApprovalResult {
    const decision = forced ?? command.decision;
    const outcome: CoreDecisionOutcome = decision === 'approved' || decision === 'rejected' ? 'applied' : decision;

    const status = decision === 'approved' ? 'approved' : decision === 'rejected' ? 'rejected' : 'pending';
    const secondaryStatus =
      decision === 'needs_clarification' || decision === 'expired' || decision === 'cancelled' ? decision : null;

    const result = this.result('applied', outcome, 200, null, 'Keputusan izin tersimpan.', false, {
      status,
      secondaryStatus,
      expectedReturnAt:
        decision === 'approved' && command.approvedDurationDays ? this.addDays(command.approvedDurationDays) : null,
    });

    this.decided.set(command.commandId, result);

    return result;
  }

  private result(
    outcome: CoreApprovalResult['outcome'],
    decisionOutcome: CoreDecisionOutcome | null,
    httpStatus: number,
    code: string | null,
    message: string,
    retryable: boolean,
    extra: { status?: string | null; secondaryStatus?: string | null; expectedReturnAt?: string | null } = {},
  ): CoreApprovalResult {
    return {
      outcome,
      decisionOutcome,
      httpStatus,
      code,
      message,
      coreStatus: extra.status ?? null,
      secondaryStatus: extra.secondaryStatus ?? null,
      expectedReturnAt: extra.expectedReturnAt ?? null,
      retryable,
      raw: null,
    };
  }

  private addDays(days: number): string | null {
    if (!days) {
      return null;
    }

    const base = new Date();
    base.setUTCDate(base.getUTCDate() + days);

    return base.toISOString();
  }
}
