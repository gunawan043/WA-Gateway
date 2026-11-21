import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { ApiKey } from '../auth/entities/api-key.entity';
import {
  AddCrmActivityDto,
  CreateCrmDealDto,
  CrmActivityDto,
  CrmBoardDto,
  CrmDealDetailDto,
  CrmDealDto,
  CrmStageDto,
  UpdateCrmDealDto,
  UpdateCrmStageDto,
} from './dto/crm.dto';
import { CrmDealActivity, CrmActivityKind } from './entities/crm-deal-activity.entity';
import { CrmDeal, CrmDealStatus } from './entities/crm-deal.entity';
import { CrmStage } from './entities/crm-stage.entity';

export interface CrmDealFilters {
  status?: CrmDealStatus;
  stageId?: string;
  /** `me`, `unassigned`, or an API key id. */
  assignee?: string;
  q?: string;
}

/**
 * A single-company sales pipeline.
 *
 * Stages are the pipeline and are seeded by the migration with fixed ids; there is no pipeline or
 * stage-create API. A deal's `status` is never stored independently of its stage — it is recomputed
 * from `stage.kind` on every move, so the board, the status filter and the closed timestamp cannot
 * disagree.
 *
 * `sessionId`/`chatId` on a deal are provenance, not ownership: they carry no foreign key, so
 * deleting a WhatsApp session leaves the deal and its history intact.
 */
@Injectable()
export class CrmService {
  constructor(
    @InjectRepository(CrmStage, 'data')
    private readonly stages: Repository<CrmStage>,
    @InjectRepository(CrmDeal, 'data')
    private readonly deals: Repository<CrmDeal>,
    @InjectRepository(CrmDealActivity, 'data')
    private readonly activities: Repository<CrmDealActivity>,
    @InjectRepository(ApiKey, 'main')
    private readonly apiKeys: Repository<ApiKey>,
    private readonly audit: AuditService,
  ) {}

  async listStages(): Promise<CrmStageDto[]> {
    const stages = await this.stages.find({ order: { position: 'ASC', createdAt: 'ASC' } });
    return stages.map(stage => this.toStageDto(stage));
  }

  /** The whole pipeline in stage order, with the header counts the board renders. */
  async board(): Promise<CrmBoardDto> {
    const [stages, deals] = await Promise.all([
      this.stages.find({ order: { position: 'ASC', createdAt: 'ASC' } }),
      this.deals.find({ order: { updatedAt: 'DESC' } }),
    ]);

    const byStage = new Map<string, CrmDealDto[]>();
    for (const stage of stages) byStage.set(stage.id, []);
    for (const deal of deals) byStage.get(deal.stageId)?.push(this.toDealDto(deal));

    return {
      columns: stages.map(stage => ({ stage: this.toStageDto(stage), deals: byStage.get(stage.id) ?? [] })),
      open: deals.filter(deal => deal.status === 'open').length,
      won: deals.filter(deal => deal.status === 'won').length,
      lost: deals.filter(deal => deal.status === 'lost').length,
      // Mixed currencies are summed as-is: the figure is a rough pipeline indicator, not an
      // accounting total, and the dashboard labels it that way.
      openValue: deals.filter(deal => deal.status === 'open').reduce((sum, deal) => sum + (deal.value ?? 0), 0),
    };
  }

  /**
   * Deals matching the filters, newest activity first, paged in SQL. The `q` search covers the
   * title and the notes body; `%`/`_` in the term are escaped so a literal percent sign does not
   * turn into a wildcard.
   */
  async listDeals(filters: CrmDealFilters = {}, limit = 50, offset = 0, viewerKeyId?: string): Promise<CrmDealDto[]> {
    const qb = this.deals.createQueryBuilder('deal').orderBy('deal.updatedAt', 'DESC');

    if (filters.status) qb.andWhere('deal.status = :status', { status: filters.status });
    if (filters.stageId) qb.andWhere('deal.stageId = :stageId', { stageId: filters.stageId });

    const assignee = this.resolveAssigneeFilter(filters.assignee, viewerKeyId);
    if (assignee === null) qb.andWhere('deal.assigneeKeyId IS NULL');
    else if (assignee !== undefined) qb.andWhere('deal.assigneeKeyId = :assignee', { assignee });

    if (filters.q?.trim()) {
      qb.andWhere("(LOWER(deal.title) LIKE :q ESCAPE '\\' OR LOWER(COALESCE(deal.notes, '')) LIKE :q ESCAPE '\\')", {
        q: `%${this.escapeLike(filters.q.trim().toLowerCase())}%`,
      });
    }

    qb.skip(offset).take(limit);
    return (await qb.getMany()).map(deal => this.toDealDto(deal));
  }

  async get(id: string): Promise<CrmDealDetailDto> {
    const deal = await this.findDeal(id);
    const activities = await this.activities.find({ where: { dealId: id }, order: { createdAt: 'ASC' } });
    return { ...this.toDealDto(deal), activities: activities.map(activity => this.toActivityDto(activity)) };
  }

  async create(dto: CreateCrmDealDto, actor: ApiKey): Promise<CrmDealDetailDto> {
    const stage = await this.resolveStage(dto.stageId);
    const assignee = await this.resolveAssignee(dto.assigneeKeyId ?? null);

    const deal = await this.deals.save(
      this.deals.create({
        stageId: stage.id,
        title: dto.title.trim(),
        sessionId: dto.sessionId ?? null,
        chatId: dto.chatId ?? null,
        value: dto.value ?? null,
        currency: (dto.currency ?? 'IDR').toUpperCase(),
        status: this.statusFor(stage),
        assigneeKeyId: assignee?.id ?? null,
        assigneeName: assignee?.name ?? null,
        expectedCloseAt: this.toDate(dto.expectedCloseAt),
        closedAt: stage.kind === 'open' ? null : new Date(),
        notes: dto.notes ?? null,
      }),
    );

    await this.record(deal.id, 'created', actor, { body: `Deal created in ${stage.name}` });
    await this.audit.logInfo(AuditAction.CRM_DEAL_CREATED, {
      apiKey: actor,
      sessionId: deal.sessionId ?? undefined,
      metadata: { dealId: deal.id, title: deal.title, stageId: stage.id, value: deal.value, currency: deal.currency },
    });

    return this.get(deal.id);
  }

  async update(id: string, dto: UpdateCrmDealDto, actor: ApiKey): Promise<CrmDealDetailDto> {
    const deal = await this.findDeal(id);
    const previousStageId = deal.stageId;
    const changed: string[] = [];

    if (dto.stageId !== undefined && dto.stageId !== deal.stageId) {
      const stage = await this.resolveStage(dto.stageId);
      deal.stageId = stage.id;
      deal.status = this.statusFor(stage);
      if (deal.status === 'open') deal.closedAt = null;
      else if (!deal.closedAt) deal.closedAt = new Date();
      await this.record(id, 'stage_change', actor, { fromStageId: previousStageId, toStageId: stage.id });
      await this.audit.logInfo(AuditAction.CRM_DEAL_STAGE_CHANGED, {
        apiKey: actor,
        sessionId: deal.sessionId ?? undefined,
        metadata: { dealId: id, from: previousStageId, to: stage.id, status: deal.status },
      });
    }

    if (dto.assigneeKeyId !== undefined && dto.assigneeKeyId !== deal.assigneeKeyId) {
      const assignee = await this.resolveAssignee(dto.assigneeKeyId);
      deal.assigneeKeyId = assignee?.id ?? null;
      deal.assigneeName = assignee?.name ?? null;
      await this.record(id, 'assignment', actor, { body: assignee ? `Assigned to ${assignee.name}` : 'Unassigned' });
    }

    if (dto.title !== undefined && dto.title.trim() !== deal.title) {
      deal.title = dto.title.trim();
      changed.push('title');
    }
    if (dto.value !== undefined && dto.value !== deal.value) {
      deal.value = dto.value;
      changed.push('value');
    }
    if (dto.currency !== undefined && dto.currency.toUpperCase() !== deal.currency) {
      deal.currency = dto.currency.toUpperCase();
      changed.push('currency');
    }
    if (dto.expectedCloseAt !== undefined) {
      const next = this.toDate(dto.expectedCloseAt);
      const same = next?.getTime() === deal.expectedCloseAt?.getTime();
      if (!same) {
        deal.expectedCloseAt = next;
        changed.push('expectedCloseAt');
      }
    }
    if (dto.notes !== undefined && dto.notes !== deal.notes) {
      deal.notes = dto.notes;
      changed.push('notes');
    }

    if (changed.length > 0) await this.record(id, 'update', actor, { body: changed.join(', ') });

    await this.deals.save(deal);
    return this.get(id);
  }

  async remove(id: string, actor: ApiKey): Promise<void> {
    const deal = await this.findDeal(id);
    await this.deals.remove(deal);
    await this.audit.logInfo(AuditAction.CRM_DEAL_DELETED, {
      apiKey: actor,
      sessionId: deal.sessionId ?? undefined,
      metadata: { dealId: id, title: deal.title, stageId: deal.stageId, status: deal.status },
    });
  }

  async addActivity(id: string, dto: AddCrmActivityDto, actor: ApiKey): Promise<CrmActivityDto> {
    await this.findDeal(id);
    return this.toActivityDto(await this.record(id, 'note', actor, { body: dto.body }));
  }

  /**
   * Rename, reorder or recolour a stage. `kind` is deliberately not editable: it decides whether a
   * deal sitting here is open, won or lost, and changing it under existing deals would silently
   * rewrite their status without a stage-change entry in their history.
   */
  async updateStage(id: string, dto: UpdateCrmStageDto): Promise<CrmStageDto> {
    const stage = await this.stages.findOne({ where: { id } });
    if (!stage) throw new NotFoundException(`No stage ${id}`);

    if (dto.name !== undefined) stage.name = dto.name.trim();
    if (dto.position !== undefined) stage.position = dto.position;
    if (dto.color !== undefined) stage.color = dto.color;

    return this.toStageDto(await this.stages.save(stage));
  }

  private async findDeal(id: string): Promise<CrmDeal> {
    const deal = await this.deals.findOne({ where: { id } });
    if (!deal) throw new NotFoundException(`No deal ${id}`);
    return deal;
  }

  /** The named stage, or the first stage when omitted. Refuses when the pipeline has no stages. */
  private async resolveStage(stageId?: string): Promise<CrmStage> {
    if (stageId) {
      const stage = await this.stages.findOne({ where: { id: stageId } });
      if (!stage) throw new BadRequestException('stageId does not name a pipeline stage');
      return stage;
    }

    const [first] = await this.stages.find({ order: { position: 'ASC', createdAt: 'ASC' }, take: 1 });
    if (!first) throw new BadRequestException('No pipeline stages are configured');
    return first;
  }

  private async resolveAssignee(assigneeKeyId: string | null): Promise<ApiKey | null> {
    if (assigneeKeyId === null) return null;
    const key = await this.apiKeys.findOne({ where: { id: assigneeKeyId } });
    if (!key || !key.isActive) throw new BadRequestException('assigneeKeyId does not name an active API key');
    return key;
  }

  private statusFor(stage: CrmStage): CrmDealStatus {
    return stage.kind;
  }

  private toDate(value: string | null | undefined): Date | null {
    if (value === null || value === undefined) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  /** `undefined` = no filter, `null` = unassigned only, string = that key id. */
  private resolveAssigneeFilter(assignee: string | undefined, viewerKeyId?: string): string | null | undefined {
    if (!assignee || assignee === 'all') return undefined;
    if (assignee === 'unassigned') return null;
    if (assignee === 'me') return viewerKeyId ?? null;
    return assignee;
  }

  private escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, match => `\\${match}`);
  }

  private async record(
    dealId: string,
    kind: CrmActivityKind,
    actor: ApiKey,
    extra: { body?: string | null; fromStageId?: string | null; toStageId?: string | null } = {},
  ): Promise<CrmDealActivity> {
    return this.activities.save(
      this.activities.create({
        dealId,
        kind,
        body: extra.body ?? null,
        fromStageId: extra.fromStageId ?? null,
        toStageId: extra.toStageId ?? null,
        authorKeyId: actor.id,
        authorName: actor.name,
      }),
    );
  }

  private toStageDto(stage: CrmStage): CrmStageDto {
    return {
      id: stage.id,
      name: stage.name,
      kind: stage.kind,
      position: stage.position,
      color: stage.color,
    };
  }

  private toDealDto(deal: CrmDeal): CrmDealDto {
    return {
      id: deal.id,
      stageId: deal.stageId,
      title: deal.title,
      sessionId: deal.sessionId,
      chatId: deal.chatId,
      value: deal.value,
      currency: deal.currency,
      status: deal.status,
      assigneeKeyId: deal.assigneeKeyId,
      assigneeName: deal.assigneeName,
      expectedCloseAt: deal.expectedCloseAt ? deal.expectedCloseAt.toISOString() : null,
      closedAt: deal.closedAt ? deal.closedAt.toISOString() : null,
      notes: deal.notes,
      createdAt: deal.createdAt.toISOString(),
      updatedAt: deal.updatedAt.toISOString(),
    };
  }

  private toActivityDto(activity: CrmDealActivity): CrmActivityDto {
    return {
      id: activity.id,
      kind: activity.kind,
      body: activity.body,
      fromStageId: activity.fromStageId,
      toStageId: activity.toStageId,
      authorKeyId: activity.authorKeyId,
      authorName: activity.authorName,
      createdAt: activity.createdAt.toISOString(),
    };
  }
}
