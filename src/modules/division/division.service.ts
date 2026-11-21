import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { AuditService } from '../audit/audit.service';
import { ApiKey } from '../auth/entities/api-key.entity';
import { Session } from '../session/entities/session.entity';
import { DIVISION_INBOX_PORT, type DivisionInboxPort } from './division-inbox.port';
import { normalizeKeyword } from './division-text';
import {
  CreateDivisionDto,
  DivisionDto,
  DivisionSettingsDto,
  MAX_DIVISIONS_PER_SESSION,
  UpdateDivisionDto,
  UpdateDivisionSettingsDto,
} from './dto/division.dto';
import { Division } from './entities/division.entity';
import { DivisionAgent } from './entities/division-agent.entity';
import { DIVISION_DEFAULT_IDLE_HOURS, DivisionSettings } from './entities/division-settings.entity';
import { DivisionChatState } from './entities/division-chat-state.entity';

/** A division as the router needs it: no timestamps, agents flattened to ids. */
export interface RoutableDivision {
  id: string;
  name: string;
  menuLabel: string;
  welcomeText: string | null;
  keywords: string[];
  sortOrder: number;
  slaMinutes: number;
  agentKeyIds: string[];
}

export interface DivisionRoutingContext {
  enabled: boolean;
  idleHours: number;
  menuHeader: string | null;
  invalidReply: string | null;
  divisions: RoutableDivision[];
}

/**
 * How long a routing context is reused. The router reads it on every inbound message; an operator
 * edit is visible within this window (the cache is also dropped immediately on every mutation).
 */
const CONTEXT_TTL_MS = 15_000;

/**
 * Division configuration: the menu, its membership, the per-session texts and the idle policy.
 *
 * Nothing here runs on the receive path — the router reads a cached {@link DivisionRoutingContext}
 * — so this service is free to do ordinary validation, audit and cache invalidation.
 *
 * `InboxService` is reached through {@link DIVISION_INBOX_PORT} resolved lazily: importing
 * `InboxModule` here would close `Inbox → Session → Division → Inbox`.
 */
@Injectable()
export class DivisionService {
  private readonly contexts = new Map<string, { expiresAt: number; value: DivisionRoutingContext }>();
  private readonly slaTargets = new Map<string, { expiresAt: number; value: Map<string, number> }>();
  private inboxPort?: DivisionInboxPort | null;

  constructor(
    @InjectRepository(Division, 'data')
    private readonly divisions: Repository<Division>,
    @InjectRepository(DivisionAgent, 'data')
    private readonly agents: Repository<DivisionAgent>,
    @InjectRepository(DivisionSettings, 'data')
    private readonly settingsRepository: Repository<DivisionSettings>,
    @InjectRepository(DivisionChatState, 'data')
    private readonly chatStates: Repository<DivisionChatState>,
    @InjectRepository(Session, 'data')
    private readonly sessions: Repository<Session>,
    @InjectRepository(ApiKey, 'main')
    private readonly apiKeys: Repository<ApiKey>,
    private readonly audit: AuditService,
    @Optional()
    private readonly moduleRef?: ModuleRef,
  ) {}

  async list(sessionId: string): Promise<DivisionDto[]> {
    const divisions = await this.divisions.find({
      where: { sessionId },
      order: { sortOrder: 'ASC', name: 'ASC' },
    });
    const agents = divisions.length
      ? await this.agents.find({
          where: { divisionId: In(divisions.map(division => division.id)) },
          order: { createdAt: 'ASC', apiKeyId: 'ASC' },
        })
      : [];

    const byDivision = new Map<string, DivisionAgent[]>();
    for (const agent of agents) {
      const bucket = byDivision.get(agent.divisionId);
      if (bucket) bucket.push(agent);
      else byDivision.set(agent.divisionId, [agent]);
    }
    return divisions.map(division => this.toView(division, byDivision.get(division.id) ?? []));
  }

  async create(sessionId: string, dto: CreateDivisionDto, actor?: ApiKey): Promise<DivisionDto> {
    await this.requireSession(sessionId);
    const name = dto.name.trim();
    if (await this.divisions.exists({ where: { sessionId, name } })) {
      throw new ConflictException(`A division named '${name}' already exists in this session`);
    }
    // Per-session cap: the menu has to stay readable and the router loads every division on each
    // message. A concurrent create can race the count — the cap bounds amplification, not an
    // invariant. Existing divisions above it are left alone.
    const existing = await this.divisions.count({ where: { sessionId } });
    if (existing >= MAX_DIVISIONS_PER_SESSION) {
      throw new BadRequestException(
        `Division limit reached for this session (${existing}/${MAX_DIVISIONS_PER_SESSION}); delete one before adding another`,
      );
    }

    // Validated before the write so a bad agent list cannot leave a half-configured division.
    const keys = (await this.resolveAgentKeys(dto.agentKeyIds ?? [])) ?? [];
    const division = await this.divisions.save(
      this.divisions.create({
        sessionId,
        name,
        keywords: this.normalizeKeywords(dto.keywords),
        menuLabel: this.trimOrNull(dto.menuLabel),
        welcomeText: this.trimOrNull(dto.welcomeText),
        sortOrder: dto.sortOrder ?? 0,
        slaMinutes: dto.slaMinutes ?? 0,
        isActive: dto.isActive ?? true,
      }),
    );
    const agents = await this.writeAgents(division.id, keys);

    await this.audit.logInfo(AuditAction.DIVISION_CREATED, {
      sessionId,
      apiKey: actor,
      metadata: { divisionId: division.id, name: division.name, agentCount: agents.length },
    });
    this.invalidate(sessionId);
    return this.toView(division, agents);
  }

  async update(sessionId: string, id: string, dto: UpdateDivisionDto, actor?: ApiKey): Promise<DivisionDto> {
    const division = await this.findOneOrFail(sessionId, id);
    const changed: string[] = [];

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (name !== division.name) {
        if (await this.divisions.exists({ where: { sessionId, name } })) {
          throw new ConflictException(`A division named '${name}' already exists in this session`);
        }
        division.name = name;
        changed.push('name');
      }
    }
    if (dto.keywords !== undefined) {
      division.keywords = this.normalizeKeywords(dto.keywords);
      changed.push('keywords');
    }
    if (dto.menuLabel !== undefined) {
      division.menuLabel = this.trimOrNull(dto.menuLabel);
      changed.push('menuLabel');
    }
    if (dto.welcomeText !== undefined) {
      division.welcomeText = this.trimOrNull(dto.welcomeText);
      changed.push('welcomeText');
    }
    if (dto.sortOrder !== undefined) {
      division.sortOrder = dto.sortOrder;
      changed.push('sortOrder');
    }
    if (dto.slaMinutes !== undefined) {
      division.slaMinutes = dto.slaMinutes;
      changed.push('slaMinutes');
    }
    if (dto.isActive !== undefined) {
      division.isActive = dto.isActive;
      changed.push('isActive');
    }

    const keys = dto.agentKeyIds === undefined ? undefined : await this.resolveAgentKeys(dto.agentKeyIds);
    if (changed.length > 0) await this.divisions.save(division);
    const agents =
      keys === undefined
        ? await this.agents.find({ where: { divisionId: id }, order: { createdAt: 'ASC', apiKeyId: 'ASC' } })
        : await this.writeAgents(id, keys);
    if (keys !== undefined) changed.push('agentKeyIds');

    await this.audit.logInfo(AuditAction.DIVISION_UPDATED, {
      sessionId,
      apiKey: actor,
      metadata: { divisionId: id, fields: changed },
    });
    this.invalidate(sessionId);
    return this.toView(division, agents);
  }

  /**
   * Deletes the division and drops its tag from the session's conversations. The assignee is kept
   * deliberately: deleting a division must not unassign live conversations from the CS answering
   * them. The chat state rows survive (FK SET NULL) and are re-prompted on the next message.
   */
  async remove(sessionId: string, id: string, actor?: ApiKey): Promise<void> {
    const division = await this.findOneOrFail(sessionId, id);
    await this.divisions.remove(division);
    await this.resolveInboxPort()?.clearDivision(sessionId, id);

    await this.audit.logInfo(AuditAction.DIVISION_DELETED, {
      sessionId,
      apiKey: actor,
      metadata: { divisionId: id, name: division.name },
    });
    this.invalidate(sessionId);
  }

  async getSettings(sessionId: string): Promise<DivisionSettingsDto> {
    const row = await this.settingsRepository.findOne({ where: { sessionId } });
    return this.toSettingsView(sessionId, row);
  }

  async updateSettings(
    sessionId: string,
    dto: UpdateDivisionSettingsDto,
    actor?: ApiKey,
  ): Promise<DivisionSettingsDto> {
    await this.requireSession(sessionId);
    const existing = await this.settingsRepository.findOne({ where: { sessionId } });
    const row =
      existing ??
      this.settingsRepository.create({
        sessionId,
        enabled: true,
        menuHeader: null,
        invalidReply: null,
        idleHours: DIVISION_DEFAULT_IDLE_HOURS,
      });

    if (dto.enabled !== undefined) row.enabled = dto.enabled;
    if (dto.menuHeader !== undefined) row.menuHeader = this.trimOrNull(dto.menuHeader);
    if (dto.invalidReply !== undefined) row.invalidReply = this.trimOrNull(dto.invalidReply);
    if (dto.idleHours !== undefined) row.idleHours = dto.idleHours;

    await this.settingsRepository.save(row);
    await this.audit.logInfo(AuditAction.DIVISION_SETTINGS_UPDATED, {
      sessionId,
      apiKey: actor,
      metadata: { enabled: row.enabled, idleHours: row.idleHours },
    });
    this.invalidate(sessionId);
    return this.toSettingsView(sessionId, row);
  }

  /** A division of this session, or null. Used by the inbox when an operator tags a chat by hand. */
  async lookup(sessionId: string, id: string): Promise<Division | null> {
    return this.divisions.findOne({ where: { id, sessionId } });
  }

  /** Called when a conversation is resolved: the next inbound message shows the menu again. */
  async rearm(sessionId: string, chatId: string): Promise<void> {
    await this.chatStates.update(
      { sessionId, chatId },
      // `menuDivisionIds` is cleared with the prompt: a number typed before the next menu is shown
      // must not resolve against a list the customer can no longer see.
      { status: 'awaiting', promptedAt: null, invalidReplyAt: null, routedAt: null, menuDivisionIds: null },
    );
  }

  /** The router's per-message read: one cache hit in the steady state. */
  async routingContext(sessionId: string): Promise<DivisionRoutingContext> {
    const cached = this.contexts.get(sessionId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const [settings, divisions] = await Promise.all([
      this.settingsRepository.findOne({ where: { sessionId } }),
      this.divisions.find({ where: { sessionId }, order: { sortOrder: 'ASC', name: 'ASC' } }),
    ]);
    const active = divisions.filter(division => division.isActive);
    const agents = active.length
      ? await this.agents.find({
          where: { divisionId: In(active.map(division => division.id)) },
          order: { createdAt: 'ASC', apiKeyId: 'ASC' },
        })
      : [];

    const agentIds = new Map<string, string[]>();
    for (const agent of agents) {
      const bucket = agentIds.get(agent.divisionId);
      if (bucket) bucket.push(agent.apiKeyId);
      else agentIds.set(agent.divisionId, [agent.apiKeyId]);
    }

    const value: DivisionRoutingContext = {
      enabled: settings?.enabled ?? true,
      idleHours: settings?.idleHours ?? DIVISION_DEFAULT_IDLE_HOURS,
      menuHeader: settings?.menuHeader ?? null,
      invalidReply: settings?.invalidReply ?? null,
      divisions: active.map(division => ({
        id: division.id,
        name: division.name,
        menuLabel: division.menuLabel?.trim() || division.name,
        welcomeText: division.welcomeText,
        keywords: division.keywords ?? [],
        sortOrder: division.sortOrder,
        slaMinutes: division.slaMinutes ?? 0,
        agentKeyIds: agentIds.get(division.id) ?? [],
      })),
    };
    this.contexts.set(sessionId, { expiresAt: Date.now() + CONTEXT_TTL_MS, value });
    return value;
  }

  /**
   * Division id → first-response target in minutes, for the SLA tracker.
   *
   * Divisions with no target are absent rather than mapped to 0, so a lookup miss and "this division
   * has no SLA" are the same check. Inactive divisions stay in the map: a chat already routed to one
   * keeps measuring against it until the router moves the chat elsewhere.
   *
   * Cached like {@link routingContext} and dropped by the same {@link invalidate}, because the
   * tracker reads it on every inbound message.
   */
  async slaMinutesByDivision(sessionId: string): Promise<Map<string, number>> {
    const cached = this.slaTargets.get(sessionId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const rows = await this.divisions.find({ where: { sessionId }, select: { id: true, slaMinutes: true } });
    const value = new Map<string, number>();
    for (const row of rows) {
      if (row.slaMinutes > 0) value.set(row.id, row.slaMinutes);
    }
    this.slaTargets.set(sessionId, { expiresAt: Date.now() + CONTEXT_TTL_MS, value });
    return value;
  }

  /** Drops the cached context after any write, so an edit takes effect on the next message. */
  invalidate(sessionId: string): void {
    this.contexts.delete(sessionId);
    this.slaTargets.delete(sessionId);
  }

  /**
   * Normalises one keyword: NFKC, lowercase, punctuation to spaces, collapsed. Matching compares
   * whole token sequences, so "smp-putra" and "SMP Putra" are the same keyword.
   */
  private normalizeKeywords(raw: string[] | undefined): string[] {
    const seen = new Set<string>();
    for (const keyword of raw ?? []) {
      const normalized = normalizeKeyword(keyword);
      if (!normalized) continue;
      // A bare number would be indistinguishable from a menu choice.
      if (/^\d+$/.test(normalized)) {
        throw new BadRequestException(
          `Keyword '${keyword}' must not be only digits; it collides with the menu numbering`,
        );
      }
      seen.add(normalized);
    }
    return [...seen];
  }

  private async findOneOrFail(sessionId: string, id: string): Promise<Division> {
    const division = await this.divisions.findOne({ where: { id, sessionId } });
    if (!division) throw new NotFoundException(`Division ${id} not found`);
    return division;
  }

  private async requireSession(sessionId: string): Promise<void> {
    if (!(await this.sessions.exists({ where: { id: sessionId } }))) {
      throw new NotFoundException(`Session with id '${sessionId}' not found`);
    }
  }

  private async resolveAgentKeys(apiKeyIds: string[] | undefined): Promise<ApiKey[] | undefined> {
    if (apiKeyIds === undefined) return undefined;
    if (apiKeyIds.length === 0) return [];
    const keys = await this.apiKeys.find({ where: { id: In(apiKeyIds) } });
    const byId = new Map(keys.map(key => [key.id, key]));
    const missing = apiKeyIds.filter(id => !byId.has(id));
    if (missing.length > 0) {
      throw new BadRequestException(`agentKeyIds must name existing API keys (unknown: ${missing.join(', ')})`);
    }
    const inactive = apiKeyIds.filter(id => !byId.get(id)!.isActive);
    if (inactive.length > 0) {
      throw new BadRequestException(`agentKeyIds must name active API keys (inactive: ${inactive.join(', ')})`);
    }
    return apiKeyIds.map(id => byId.get(id)!);
  }

  private async writeAgents(divisionId: string, keys: ApiKey[]): Promise<DivisionAgent[]> {
    await this.agents.delete({ divisionId });
    if (keys.length === 0) return [];
    return this.agents.save(keys.map(key => this.agents.create({ divisionId, apiKeyId: key.id, agentName: key.name })));
  }

  private toView(division: Division, agents: DivisionAgent[]): DivisionDto {
    return {
      id: division.id,
      sessionId: division.sessionId,
      name: division.name,
      keywords: division.keywords ?? [],
      menuLabel: division.menuLabel,
      welcomeText: division.welcomeText,
      sortOrder: division.sortOrder,
      slaMinutes: division.slaMinutes,
      isActive: division.isActive,
      agents: agents.map(agent => ({ apiKeyId: agent.apiKeyId, name: agent.agentName })),
      createdAt: division.createdAt,
      updatedAt: division.updatedAt,
    };
  }

  private toSettingsView(sessionId: string, row: DivisionSettings | null): DivisionSettingsDto {
    return {
      sessionId,
      enabled: row?.enabled ?? true,
      menuHeader: row?.menuHeader ?? null,
      invalidReply: row?.invalidReply ?? null,
      idleHours: row?.idleHours ?? DIVISION_DEFAULT_IDLE_HOURS,
    };
  }

  private trimOrNull(value: string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }

  private resolveInboxPort(): DivisionInboxPort | undefined {
    if (this.inboxPort === undefined) {
      try {
        this.inboxPort = this.moduleRef?.get<DivisionInboxPort>(DIVISION_INBOX_PORT, { strict: false }) ?? null;
      } catch {
        // Unit contexts have no ModuleRef (or no inbox module): the tag cleanup is then a no-op.
        this.inboxPort = null;
      }
    }
    return this.inboxPort ?? undefined;
  }
}
