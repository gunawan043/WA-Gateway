import { Injectable } from '@nestjs/common';
import { createLogger } from '../../../common/services/logger.service';
import { ConfigService } from '@nestjs/config';
import {
  AlimCoreApprovalClient,
  CoreApprovalCommand,
  CoreApprovalResult,
  CoreDecisionOutcome,
} from './alim-core-approval.client';

interface CoreEnvelope {
  success?: boolean;
  message?: string;
  data?: Record<string, unknown> | null;
  errors?: { code?: string; context?: Record<string, unknown> } | null;
}

const DECISION_OUTCOMES: readonly CoreDecisionOutcome[] = [
  'applied',
  'needs_clarification',
  'expired',
  'cancelled',
  'duplicate',
];

const asDecisionOutcome = (value: unknown): CoreDecisionOutcome | null =>
  typeof value === 'string' && (DECISION_OUTCOMES as readonly string[]).includes(value)
    ? (value as CoreDecisionOutcome)
    : null;

/**
 * Klien HTTP nyata ke `POST /api/connect/v1/approval-commands`.
 *
 * Tidak pernah menyimpulkan keputusan dari timeout: hasil `unavailable`
 * berarti status tidak diketahui dan Connect harus memakai `commandId` yang
 * sama bila mencoba lagi.
 */
@Injectable()
export class HttpAlimCoreApprovalClient implements AlimCoreApprovalClient {
  private readonly logger = createLogger(HttpAlimCoreApprovalClient.name);

  constructor(private readonly config: ConfigService) {}

  async sendApprovalCommand(command: CoreApprovalCommand): Promise<CoreApprovalResult> {
    const baseUrl = (this.config.get<string>('connect.approval.coreBaseUrl') ?? '').replace(/\/+$/, '');
    const apiKey = this.config.get<string>('connect.approval.coreApiKey') ?? '';
    const header = this.config.get<string>('connect.approval.coreApiHeader') ?? 'X-ALIM-CONNECT-APPROVAL-KEY';
    const timeoutMs = this.config.get<number>('connect.approval.timeoutMs') ?? 5000;

    if (baseUrl === '' || apiKey === '') {
      return {
        outcome: 'unavailable',
        decisionOutcome: null,
        httpStatus: 0,
        code: 'core_not_configured',
        message: 'ALIM Core belum dikonfigurasi pada Connect.',
        coreStatus: null,
        secondaryStatus: null,
        expectedReturnAt: null,
        retryable: false,
        raw: null,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${baseUrl}/api/connect/v1/approval-commands`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          [header]: apiKey,
        },
        body: JSON.stringify({
          command_id: command.commandId,
          request_id: command.requestId,
          decision: command.decision,
          approved_duration_days: command.approvedDurationDays,
          actor_external_id: command.actorExternalId,
          actor_core_person_id: command.actorCorePersonId,
          source: command.source,
          external_message_id: command.externalMessageId,
          message_text: command.messageText,
          notes: command.notes,
        }),
        signal: controller.signal,
      });

      const body = (await response.json().catch(() => null)) as CoreEnvelope | null;

      return this.mapResponse(response.status, body);
    } catch (error) {
      // Node membungkus abort sebagai `TypeError: fetch failed` dengan cause
      // AbortError, jadi status signal-lah yang otoritatif.
      const aborted = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');

      this.logger.warn(`Command ${command.commandId} gagal menghubungi Core: ${String(error)}`);

      return {
        outcome: 'unavailable',
        decisionOutcome: null,
        httpStatus: aborted ? 504 : 0,
        code: aborted ? 'core_timeout' : 'core_unreachable',
        message: aborted ? 'Core tidak merespons tepat waktu.' : 'Core tidak dapat dihubungi.',
        coreStatus: null,
        secondaryStatus: null,
        expectedReturnAt: null,
        retryable: true,
        raw: null,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private mapResponse(status: number, body: CoreEnvelope | null): CoreApprovalResult {
    const data = body?.data ?? null;
    const code = body?.errors?.code ?? null;
    const message = body?.message ?? `Core menjawab HTTP ${status}.`;
    const coreStatus = typeof data?.status === 'string' ? data.status : null;
    const secondaryStatus = typeof data?.secondary_status === 'string' ? data.secondary_status : null;
    const expectedReturnAt = typeof data?.expected_return_datetime === 'string' ? data.expected_return_datetime : null;
    const decisionOutcome = asDecisionOutcome(data?.outcome);
    const duplicate = data?.duplicate === true || decisionOutcome === 'duplicate';

    if (status >= 200 && status < 300 && body?.success !== false) {
      return {
        outcome: duplicate ? 'duplicate' : 'applied',
        decisionOutcome,
        httpStatus: status,
        code,
        message,
        coreStatus,
        secondaryStatus,
        expectedReturnAt,
        retryable: false,
        raw: body,
      };
    }

    // 429 dan 5xx belum tentu gagal permanen; 4xx lain adalah penolakan bisnis.
    const retryable = status === 429 || status >= 500;

    return {
      outcome: retryable ? 'unavailable' : 'rejected',
      decisionOutcome,
      httpStatus: status,
      code,
      message,
      coreStatus,
      secondaryStatus,
      expectedReturnAt,
      retryable,
      raw: body,
    };
  }
}
