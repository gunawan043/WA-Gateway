import { BadRequestException, Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { setTimeout as delay } from 'node:timers/promises';
import { In, Repository } from 'typeorm';
import { createLogger } from '../../common/services/logger.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { AuditService } from '../audit/audit.service';
import { ApiKey } from '../auth/entities/api-key.entity';
import { EventsGateway } from '../events/events.gateway';
import { BulkMessageService } from '../message/bulk-message.service';
import { BULK_MESSAGES_MAX, SendBulkMessageDto } from '../message/dto/bulk-message.dto';
import { BatchMessageStatus, BatchStatus, MessageBatch } from '../message/entities/message-batch.entity';
import { CampaignService } from './campaign.service';
import { CAMPAIGN_AUDIENCE_MAX, CampaignDto } from './dto/campaign.dto';
import { Campaign } from './entities/campaign.entity';
import { CampaignRecipient } from './entities/campaign-recipient.entity';

/** How often the scheduler looks for due campaigns and for a `running` one with no driver. */
const SWEEP_INTERVAL_MS = 30_000;
/** How often the driver asks the bulk service whether the active chunk has finished. */
const BATCH_POLL_MS = 1_000;
/**
 * Let the bulk service's own bootstrap reaper finish before resuming: it turns batches left
 * `processing` by the previous process into terminal rows, which the resume then reads instead of
 * waiting on a batch nobody drives.
 */
const RESUME_DELAY_MS = 10_000;

function isTerminal(status: BatchStatus): boolean {
  return status === BatchStatus.COMPLETED || status === BatchStatus.CANCELLED || status === BatchStatus.FAILED;
}

/**
 * Drives a campaign from its recipient rows to WhatsApp.
 *
 * The runner is deliberately small and stateless across restarts: every decision is re-read from the
 * database, so a Passenger process that dies mid-campaign is resumed by the next one. Each chunk of
 * at most {@link BULK_MESSAGES_MAX} recipients becomes one ordinary bulk batch — pacing, moderation,
 * retry and per-message accounting stay in the path every other send already uses.
 *
 * A chunk's `batchId` is written to its recipients BEFORE the batch is created. On resume, the runner
 * asks those batches for their persisted results and marks those recipients from them, so only the
 * recipients a crash left genuinely unattempted are sent again.
 */
@Injectable()
export class CampaignRunnerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = createLogger('CampaignRunner');
  /** Campaign id → the in-process run driving it. A second start is a no-op while it is present. */
  private readonly drivers = new Map<string, Promise<void>>();
  /** Campaign id → the bulk batch currently in flight, so a cancel can stop it. */
  private readonly activeBatches = new Map<string, string>();
  /** Campaigns whose scheduled start already failed, to keep the sweeper from logging every 30 s. */
  private readonly reportedFailures = new Set<string>();
  private sweeper?: NodeJS.Timeout;
  private stopping = false;
  private batchSeq = 0;

  constructor(
    @InjectRepository(Campaign, 'data')
    private readonly campaigns: Repository<Campaign>,
    @InjectRepository(CampaignRecipient, 'data')
    private readonly recipients: Repository<CampaignRecipient>,
    private readonly campaignService: CampaignService,
    private readonly bulk: BulkMessageService,
    private readonly audit: AuditService,
    private readonly events: EventsGateway,
  ) {}

  onApplicationBootstrap(): void {
    // Not awaited: startup must not block on a campaign that may take minutes.
    setTimeout(() => {
      if (!this.stopping) void this.resumeRunning();
    }, RESUME_DELAY_MS).unref();

    this.sweeper = setInterval(() => void this.tick(), SWEEP_INTERVAL_MS);
    this.sweeper.unref();
  }

  onModuleDestroy(): void {
    // The campaign stays `running` and its recipients `pending`: the next process resumes it. Marking
    // it failed here would turn every routine restart into a lost broadcast.
    this.stopping = true;
    if (this.sweeper) clearInterval(this.sweeper);
  }

  /** Start a draft or scheduled campaign now. Idempotent while it is already running. */
  async start(sessionId: string, id: string, actor: ApiKey): Promise<CampaignDto> {
    const campaign = await this.campaignService.findOne(sessionId, id);
    if (campaign.status === 'running') return this.campaignService.toDto(campaign);
    if (campaign.status !== 'draft' && campaign.status !== 'scheduled') {
      throw new BadRequestException(`A ${campaign.status} campaign cannot be started`);
    }

    await this.begin(campaign);
    await this.audit.logInfo(AuditAction.CAMPAIGN_STARTED, {
      apiKey: actor,
      sessionId,
      metadata: { campaignId: campaign.id, name: campaign.name, total: campaign.progress.total },
    });
    return this.campaignService.toDto(campaign);
  }

  async cancel(sessionId: string, id: string, actor: ApiKey): Promise<CampaignDto> {
    const campaign = await this.campaignService.findOne(sessionId, id);
    if (campaign.status === 'cancelled') return this.campaignService.toDto(campaign);
    if (!['draft', 'scheduled', 'running'].includes(campaign.status)) {
      throw new BadRequestException(`A ${campaign.status} campaign cannot be cancelled`);
    }

    campaign.status = 'cancelled';
    campaign.completedAt = new Date();
    await this.campaigns.save(campaign);

    // Everything not attempted yet is skipped. Recipients already `sent`/`failed` keep their outcome:
    // a cancel stops the run, it does not rewrite what WhatsApp already accepted.
    await this.recipients.update(
      { campaignId: id, status: 'pending' },
      {
        status: 'skipped',
        errorCode: 'CAMPAIGN_CANCELLED',
        errorMessage: 'Campaign cancelled before this recipient was attempted',
      },
    );
    campaign.progress = await this.countProgress(id);
    await this.campaigns.save(campaign);

    const batchId = this.activeBatches.get(id);
    if (batchId) {
      await this.bulk.cancelBatch(sessionId, batchId).catch((error: unknown) => {
        // The batch may have reached a terminal status between the read and the cancel; that is the
        // outcome the driver will record, not a reason to fail the cancel request.
        this.logger.debug(`Could not cancel batch ${batchId} for campaign ${id}: ${String(error)}`);
      });
    }

    await this.audit.logInfo(AuditAction.CAMPAIGN_CANCELLED, {
      apiKey: actor,
      sessionId,
      metadata: { campaignId: id, name: campaign.name, progress: campaign.progress },
    });
    this.emit(campaign);
    return this.campaignService.toDto(campaign);
  }

  /**
   * Resolve the audience into recipient rows and move the campaign to `running`. The audience is
   * resolved BEFORE the status changes, so a failed resolution (a stopped session, a deleted segment)
   * leaves the campaign exactly as it was and the caller gets the real error.
   */
  private async begin(campaign: Campaign): Promise<void> {
    const { chats, truncated } = await this.campaignService.resolveAudience(campaign.sessionId, campaign.audience);
    if (truncated) {
      throw new BadRequestException(
        `The audience has more than ${CAMPAIGN_AUDIENCE_MAX} chats; split it into segments`,
      );
    }
    if (chats.length === 0) throw new BadRequestException('The audience resolves to no chats');

    await this.insertRecipients(campaign.id, chats);

    campaign.status = 'running';
    campaign.startedAt = new Date();
    campaign.completedAt = null;
    campaign.progress = await this.countProgress(campaign.id);
    await this.campaigns.save(campaign);
    this.reportedFailures.delete(campaign.id);

    this.emit(campaign);
    this.ensureDriving(campaign.id);
  }

  /** Add only chats that have no row yet; the unique constraint is the real guard against a double start. */
  private async insertRecipients(
    campaignId: string,
    chats: Array<{ chatId: string; chatName: string | null }>,
  ): Promise<void> {
    const rows = chats.map(chat =>
      this.recipients.create({
        campaignId,
        chatId: chat.chatId,
        chatName: chat.chatName,
        status: 'pending',
        batchId: null,
        messageId: null,
        errorCode: null,
        errorMessage: null,
        sentAt: null,
      }),
    );

    // `orIgnore` turns a duplicate (campaignId, chatId) into a no-op, so two concurrent starts — or a
    // resume racing a manual start — cannot fail each other with a unique violation.
    for (let i = 0; i < rows.length; i += 200) {
      await this.recipients
        .createQueryBuilder()
        .insert()
        .values(rows.slice(i, i + 200))
        .orIgnore()
        .execute();
    }
  }

  private ensureDriving(campaignId: string): void {
    if (this.drivers.has(campaignId) || this.stopping) return;
    const run = this.drive(campaignId)
      .catch((error: unknown) => {
        // Leave the campaign `running`: the sweeper retries, which is what makes a session that was
        // still starting when the campaign began recover on its own.
        this.logger.warn(`Campaign ${campaignId} paused: ${String(error)}`);
      })
      .finally(() => {
        this.drivers.delete(campaignId);
      });
    this.drivers.set(campaignId, run);
  }

  private async drive(campaignId: string): Promise<void> {
    const initial = await this.campaigns.findOne({ where: { id: campaignId } });
    if (!initial || initial.status !== 'running') return;

    await this.reconcile(initial);

    while (!this.stopping) {
      const campaign = await this.campaigns.findOne({ where: { id: campaignId } });
      if (!campaign || campaign.status !== 'running') return;

      const pending = await this.recipients.find({
        where: { campaignId, status: 'pending' },
        order: { createdAt: 'ASC' },
        take: BULK_MESSAGES_MAX,
      });
      if (pending.length === 0) {
        await this.finish(campaign);
        return;
      }

      const batchId = this.nextBatchId(campaignId, pending.length);
      await this.recipients.update({ id: In(pending.map(row => row.id)) }, { batchId });
      this.activeBatches.set(campaignId, batchId);

      try {
        await this.bulk.createBatch(campaign.sessionId, this.buildBatch(campaign, pending, batchId));
      } catch (error) {
        // The batch row was never created, so the recipients are still unattempted. Clear the marker
        // and leave them pending for the next sweep.
        this.activeBatches.delete(campaignId);
        await this.recipients.update({ id: In(pending.map(row => row.id)) }, { batchId: null });
        throw error;
      }

      const finished = await this.waitForBatch(campaign.sessionId, batchId, campaignId);
      this.activeBatches.delete(campaignId);
      if (!finished) return; // cancelled (or shutting down) mid-chunk

      await this.applyResults(pending, finished);

      const refreshed = await this.campaigns.findOne({ where: { id: campaignId } });
      if (!refreshed) return;
      refreshed.progress = await this.countProgress(campaignId);
      await this.campaigns.save(refreshed);
      this.emit(refreshed);

      if (finished.status === BatchStatus.FAILED && campaign.options.stopOnError) {
        await this.failRemaining(refreshed, 'Stopped on the first send error');
        return;
      }
    }
  }

  private buildBatch(campaign: Campaign, pending: CampaignRecipient[], batchId: string): SendBulkMessageDto {
    return {
      batchId,
      messages: pending.map(recipient => {
        // `name` and `chatId` are the only per-recipient values the runner knows, and both are safe
        // to expose to the template. A chat with no known name leaves `{{name}}` literal rather than
        // blanking it, which is how the shared renderer reports a missing variable.
        const variables: Record<string, string> = { chatId: recipient.chatId };
        if (recipient.chatName) variables.name = recipient.chatName;
        return {
          chatId: recipient.chatId,
          type: campaign.content.type,
          content: campaign.content.content,
          variables,
        };
      }),
      options: campaign.options,
    };
  }

  /**
   * Poll the batch until it reaches a terminal status. Returns null when the campaign was cancelled
   * (or the process is shutting down) and the batch was asked to stop.
   */
  private async waitForBatch(sessionId: string, batchId: string, campaignId: string): Promise<MessageBatch | null> {
    while (!this.stopping) {
      const batch = await this.bulk.getBatchStatus(sessionId, batchId).catch(() => null);
      if (!batch) return null;
      if (isTerminal(batch.status)) return batch;

      const campaign = await this.campaigns.findOne({ where: { id: campaignId }, select: { status: true } });
      if (!campaign || campaign.status !== 'running') {
        await this.bulk.cancelBatch(sessionId, batchId).catch(() => undefined);
        return null;
      }

      await delay(BATCH_POLL_MS);
    }
    return null;
  }

  /** Record one batch's outcomes on the recipients that were in it. */
  private async applyResults(pending: CampaignRecipient[], batch: MessageBatch): Promise<void> {
    const byChat = new Map(batch.results.map(result => [result.chatId, result]));

    for (const recipient of pending) {
      const result = byChat.get(recipient.chatId);

      if (result?.status === BatchMessageStatus.SENT) {
        recipient.status = 'sent';
        recipient.messageId = result.messageId ?? null;
        recipient.errorCode = null;
        recipient.errorMessage = null;
        recipient.sentAt = result.sentAt ?? new Date();
      } else if (result?.status === BatchMessageStatus.FAILED) {
        recipient.status = 'failed';
        recipient.errorCode = result.error?.code ?? 'SEND_FAILED';
        recipient.errorMessage = result.error?.message ?? 'The send failed';
      } else if (result?.status === BatchMessageStatus.CANCELLED) {
        recipient.status = 'skipped';
        recipient.errorCode = 'CAMPAIGN_CANCELLED';
        recipient.errorMessage = 'Campaign cancelled before this recipient was attempted';
      } else if (batch.status === BatchStatus.CANCELLED) {
        recipient.status = 'skipped';
        recipient.errorCode = 'CAMPAIGN_CANCELLED';
        recipient.errorMessage = 'Campaign cancelled before this recipient was attempted';
      } else if (batch.status === BatchStatus.FAILED) {
        // stopOnError leaves the rest of the chunk unattempted; the batch itself carries no error
        // field, so name the policy rather than inventing a provider message.
        recipient.status = 'skipped';
        recipient.errorCode = 'BATCH_STOPPED';
        recipient.errorMessage = 'The batch stopped before this recipient was attempted';
      } else {
        recipient.status = 'skipped';
        recipient.errorCode = 'BATCH_SKIPPED';
        recipient.errorMessage = 'The batch ended without attempting this recipient';
      }
    }

    await this.recipients.save(pending);
  }

  /**
   * Read the outcomes of batches a previous process left behind, so a crash does not resend what was
   * already delivered. Only terminal batches are applied; anything still processing is left to the
   * boot reaper, and its recipients stay pending until the sweep retries them.
   */
  private async reconcile(campaign: Campaign): Promise<void> {
    const rows = await this.recipients.find({
      where: { campaignId: campaign.id, status: 'pending' },
      select: { batchId: true },
    });
    const batchIds = [...new Set(rows.map(row => row.batchId).filter((id): id is string => Boolean(id)))];

    for (const batchId of batchIds) {
      const batch = await this.bulk.getBatchStatus(campaign.sessionId, batchId).catch(() => null);
      if (!batch) {
        await this.recipients.update({ campaignId: campaign.id, batchId, status: 'pending' }, { batchId: null });
        continue;
      }
      if (!isTerminal(batch.status)) continue;

      const pending = await this.recipients.find({
        where: { campaignId: campaign.id, batchId, status: 'pending' },
      });
      await this.applyResults(pending, batch);
    }

    campaign.progress = await this.countProgress(campaign.id);
    await this.campaigns.save(campaign);
  }

  /** All recipients reached a terminal status (or were cancelled). Decide the campaign's own outcome. */
  private async finish(campaign: Campaign): Promise<void> {
    const progress = await this.countProgress(campaign.id);
    campaign.progress = progress;
    campaign.completedAt = new Date();
    campaign.status = campaign.status === 'cancelled' ? 'cancelled' : 'completed';
    await this.campaigns.save(campaign);

    if (campaign.status === 'completed') {
      await this.audit.logInfo(AuditAction.CAMPAIGN_COMPLETED, {
        sessionId: campaign.sessionId,
        metadata: { campaignId: campaign.id, name: campaign.name, progress },
      });
    }
    this.emit(campaign);
  }

  /** stopOnError: mark everything still pending as skipped and fail the campaign. */
  private async failRemaining(campaign: Campaign, reason: string): Promise<void> {
    await this.recipients.update(
      { campaignId: campaign.id, status: 'pending' },
      { status: 'skipped', errorCode: 'BATCH_STOPPED', errorMessage: reason },
    );

    campaign.status = 'failed';
    campaign.completedAt = new Date();
    campaign.progress = await this.countProgress(campaign.id);
    await this.campaigns.save(campaign);
    this.emit(campaign);
  }

  private async countProgress(campaignId: string): Promise<Campaign['progress']> {
    const [total, sent, failed, skipped] = await Promise.all([
      this.recipients.count({ where: { campaignId } }),
      this.recipients.count({ where: { campaignId, status: 'sent' } }),
      this.recipients.count({ where: { campaignId, status: 'failed' } }),
      this.recipients.count({ where: { campaignId, status: 'skipped' } }),
    ]);
    return { total, sent, failed, skipped };
  }

  private nextBatchId(campaignId: string, size: number): string {
    // Compact and collision-free across restarts: the campaign prefix, a base-36 timestamp, an
    // in-process sequence and the chunk size. The bulk service scopes ids per session and rejects
    // duplicates, so a clock that steps backwards still cannot overwrite a batch.
    this.batchSeq += 1;
    return `cmp_${campaignId.slice(0, 8)}_${Date.now().toString(36)}_${this.batchSeq}_${size}`;
  }

  private emit(campaign: Campaign): void {
    this.events.emitCampaignUpdated(campaign.sessionId, {
      campaignId: campaign.id,
      status: campaign.status,
      progress: campaign.progress,
    });
  }

  private async resumeRunning(): Promise<void> {
    const running = await this.campaigns.find({ where: { status: 'running' }, take: 50 });
    for (const campaign of running) this.ensureDriving(campaign.id);
  }

  private async tick(): Promise<void> {
    if (this.stopping) return;
    try {
      const scheduled = await this.campaigns.find({ where: { status: 'scheduled' }, take: 50 });
      const now = Date.now();
      for (const campaign of scheduled) {
        if (!campaign.scheduledAt || campaign.scheduledAt.getTime() > now) continue;
        await this.startScheduled(campaign);
      }

      // A campaign may be `running` with no driver after a failed chunk (a session that was still
      // starting) or after this process took over from another one.
      const running = await this.campaigns.find({ where: { status: 'running' }, take: 50 });
      for (const campaign of running) this.ensureDriving(campaign.id);
    } catch (error) {
      this.logger.error(`Campaign sweep failed: ${String(error)}`);
    }
  }

  private async startScheduled(campaign: Campaign): Promise<void> {
    try {
      await this.begin(campaign);
      await this.audit.logInfo(AuditAction.CAMPAIGN_STARTED, {
        sessionId: campaign.sessionId,
        metadata: { campaignId: campaign.id, name: campaign.name, total: campaign.progress.total, scheduled: true },
      });
      this.reportedFailures.delete(campaign.id);
    } catch (error) {
      // The session may simply not be started yet. Leave the campaign `scheduled` so the next sweep
      // retries it, and report the first failure only.
      if (!this.reportedFailures.has(campaign.id)) {
        this.reportedFailures.add(campaign.id);
        this.logger.warn(`Scheduled campaign ${campaign.id} could not start yet: ${String(error)}`);
      }
    }
  }
}
