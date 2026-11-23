import { Inject, Injectable, Optional } from '@nestjs/common';
import { createLogger } from '../../common/services/logger.service';
import { recordApprovalCommand } from '../../common/metrics/approval-metrics';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { ALIM_CORE_APPROVAL_CLIENT } from './core-client/alim-core-approval.client';
import type { AlimCoreApprovalClient, CoreApprovalResult } from './core-client/alim-core-approval.client';
import { ApprovalCommand } from './entities/approval-command.entity';
import { ApprovalRequest, ApprovalRequestStatus } from './entities/approval-request.entity';
import { looksLikeApprovalReply, parseApprovalMessage, ParsedApprovalIntent } from './approval-message.parser';
import { ApprovalConfirmationService } from './approval-confirmation.service';
import { ApprovalReplyResolver } from './approval-reply-resolver.service';
import { isDecidable } from './approval-status';
import { isRetryExhausted, nextAttemptAt, readRetryPolicy, RETRY_EXHAUSTED_MESSAGE } from './approval-retry.policy';
import { WhatsAppIdentityService } from './whatsapp-identity.service';
import { boundCoreBody } from './core-response-body';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';

export interface ApprovalInboundContext {
  sessionId: string | null;
  externalMessageId: string;
  chatId: string;
  senderIdentity: string;
  body: string | null;
  quotedMessageId: string | null;
  isGroup: boolean;
  fromMe: boolean;
}

export type ApprovalInboundOutcome =
  | 'ignored'
  | 'duplicate'
  | 'unknown_sender'
  | 'not_found'
  | 'not_authorized'
  | 'not_decidable'
  | 'clarification'
  | 'invalid_duration'
  | 'applied'
  | 'core_rejected'
  | 'core_unavailable';

/**
 * Approval Processor.
 *
 * Alur: verifikasi identitas → kaitkan permohonan → parse deterministik →
 * kirim command ke Core → perbarui status → konfirmasi hanya setelah Core
 * menyatakan sukses.
 */
@Injectable()
export class ApprovalProcessorService {
  private readonly logger = createLogger(ApprovalProcessorService.name);

  constructor(
    @InjectRepository(ApprovalRequest, 'data')
    private readonly requests: Repository<ApprovalRequest>,
    @InjectRepository(ApprovalCommand, 'data')
    private readonly commands: Repository<ApprovalCommand>,
    private readonly identities: WhatsAppIdentityService,
    private readonly resolver: ApprovalReplyResolver,
    private readonly confirmation: ApprovalConfirmationService,
    private readonly config: ConfigService,
    @Inject(ALIM_CORE_APPROVAL_CLIENT)
    private readonly core: AlimCoreApprovalClient,
    // Written for every command outcome; optional so a direct-construction unit test does not have to
    // build an audit repository. AuditService.log is itself best-effort and never throws.
    @Optional()
    private readonly audit?: AuditService,
  ) {}

  async handle(ctx: ApprovalInboundContext): Promise<ApprovalInboundOutcome> {
    if (ctx.isGroup || ctx.fromMe || !looksLikeApprovalReply(ctx.body)) {
      return 'ignored';
    }

    // 1. Idempotensi tingkat pesan: satu pesan tidak pernah menghasilkan dua command.
    const already = await this.commands.findOne({ where: { externalMessageId: ctx.externalMessageId } });

    if (already) {
      return 'duplicate';
    }

    // 2. Identitas pengirim harus terverifikasi.
    const sender = await this.identities.findVerified(ctx.senderIdentity);

    if (!sender) {
      if (this.config.get<boolean>('connect.approval.replyToUnknownSender', false)) {
        await this.confirmation.unknownSender(ctx.sessionId, ctx.chatId);
      }

      return 'unknown_sender';
    }

    const parsed = parseApprovalMessage(ctx.body);

    if (parsed.kind === 'unrecognized') {
      return 'ignored';
    }

    // 3. Kaitkan balasan ke satu permohonan.
    const resolution = await this.resolver.resolve({
      sessionId: ctx.sessionId,
      senderIdentity: ctx.senderIdentity,
      quotedMessageId: ctx.quotedMessageId,
      reference: parsed.kind === 'invalid_duration' ? null : parsed.reference,
    });

    if (!resolution.request) {
      await this.confirmation.notFound(
        ctx.sessionId,
        ctx.chatId,
        parsed.kind === 'invalid_duration' ? null : parsed.reference,
      );

      return 'not_found';
    }

    const request = resolution.request;

    // 4. Pengirim harus orang yang dituju.
    if (request.targetCorePersonId && request.targetCorePersonId !== sender.corePersonId) {
      await this.confirmation.notAuthorized(request);

      return 'not_authorized';
    }

    // 5. Command sebelumnya yang belum terkonfirmasi tidak boleh diganti
    //    dengan command baru: keputusan ganda harus dihindari. `PENDING` ikut di sini —
    //    command sudah tersimpan tetapi belum tentu terkirim.
    const lastCommand = await this.commands.findOne({
      where: { approvalRequestId: request.id },
      order: { createdAt: 'DESC' },
    });

    if (lastCommand && (lastCommand.status === 'UNKNOWN' || lastCommand.status === 'PENDING')) {
      const sameDecision =
        parsed.kind !== 'clarify' &&
        parsed.kind !== 'invalid_duration' &&
        lastCommand.decision === (parsed.kind === 'approve' ? 'approved' : 'rejected') &&
        lastCommand.durationDays === (parsed.kind === 'approve' ? parsed.durationDays : null);

      if (sameDecision) {
        return this.sendToCore(request, lastCommand);
      }

      await this.confirmation.coreUnavailable(request);

      return 'core_unavailable';
    }

    if (lastCommand?.status === 'FAILED') {
      // Retry sudah habis tanpa kepastian: proses menunggu pemeriksaan manual, dan
      // balasan baru tidak boleh membuat command kedua.
      await this.confirmation.coreUnavailable(request);

      return 'core_unavailable';
    }

    // 6. Permohonan masih dapat diputuskan.
    if (!isDecidable(request.status)) {
      await this.confirmation.alreadyDecided(request);

      return 'not_decidable';
    }

    // 7. Balasan yang belum lengkap tidak pernah memakai durasi default.
    if (parsed.kind === 'clarify') {
      request.status = 'NEEDS_CLARIFICATION';
      request.clarificationCount += 1;
      await this.requests.save(request);

      await this.confirmation.clarification(
        request,
        parsed.reason === 'missing_duration' ? 'missing_duration' : 'ambiguous',
      );

      return 'clarification';
    }

    if (parsed.kind === 'invalid_duration') {
      await this.confirmation.invalidDuration(request, parsed.value);

      return 'invalid_duration';
    }

    return this.submitDecision(request, parsed, ctx);
  }

  /**
   * Kirim ulang command yang hasilnya belum diketahui memakai `commandId` yang
   * sama. Aman karena Core idempoten terhadap `command_id`.
   */
  async retryUnknown(commandId: string): Promise<ApprovalInboundOutcome> {
    const command = await this.commands.findOne({ where: { commandId } });

    if (!command || (command.status !== 'UNKNOWN' && command.status !== 'PENDING')) {
      return 'ignored';
    }

    const request = await this.requests.findOne({ where: { id: command.approvalRequestId } });

    if (!request) {
      // Tanpa permohonan, command tidak akan pernah bisa dikirim: parkir untuk pemeriksaan
      // manual, jangan biarkan worker mengulanginya setiap pass.
      await this.commands
        .createQueryBuilder()
        .update(ApprovalCommand)
        .set({
          status: 'FAILED',
          nextAttemptAt: null,
          lastError: 'Permohonan untuk command ini tidak ditemukan.',
        })
        .where('id = :id', { id: command.id })
        .andWhere('status IN (:...statuses)', { statuses: ['PENDING', 'UNKNOWN'] })
        .execute();

      command.status = 'FAILED';
      command.nextAttemptAt = null;
      command.lastError = 'Permohonan untuk command ini tidak ditemukan.';
      await this.auditCommand(command, request, 'request_missing', 'warn');

      return 'not_found';
    }

    if (isRetryExhausted(command.attempts, readRetryPolicy(this.config))) {
      // Batas tercapai: jangan kirim lagi, tandai untuk pemeriksaan manual. Update bersyarat
      // agar hasil yang sudah ditetapkan proses lain tidak tertimpa.
      await this.commands
        .createQueryBuilder()
        .update(ApprovalCommand)
        .set({
          status: 'FAILED',
          nextAttemptAt: null,
          lastError: command.lastError ?? RETRY_EXHAUSTED_MESSAGE,
        })
        .where('id = :id', { id: command.id })
        .andWhere('status IN (:...statuses)', { statuses: ['PENDING', 'UNKNOWN'] })
        .execute();

      command.status = 'FAILED';
      command.nextAttemptAt = null;
      command.lastError = command.lastError ?? RETRY_EXHAUSTED_MESSAGE;
      await this.auditCommand(command, request, 'exhausted', 'warn');

      return 'core_unavailable';
    }

    return this.sendToCore(request, command, { notifyUnavailable: false });
  }

  private async submitDecision(
    request: ApprovalRequest,
    parsed: Extract<ParsedApprovalIntent, { kind: 'approve' | 'reject' }>,
    ctx: ApprovalInboundContext,
  ): Promise<ApprovalInboundOutcome> {
    const decision = parsed.kind === 'approve' ? 'approved' : 'rejected';
    const durationDays = parsed.kind === 'approve' ? parsed.durationDays : null;

    let command: ApprovalCommand;

    try {
      command = await this.commands.save(
        this.commands.create({
          commandId: randomUUID(),
          approvalRequestId: request.id,
          externalMessageId: ctx.externalMessageId,
          decision,
          durationDays,
          status: 'PENDING',
          // Lease: bila proses berhenti sebelum mengirim, worker baru boleh mengambil alih
          // setelah jendela ini habis — pengirim yang masih hidup tidak didahului.
          nextAttemptAt: new Date(Date.now() + readRetryPolicy(this.config).leaseMs),
        }),
      );
    } catch (error) {
      // Balapan unik (pesan yang sama datang dua kali) → anggap duplikat.
      this.logger.debug(`Command untuk pesan ${ctx.externalMessageId} sudah ada: ${String(error)}`);

      return 'duplicate';
    }

    request.status = 'PROCESSING';
    request.lastCommandId = command.commandId;
    await this.requests.save(request);

    return this.sendToCore(request, command);
  }

  private async sendToCore(
    request: ApprovalRequest,
    command: ApprovalCommand,
    options: { notifyUnavailable?: boolean } = {},
  ): Promise<ApprovalInboundOutcome> {
    const result = await this.core.sendApprovalCommand({
      commandId: command.commandId,
      requestId: request.coreRequestId,
      decision: command.decision,
      approvedDurationDays: command.durationDays,
      actorExternalId: request.targetIdentity ?? '',
      actorCorePersonId: request.targetCorePersonId,
      source: 'whatsapp',
      externalMessageId: command.externalMessageId,
      messageText: this.messageTextFor(command),
      notes: null,
    });

    const now = new Date();

    command.attempts += 1;
    command.lastAttemptAt = now;
    command.coreResponseCode = result.httpStatus;
    // Bounded: the reply is kept for manual review, never for the API, and must not be able to
    // grow the row without a ceiling. A body that fits is stored exactly as received.
    command.coreResponseBody = boundCoreBody(result.raw as Record<string, unknown> | null);
    command.errorCode = result.code;

    if (result.outcome === 'applied' || result.outcome === 'duplicate') {
      command.status = result.outcome === 'duplicate' ? 'DUPLICATE' : 'APPLIED';
      command.resolvedAt = now;
      command.nextAttemptAt = null;
      command.lastError = null;
      recordApprovalCommand(result.outcome);

      request.status = statusForApplied(result, command.decision);
      request.coreStatus = result.coreStatus ?? command.decision;

      // Hanya keputusan final yang menandai waktu keputusan; tiga nilai non-final
      // mempertahankan proses tetap terbuka.
      if (request.status === 'APPROVED' || request.status === 'REJECTED') {
        request.decidedAt = now;
        request.decisionSource = 'whatsapp';
      }

      if (result.expectedReturnAt) {
        request.expectedReturnAt = new Date(result.expectedReturnAt);
      }

      await this.commands.save(command);
      await this.requests.save(request);

      // Audit before the WhatsApp confirmation: the decision is already durable in Core's answer, and
      // a best-effort send must not be able to hide it from the trail.
      await this.auditCommand(command, request, result.outcome);

      // Konfirmasi hanya setelah Core menyatakan sukses, dan pesannya mengikuti status yang
      // benar-benar ditetapkan Core — termasuk tiga nilai non-final.
      switch (request.status) {
        case 'APPROVED':
          await this.confirmation.approved(request, command.durationDays, result.expectedReturnAt);
          break;
        case 'REJECTED':
          await this.confirmation.rejected(request);
          break;
        case 'EXPIRED':
          await this.confirmation.expired(request);
          break;
        case 'CANCELLED':
          await this.confirmation.cancelled(request);
          break;
        default:
          await this.confirmation.clarification(request, 'ambiguous');
      }

      return 'applied';
    }

    if (result.outcome === 'unavailable') {
      const policy = readRetryPolicy(this.config);
      const exhausted = isRetryExhausted(command.attempts, policy);

      command.status = exhausted ? 'FAILED' : 'UNKNOWN';
      command.lastError = result.message.slice(0, 500);
      command.nextAttemptAt = exhausted ? null : nextAttemptAt(command.attempts, now, policy);
      recordApprovalCommand(exhausted ? 'failed' : 'unknown');
      await this.commands.save(command);

      await this.auditCommand(command, request, exhausted ? 'exhausted' : 'unavailable', 'warn');

      // Pesan "belum dapat dipastikan" bukan konfirmasi sukses/gagal; pada retry
      // berikutnya pesan ini tidak diulang agar Kepala Asrama tidak dibanjiri.
      if (options.notifyUnavailable !== false) {
        await this.confirmation.coreUnavailable(request);
      }

      return 'core_unavailable';
    }

    command.status = 'REJECTED';
    command.resolvedAt = now;
    command.nextAttemptAt = null;
    command.lastError = result.message.slice(0, 500);
    recordApprovalCommand('rejected');
    await this.commands.save(command);

    request.status = this.statusForCoreRejection(result);
    request.coreStatus = result.coreStatus ?? request.coreStatus;

    // Core menolak command karena izinnya sudah final: status lokal mengikuti Core, dan
    // jejak auditnya dilengkapi seperti jalur `applied` — sumbernya Core, bukan balasan.
    if (request.status === 'APPROVED' || request.status === 'REJECTED') {
      request.decidedAt = now;
      request.decisionSource = 'core';
    }

    await this.requests.save(request);

    await this.auditCommand(command, request, 'rejected', 'warn');

    switch (result.code) {
      case 'actor_not_authorized':
        await this.confirmation.notAuthorized(request);
        break;
      case 'duration_invalid':
      case 'duration_out_of_range':
      case 'permit_missing_departure':
        await this.confirmation.invalidDuration(request, command.durationDays);
        break;
      case 'permit_not_decidable':
        await this.confirmation.alreadyDecided(request);
        break;
      default:
        await this.confirmation.coreRejected(request, result.message);
    }

    return 'core_rejected';
  }

  /**
   * One audit row per command outcome. Written at the terminal point of each path (applied,
   * duplicate, unknown, exhausted, rejected) so the retry worker is recorded exactly like an
   * inbound reply. Deliberately carries no message text, no sender number and no credential:
   * the command id, Core's request id and Core's status are what reconcile this decision with
   * Core, and the actor is named by Core's person id rather than by the number that answered.
   */
  private auditCommand(
    command: ApprovalCommand,
    request: ApprovalRequest | null,
    outcome: string,
    severity: 'info' | 'warn' = 'info',
  ): Promise<unknown> {
    const context = {
      sessionId: request?.sessionId ?? undefined,
      metadata: {
        outcome,
        commandId: command.commandId,
        coreRequestId: request?.coreRequestId ?? null,
        decision: command.decision,
        approvedDurationDays: command.durationDays,
        attempts: command.attempts,
        commandStatus: command.status,
        requestStatus: request?.status ?? null,
        coreResponseCode: command.coreResponseCode,
        coreErrorCode: command.errorCode ?? null,
        actorCorePersonId: request?.targetCorePersonId ?? null,
      },
    };

    return (
      (severity === 'warn'
        ? this.audit?.logWarn(AuditAction.APPROVAL_COMMAND, context)
        : this.audit?.logInfo(AuditAction.APPROVAL_COMMAND, context)) ?? Promise.resolve(null)
    );
  }

  private statusForCoreRejection(result: CoreApprovalResult): ApprovalRequestStatus {
    if (result.coreStatus === 'approved' || result.coreStatus === 'rejected') {
      return result.coreStatus === 'approved' ? 'APPROVED' : 'REJECTED';
    }

    if (result.code === 'permit_expired') {
      return 'EXPIRED';
    }

    return 'PENDING_APPROVAL';
  }

  /**
   * Teks pesan yang dikirim ke Core. Hanya keputusan WhatsApp yang punya bentuk teks;
   * nilai lain (bila kelak dikirim proses internal) tetap dikirim apa adanya sebagai catatan.
   */
  private messageTextFor(command: ApprovalCommand): string | null {
    switch (command.decision) {
      case 'approved':
        return `SETUJU ${command.durationDays ?? ''} HARI`;
      case 'rejected':
        return 'TOLAK';
      default:
        return command.decision;
    }
  }
}

/**
 * Status internal Connect untuk hasil Core yang diterapkan.
 *
 * `needs_clarification`/`expired`/`cancelled` bukan keputusan final, tetapi tetap
 * dipetakan agar status lokal tidak pernah bertentangan dengan status izin di Core.
 */
function statusForApplied(result: CoreApprovalResult, decision: string): ApprovalRequestStatus {
  switch (result.decisionOutcome) {
    case 'needs_clarification':
      return 'NEEDS_CLARIFICATION';
    case 'expired':
      return 'EXPIRED';
    case 'cancelled':
      return 'CANCELLED';
    default:
      return decision === 'approved' ? 'APPROVED' : 'REJECTED';
  }
}
