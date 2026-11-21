import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import { createLogger } from '../../common/services/logger.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { AuditService } from '../audit/audit.service';
import { ApiKey } from '../auth/entities/api-key.entity';
import { LabelService } from '../label/label.service';
import { SessionService } from '../session/session.service';
import {
  CAMPAIGN_AUDIENCE_MAX,
  CampaignAudienceDto,
  CampaignContentDto,
  CampaignDetailDto,
  CampaignDto,
  CampaignOptionsDto,
  CampaignPreviewDto,
  CampaignPreviewResultDto,
  CampaignRecipientDto,
  CampaignSegmentDto,
  CreateCampaignDto,
  CreateCampaignSegmentDto,
  UpdateCampaignDto,
  UpdateCampaignSegmentDto,
} from './dto/campaign.dto';
import {
  Campaign,
  CampaignAudience,
  CampaignContent,
  CampaignOptions,
  CampaignStatus,
} from './entities/campaign.entity';
import { CampaignRecipient, CampaignRecipientStatus } from './entities/campaign-recipient.entity';
import { CampaignSegment } from './entities/campaign-segment.entity';

/** One resolved recipient, before it becomes a row. */
export interface ResolvedChat {
  chatId: string;
  chatName: string | null;
}

export interface ResolvedAudience {
  chats: ResolvedChat[];
  /** True when the source held more chats than {@link CAMPAIGN_AUDIENCE_MAX}. */
  truncated: boolean;
}

export const DEFAULT_CAMPAIGN_OPTIONS: CampaignOptions = {
  delayBetweenMessages: 3000,
  randomizeDelay: true,
  stopOnError: false,
};

/** Statuses a campaign may be edited in. Once it runs, its audience and content are history. */
const EDITABLE_STATUSES: CampaignStatus[] = ['draft', 'scheduled'];

/** Statuses a campaign may be deleted in. A completed run is a record and is kept. */
const DELETABLE_STATUSES: CampaignStatus[] = ['draft', 'cancelled'];

/**
 * Campaign storage, audience resolution and segment CRUD. Driving a campaign lives in
 * {@link CampaignRunnerService}; this service never sends, so the controller can answer a create
 * without waiting for an audience that may take seconds to resolve.
 */
@Injectable()
export class CampaignService {
  private readonly logger = createLogger('CampaignService');

  constructor(
    @InjectRepository(Campaign, 'data')
    private readonly campaigns: Repository<Campaign>,
    @InjectRepository(CampaignRecipient, 'data')
    private readonly recipients: Repository<CampaignRecipient>,
    @InjectRepository(CampaignSegment, 'data')
    private readonly segments: Repository<CampaignSegment>,
    private readonly sessionService: SessionService,
    private readonly labelService: LabelService,
    private readonly audit: AuditService,
  ) {}

  async list(
    sessionId: string,
    status: CampaignStatus | undefined,
    limit: number,
    offset: number,
  ): Promise<CampaignDto[]> {
    await this.sessionService.findOne(sessionId);
    const where: FindOptionsWhere<Campaign> = { sessionId };
    if (status) where.status = status;
    const rows = await this.campaigns.find({ where, order: { createdAt: 'DESC' }, skip: offset, take: limit });
    return rows.map(row => this.toDto(row));
  }

  async findOne(sessionId: string, id: string): Promise<Campaign> {
    const campaign = await this.campaigns.findOne({ where: { id, sessionId } });
    if (!campaign) throw new NotFoundException(`No campaign ${id} in session ${sessionId}`);
    return campaign;
  }

  async get(sessionId: string, id: string): Promise<CampaignDetailDto> {
    const campaign = await this.findOne(sessionId, id);
    const recipients = await this.recipients.find({
      where: { campaignId: id },
      order: { createdAt: 'ASC' },
      take: 50,
    });
    return { ...this.toDto(campaign), recipients: recipients.map(row => this.toRecipientDto(row)) };
  }

  async create(sessionId: string, dto: CreateCampaignDto, actor: ApiKey): Promise<CampaignDto> {
    await this.sessionService.findOne(sessionId);
    const content = this.normalizeContent(dto.content);
    const audience = this.normalizeAudience(dto.audience);
    const scheduledAt = this.toDate(dto.scheduledAt);

    const campaign = await this.campaigns.save(
      this.campaigns.create({
        sessionId,
        name: dto.name.trim(),
        status: scheduledAt ? 'scheduled' : 'draft',
        content,
        options: this.mergeOptions(dto.options),
        audience,
        progress: { total: 0, sent: 0, failed: 0, skipped: 0 },
        scheduledAt,
        startedAt: null,
        completedAt: null,
        createdByKeyId: actor.id,
        createdByName: actor.name,
      }),
    );

    this.logger.log(`Created campaign ${campaign.id} (${campaign.status}) for session ${sessionId}`);
    return this.toDto(campaign);
  }

  async update(sessionId: string, id: string, dto: UpdateCampaignDto): Promise<CampaignDto> {
    const campaign = await this.findOne(sessionId, id);
    if (!EDITABLE_STATUSES.includes(campaign.status)) {
      throw new BadRequestException(
        `A ${campaign.status} campaign cannot be edited; only drafts and scheduled ones can`,
      );
    }

    if (dto.name !== undefined) campaign.name = dto.name.trim();
    if (dto.content !== undefined) campaign.content = this.normalizeContent(dto.content);
    if (dto.options !== undefined) campaign.options = this.mergeOptions(dto.options);
    if (dto.audience !== undefined) campaign.audience = this.normalizeAudience(dto.audience);
    if (dto.scheduledAt !== undefined) {
      campaign.scheduledAt = this.toDate(dto.scheduledAt);
      // A scheduled campaign whose time is cleared goes back to draft, so the sweeper cannot start
      // it behind the operator's back.
      campaign.status = campaign.scheduledAt ? 'scheduled' : 'draft';
    }

    return this.toDto(await this.campaigns.save(campaign));
  }

  async remove(sessionId: string, id: string, actor: ApiKey): Promise<void> {
    const campaign = await this.findOne(sessionId, id);
    if (!DELETABLE_STATUSES.includes(campaign.status)) {
      throw new BadRequestException(
        `A ${campaign.status} campaign cannot be deleted; cancel it first, or keep the run as a record`,
      );
    }

    await this.campaigns.remove(campaign);
    await this.audit.logInfo(AuditAction.CAMPAIGN_DELETED, {
      apiKey: actor,
      sessionId,
      metadata: { campaignId: id, name: campaign.name, status: campaign.status },
    });
  }

  async listRecipients(
    sessionId: string,
    id: string,
    status: CampaignRecipientStatus | undefined,
    limit: number,
    offset: number,
  ): Promise<CampaignRecipientDto[]> {
    await this.findOne(sessionId, id);
    const where: FindOptionsWhere<CampaignRecipient> = { campaignId: id };
    if (status) where.status = status;
    const rows = await this.recipients.find({ where, order: { createdAt: 'ASC' }, skip: offset, take: limit });
    return rows.map(row => this.toRecipientDto(row));
  }

  async preview(sessionId: string, dto: CampaignPreviewDto): Promise<CampaignPreviewResultDto> {
    const { chats, truncated } = await this.resolveAudience(sessionId, dto.audience);
    const sampleSize = dto.sampleSize ?? 20;
    return {
      count: chats.length,
      sample: chats.slice(0, sampleSize).map(chat => ({ chatId: chat.chatId, chatName: chat.chatName })),
      truncated,
    };
  }

  /**
   * Turn an audience declaration into concrete chats.
   *
   * A manual audience is checked against the session's live chat list when that list is non-empty:
   * a typo in a JID is otherwise a valid-looking number that receives the broadcast. A session with
   * no chats yet is accepted as-is, because WhatsApp can start a conversation with a number that has
   * never appeared in the list.
   */
  async resolveAudience(sessionId: string, audience: CampaignAudienceDto): Promise<ResolvedAudience> {
    switch (audience.kind) {
      case 'manual': {
        const ids = unique(audience.chatIds ?? []);
        if (ids.length === 0) throw new BadRequestException('A manual audience needs at least one chatId');
        const known = await this.sessionChatMap(sessionId);
        if (known.size > 0) {
          const missing = ids.filter(chatId => !known.has(chatId));
          if (missing.length > 0) {
            throw new BadRequestException(
              `Not in this session's chat list: ${summarize(missing)}. ` +
                'Use POST /preview to see the chats the session knows about.',
            );
          }
        }
        return this.cap(ids.map(chatId => ({ chatId, chatName: known.get(chatId) ?? null })));
      }
      case 'segment': {
        if (!audience.segmentId) throw new BadRequestException('A segment audience needs segmentId');
        const segment = await this.findSegment(sessionId, audience.segmentId);
        const known = await this.sessionChatMap(sessionId);
        // A segment keeps its ids even after a chat leaves the account; skipping the unknown ones is
        // the only safe reading, since the alternative is a send that can never succeed.
        const chats = unique(segment.chatIds)
          .filter(chatId => known.size === 0 || known.has(chatId))
          .map(chatId => ({ chatId, chatName: known.get(chatId) ?? null }));
        if (chats.length === 0) throw new BadRequestException('The segment resolves to no chats in this session');
        return this.cap(chats);
      }
      case 'all': {
        const chats = await this.sessionService.listChats(sessionId);
        return this.cap(chats.map(chat => ({ chatId: chat.id, chatName: chat.name || null })));
      }
      case 'label': {
        if (!audience.labelId) throw new BadRequestException('A label audience needs labelId');
        // whatsapp-web.js only; Baileys answers 501 and the caller surfaces that unchanged.
        const chats = await this.labelService.getChatsByLabel(sessionId, audience.labelId);
        return this.cap(chats.map(chat => ({ chatId: chat.id, chatName: chat.name || null })));
      }
    }
  }

  async listSegments(sessionId: string): Promise<CampaignSegmentDto[]> {
    await this.sessionService.findOne(sessionId);
    const rows = await this.segments.find({ where: { sessionId }, order: { createdAt: 'DESC' } });
    return rows.map(row => this.toSegmentDto(row));
  }

  async createSegment(sessionId: string, dto: CreateCampaignSegmentDto): Promise<CampaignSegmentDto> {
    await this.sessionService.findOne(sessionId);
    const chatIds = unique(dto.chatIds);
    if (chatIds.length === 0) throw new BadRequestException('A segment needs at least one chatId');
    const segment = await this.segments.save(this.segments.create({ sessionId, name: dto.name.trim(), chatIds }));
    return this.toSegmentDto(segment);
  }

  async updateSegment(sessionId: string, id: string, dto: UpdateCampaignSegmentDto): Promise<CampaignSegmentDto> {
    const segment = await this.findSegment(sessionId, id);
    if (dto.name !== undefined) segment.name = dto.name.trim();
    if (dto.chatIds !== undefined) {
      const chatIds = unique(dto.chatIds);
      if (chatIds.length === 0) throw new BadRequestException('A segment needs at least one chatId');
      segment.chatIds = chatIds;
    }
    return this.toSegmentDto(await this.segments.save(segment));
  }

  async removeSegment(sessionId: string, id: string): Promise<void> {
    const segment = await this.findSegment(sessionId, id);
    await this.segments.remove(segment);
  }

  async findSegment(sessionId: string, id: string): Promise<CampaignSegment> {
    const segment = await this.segments.findOne({ where: { id, sessionId } });
    if (!segment) throw new NotFoundException(`No segment ${id} in session ${sessionId}`);
    return segment;
  }

  private async sessionChatMap(sessionId: string): Promise<Map<string, string | null>> {
    const chats = await this.sessionService.listChats(sessionId);
    return new Map(chats.map(chat => [chat.id, chat.name || null]));
  }

  /** Enforce the cap, and report whether anything was dropped so the caller can refuse a start. */
  private cap(chats: ResolvedChat[]): ResolvedAudience {
    const seen = new Set<string>();
    const deduped: ResolvedChat[] = [];
    for (const chat of chats) {
      if (seen.has(chat.chatId)) continue;
      seen.add(chat.chatId);
      deduped.push(chat);
    }
    return { chats: deduped.slice(0, CAMPAIGN_AUDIENCE_MAX), truncated: deduped.length > CAMPAIGN_AUDIENCE_MAX };
  }

  private normalizeContent(content: CampaignContentDto): CampaignContent {
    const body = content.content;
    if (content.type === 'text') {
      if (!body.text || body.text.trim() === '') {
        throw new BadRequestException('A text campaign needs content.text');
      }
    } else if (!body[content.type]) {
      throw new BadRequestException(`A ${content.type} campaign needs content.${content.type}`);
    }
    return { type: content.type, content: body };
  }

  /**
   * Keep only the field the chosen kind uses, so a stale `segmentId` left behind by a switch to
   * `manual` cannot be mistaken for part of the audience later.
   */
  private normalizeAudience(audience: CampaignAudienceDto | undefined): CampaignAudience {
    const kind = audience?.kind ?? 'manual';
    switch (kind) {
      case 'manual': {
        const chatIds = unique(audience?.chatIds ?? []);
        if (chatIds.length === 0) throw new BadRequestException('A manual audience needs at least one chatId');
        return { kind, chatIds };
      }
      case 'segment':
        if (!audience?.segmentId) throw new BadRequestException('A segment audience needs segmentId');
        return { kind, segmentId: audience.segmentId };
      case 'label':
        if (!audience?.labelId) throw new BadRequestException('A label audience needs labelId');
        return { kind, labelId: audience.labelId };
      case 'all':
        return { kind };
    }
  }

  private mergeOptions(options: CampaignOptionsDto | undefined): CampaignOptions {
    return {
      delayBetweenMessages: options?.delayBetweenMessages ?? DEFAULT_CAMPAIGN_OPTIONS.delayBetweenMessages,
      randomizeDelay: options?.randomizeDelay ?? DEFAULT_CAMPAIGN_OPTIONS.randomizeDelay,
      stopOnError: options?.stopOnError ?? DEFAULT_CAMPAIGN_OPTIONS.stopOnError,
    };
  }

  private toDate(value: string | null | undefined): Date | null {
    if (value === null || value === undefined) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  toDto(campaign: Campaign): CampaignDto {
    return {
      id: campaign.id,
      sessionId: campaign.sessionId,
      name: campaign.name,
      status: campaign.status,
      content: campaign.content,
      options: campaign.options,
      audience: campaign.audience,
      progress: campaign.progress,
      scheduledAt: campaign.scheduledAt ? campaign.scheduledAt.toISOString() : null,
      startedAt: campaign.startedAt ? campaign.startedAt.toISOString() : null,
      completedAt: campaign.completedAt ? campaign.completedAt.toISOString() : null,
      createdByKeyId: campaign.createdByKeyId,
      createdByName: campaign.createdByName,
      createdAt: campaign.createdAt.toISOString(),
      updatedAt: campaign.updatedAt.toISOString(),
    };
  }

  toRecipientDto(row: CampaignRecipient): CampaignRecipientDto {
    return {
      chatId: row.chatId,
      chatName: row.chatName,
      status: row.status,
      messageId: row.messageId,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      sentAt: row.sentAt ? row.sentAt.toISOString() : null,
    };
  }

  private toSegmentDto(segment: CampaignSegment): CampaignSegmentDto {
    return {
      id: segment.id,
      name: segment.name,
      chatIds: segment.chatIds,
      createdAt: segment.createdAt.toISOString(),
      updatedAt: segment.updatedAt.toISOString(),
    };
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function summarize(values: string[]): string {
  const shown = values.slice(0, 5).join(', ');
  return values.length > 5 ? `${shown} and ${values.length - 5} more` : shown;
}
