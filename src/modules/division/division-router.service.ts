import { Injectable, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createLogger } from '../../common/services/logger.service';
import { PLUGIN_MESSAGE_PORT, type PluginMessagePort } from '../../core/plugins/plugin-host-ports';
import { chatKind } from '../../engine/identity/wa-id';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { AuditService } from '../audit/audit.service';
import { DIVISION_INBOX_PORT, type DivisionInboxPort } from './division-inbox.port';
import { DivisionService, type DivisionRoutingContext, type RoutableDivision } from './division.service';
import { normalizeKeyword } from './division-text';
import { DivisionChatState } from './entities/division-chat-state.entity';

/**
 * Messages older than this never get a menu. A reconnect replays the offline backlog through the
 * same inbound path; answering it would burst-prompt every stale chat. Same value and reasoning as
 * the automation evaluator.
 */
const MAX_MESSAGE_AGE_SECONDS = 300;

/** A repeated `menu` request within this window does not send a second list. */
const MENU_REQUEST_COOLDOWN_MS = 3_000;

/** `lastInboundAt` is written at most this often: the idle rule needs hour precision. */
const TOUCH_WINDOW_MS = 60_000;

const MENU_CHOICE = /^0*([1-9]\d{0,2})$/;
const MENU_TRIGGERS = new Set(['menu', 'm', 'start', '0']);

export const DEFAULT_MENU_HEADER = 'Welcome! Please choose the team you need:';
export const DEFAULT_MENU_FOOTER = 'Reply with a number. Send "menu" at any time to see this list again.';
export const DEFAULT_INVALID_REPLY =
  'Sorry, I did not catch that. Please reply with a number from the list, or send "menu" to see it again.';

/**
 * Routes a customer who messages the shared number to the right division.
 *
 * Called fire-and-forget from the projector's dispatch stage, which runs at most once per inbound
 * message (the UNIQUE(sessionId, waMessageId) insert oracle), so nothing here sees an engine
 * re-fire. Everything must swallow its own failures: a broken division row, a dead database or a
 * refused send must never surface into the receive path.
 *
 * Return value: `true` means this message was handled (a menu, an invalid-reply hint or a routing
 * happened) and the automation rules must stay quiet, so the customer never gets a menu and an
 * auto-reply stacked. `false` means "nothing to say" and leaves the message to the other consumers.
 *
 * The menu is plain numbered text: the gateway has no interactive button/list send anywhere, and a
 * text menu works on every WhatsApp client.
 */
@Injectable()
export class DivisionRouterService {
  private readonly logger = createLogger('DivisionRouterService');
  private inboxPort?: DivisionInboxPort | null;
  private messagePort?: PluginMessagePort | null;

  constructor(
    @InjectRepository(DivisionChatState, 'data')
    private readonly states: Repository<DivisionChatState>,
    private readonly divisions: DivisionService,
    private readonly audit: AuditService,
    @Optional()
    private readonly moduleRef?: ModuleRef,
  ) {}

  async evaluateInbound(sessionId: string, message: Record<string, unknown>): Promise<boolean> {
    if (message.fromMe === true) return false;
    const chatId = typeof message.chatId === 'string' ? message.chatId : null;
    if (!chatId) return false;
    // Status posts, channels and broadcast lists are not conversations; groups are answered by a
    // human who already knows which division they are in.
    if (message.isGroup === true) return false;
    const kind = typeof message.kind === 'string' && message.kind ? message.kind : chatKind(chatId);
    if (kind !== 'individual') return false;

    const timestamp = typeof message.timestamp === 'number' ? message.timestamp : null;
    if (timestamp !== null && Date.now() / 1000 - timestamp > MAX_MESSAGE_AGE_SECONDS) return false;

    const context = await this.divisions.routingContext(sessionId);
    if (!context.enabled || context.divisions.length === 0) return false;

    const state = await this.states.findOne({ where: { sessionId, chatId } });
    const isText = message.type === 'text';
    const text = isText && typeof message.body === 'string' ? normalizeKeyword(message.body) : '';

    if (state?.status === 'routed') {
      const division = state.divisionId ? context.divisions.find(item => item.id === state.divisionId) : undefined;
      if (division && !this.idleExpired(state, context.idleHours)) {
        await this.touch(state);
        return false;
      }
      // The division was deleted, deactivated, or the customer has been away long enough: start over.
      return this.prompt(sessionId, chatId, context, 0);
    }

    if (isText) {
      const choice = this.parseChoice(text, state, context);
      if (choice) return this.route(sessionId, chatId, choice);

      if (MENU_TRIGGERS.has(text)) return this.prompt(sessionId, chatId, context, MENU_REQUEST_COOLDOWN_MS);

      const match = this.matchKeyword(text, context.divisions);
      if (match) return this.route(sessionId, chatId, match);
    }

    // Already shown a menu: answer a wrong text once per prompt, otherwise stay quiet. A sticker or
    // an image gets no hint — the customer may simply be opening the conversation.
    if (state?.status === 'awaiting' && state.promptedAt) {
      if (!isText) return false;
      const hinted = state.invalidReplyAt && state.invalidReplyAt >= state.promptedAt;
      if (hinted) return false;
      await this.states.update({ id: state.id }, { invalidReplyAt: new Date() });
      await this.send(sessionId, chatId, context.invalidReply?.trim() || DEFAULT_INVALID_REPLY);
      return true;
    }

    return this.prompt(sessionId, chatId, context, 0);
  }

  /** The division a numeric reply names, resolved against the list the customer actually saw. */
  private parseChoice(
    text: string,
    state: DivisionChatState | null,
    context: DivisionRoutingContext,
  ): RoutableDivision | null {
    const match = MENU_CHOICE.exec(text);
    if (!match) return null;
    const ids = state?.menuDivisionIds ?? [];
    const id = ids[Number.parseInt(match[1], 10) - 1];
    if (!id) return null;
    return context.divisions.find(division => division.id === id) ?? null;
  }

  /**
   * Whole-token keyword match. The longest keyword wins (so "smp putra" beats "smp"), and a tie is
   * broken by menu order and then name, which is the order the operator can reason about.
   */
  private matchKeyword(text: string, divisions: RoutableDivision[]): RoutableDivision | null {
    if (!text) return null;
    const padded = ` ${text} `;
    let best: { division: RoutableDivision; length: number } | null = null;

    for (const division of divisions) {
      for (const keyword of division.keywords) {
        if (!keyword || !padded.includes(` ${keyword} `)) continue;
        const length = [...keyword].length;
        if (
          !best ||
          length > best.length ||
          (length === best.length &&
            (division.sortOrder < best.division.sortOrder ||
              (division.sortOrder === best.division.sortOrder && division.name < best.division.name)))
        ) {
          best = { division, length };
        }
      }
    }
    return best?.division ?? null;
  }

  private async route(sessionId: string, chatId: string, division: RoutableDivision): Promise<boolean> {
    const now = new Date();
    await this.ensureRow(sessionId, chatId);
    await this.states.update(
      { sessionId, chatId },
      {
        status: 'routed',
        divisionId: division.id,
        routedAt: now,
        lastInboundAt: now,
        promptedAt: null,
        invalidReplyAt: null,
        menuDivisionIds: null,
      },
    );

    const assignee = await this.resolveInboxPort()?.routeConversation({
      sessionId,
      chatId,
      divisionId: division.id,
      divisionName: division.name,
      slaMinutes: division.slaMinutes,
      agentKeyIds: division.agentKeyIds,
    });
    await this.audit.logInfo(AuditAction.DIVISION_ROUTED, {
      sessionId,
      metadata: {
        chatId,
        divisionId: division.id,
        divisionName: division.name,
        assigneeKeyId: assignee?.assigneeKeyId ?? null,
      },
    });

    const text =
      division.welcomeText?.trim() || `You are now connected to ${division.name}. Please tell us what you need.`;
    await this.send(sessionId, chatId, text);
    return true;
  }

  /**
   * Sends the numbered menu. The claim below is what keeps two messages that arrive together from
   * producing two menus: the row is inserted if missing, then a conditional UPDATE marks it
   * prompted, and only the caller whose UPDATE affected a row sends.
   */
  private async prompt(
    sessionId: string,
    chatId: string,
    context: DivisionRoutingContext,
    cooldownMs: number,
  ): Promise<boolean> {
    await this.ensureRow(sessionId, chatId);
    const now = new Date();
    const menuDivisionIds = context.divisions.map(division => division.id);
    // The comparison is a bound string, not a Date: SQLite stores ISO text and PostgreSQL casts the
    // same literal, so both dialects compare against what the transformer actually wrote.
    const rearmBefore = new Date(now.getTime() - cooldownMs).toISOString();

    const claimed = await this.states
      .createQueryBuilder()
      .update(DivisionChatState)
      .set({
        promptedAt: now,
        status: 'awaiting',
        divisionId: null,
        routedAt: null,
        invalidReplyAt: null,
        menuDivisionIds,
      })
      .where('"sessionId" = :sessionId AND "chatId" = :chatId', { sessionId, chatId })
      .andWhere('("promptedAt" IS NULL OR "promptedAt" <= :rearmBefore)', { rearmBefore })
      .execute();
    if (!claimed.affected) return false;

    try {
      await this.send(sessionId, chatId, this.menuText(context));
      return true;
    } catch (error) {
      // Release the claim so the next message retries, and let automation answer this one.
      await this.states.update({ sessionId, chatId }, { promptedAt: null }).catch(() => undefined);
      this.logger.warn('Division menu could not be sent', {
        sessionId,
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private menuText(context: DivisionRoutingContext): string {
    const header = context.menuHeader?.trim() || DEFAULT_MENU_HEADER;
    const items = context.divisions.map((division, index) => `${index + 1}. ${division.menuLabel}`);
    return [header, '', ...items, '', DEFAULT_MENU_FOOTER].join('\n');
  }

  private idleExpired(state: DivisionChatState, idleHours: number): boolean {
    if (idleHours <= 0) return false;
    const since = state.lastInboundAt ?? state.routedAt;
    if (!since) return false;
    return Date.now() - since.getTime() > idleHours * 3_600_000;
  }

  private async touch(state: DivisionChatState): Promise<void> {
    const now = new Date();
    if (state.lastInboundAt && now.getTime() - state.lastInboundAt.getTime() < TOUCH_WINDOW_MS) return;
    await this.states.update({ id: state.id }, { lastInboundAt: now }).catch(() => undefined);
  }

  /** The unique `(sessionId, chatId)` index makes this safe under two messages at once. */
  private async ensureRow(sessionId: string, chatId: string): Promise<void> {
    await this.states
      .createQueryBuilder()
      .insert()
      .into(DivisionChatState)
      .values({ sessionId, chatId, status: 'awaiting' })
      .orIgnore()
      .execute();
  }

  private async send(sessionId: string, chatId: string, text: string): Promise<void> {
    const port = this.resolveMessagePort();
    if (!port) return;
    await port.sendText(sessionId, { chatId, text });
  }

  private resolveMessagePort(): PluginMessagePort | undefined {
    if (this.messagePort === undefined) {
      try {
        // Resolved lazily: a static import of MessageService closes the file cycle
        // session (projector) -> division -> message -> session.
        this.messagePort = this.moduleRef?.get<PluginMessagePort>(PLUGIN_MESSAGE_PORT, { strict: false }) ?? null;
      } catch (error) {
        this.logger.warn('MessageService is not resolvable; division menus are disabled', {
          error: error instanceof Error ? error.message : String(error),
        });
        this.messagePort = null;
      }
    }
    return this.messagePort ?? undefined;
  }

  private resolveInboxPort(): DivisionInboxPort | undefined {
    if (this.inboxPort === undefined) {
      try {
        this.inboxPort = this.moduleRef?.get<DivisionInboxPort>(DIVISION_INBOX_PORT, { strict: false }) ?? null;
      } catch {
        this.inboxPort = null;
      }
    }
    return this.inboxPort ?? undefined;
  }
}
