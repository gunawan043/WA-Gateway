import { Injectable } from '@nestjs/common';
import { createLogger } from '../../../common/services/logger.service';
import { AlimCoreApprovalClient, CoreApprovalCommand, CoreApprovalResult } from './alim-core-approval.client';

/**
 * The client used when ALIM Core integration is deliberately switched off
 * (`ALIM_CONNECT_CORE_CLIENT=disabled`).
 *
 * It exists so ALIM Connect can run on its own — dashboard, WhatsApp sessions, inbox, API keys,
 * webhooks — while the Core integration is not agreed yet. It is NOT a mock: a mock answers
 * `applied`, which would tell a Head of Dormitory their permit was approved when nothing decided it.
 *
 * Every command this sees ends `unavailable` with `retryable: false`, so:
 *  - the request is never marked APPROVED or REJECTED,
 *  - the retry worker does not spin on it forever,
 *  - the audit row says exactly why nothing happened.
 */
@Injectable()
export class DisabledAlimCoreApprovalClient implements AlimCoreApprovalClient {
  private readonly logger = createLogger(DisabledAlimCoreApprovalClient.name);
  private warned = false;

  sendApprovalCommand(command: CoreApprovalCommand): Promise<CoreApprovalResult> {
    // Once per process: a reply-per-command burst would otherwise fill the log with the same line.
    if (!this.warned) {
      this.warned = true;
      this.logger.warn(
        'Integrasi approval ALIM Core DINONAKTIFKAN (ALIM_CONNECT_CORE_CLIENT=disabled): ' +
          'tidak ada keputusan yang dikirim. Aktifkan dengan =http setelah kredensial Core disepakati.',
      );
    }

    return Promise.resolve({
      outcome: 'unavailable',
      decisionOutcome: null,
      httpStatus: 0,
      code: 'core_integration_disabled',
      message:
        'Integrasi persetujuan ALIM Core belum diaktifkan pada ALIM Connect. ' +
        'Keputusan ini tidak dikirim dan tidak dicatat sebagai disetujui atau ditolak.',
      coreStatus: null,
      secondaryStatus: null,
      expectedReturnAt: null,
      // Not retryable: nothing about the configuration changes by trying again, and a retry loop
      // would re-log the same refusal for every command.
      retryable: false,
      raw: { command_id: command.commandId, disabled: true },
    });
  }
}
