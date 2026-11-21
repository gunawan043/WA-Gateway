import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createLogger } from '../../common/services/logger.service';
import { getRequestActor } from '../../common/services/request-context';
import { startGuardedInterval } from '../../common/utils/guarded-interval';
import { HookManager } from '../../core/hooks';
import type { HookContext, HookResult } from '../../core/hooks';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { AuditService } from '../audit/audit.service';
import { DivisionService } from '../division/division.service';
import { EventsGateway } from '../events/events.gateway';
import { MessageDirection, MessageStatus } from '../message/entities/message.entity';
import { InboxConversation } from './entities/inbox-conversation.entity';
import { InboxService } from './inbox.service';

/** The subset of a persisted message this service reads. */
interface PersistedMessage {
  id?: string;
  chatId?: string;
  direction?: string;
  status?: string;
  timestamp?: number | null;
}

/** How often overdue windows are claimed. A minute is the resolution the badge promises. */
const SWEEP_INTERVAL_MS = 60_000;
/** Rows per sweep query, and how many batches one tick may process before yielding. */
const SWEEP_BATCH = 500;
const SWEEP_BATCHES = 3;
/** Emission ids remembered to swallow the repeats `message:persisted` produces for one row. */
const SEEN_LIMIT = 10_000;

/**
 * First-response SLA: starts and stops the clock on the message path, and flags overdue windows.
 *
 * Two inputs only, both from `message:persisted` (the single chokepoint every stored message passes
 * through):
 *
 * - **inbound** — the customer wrote, so a window opens (or restarts) at that message's timestamp;
 * - **human outbound, `sent`** — someone answered, so the window closes.
 *
 * "Human" is `getRequestActor()`: the API key that authenticated the HTTP request that sent the
 * message. Division menus, welcome texts, campaigns, automations and the phone's own echo have no
 * request actor and therefore never stop a clock — otherwise the gateway would answer for the team.
 * A server-side send made from inside an authenticated request does count, which is the intended
 * behaviour for a dashboard reply.
 *
 * `message:persisted` also fires for PENDING, FAILED, echo merges, edits and revokes, so every
 * emission is deduplicated on `id|direction|status` before it is considered.
 *
 * The sweeper runs in-process on every node; the claim is an atomic `UPDATE … WHERE slaBreachedAt IS
 * NULL`, so exactly one node emits the event and writes the audit row for a given breach.
 *
 * Everything here is best-effort: a failure is logged and swallowed. The receive and send paths must
 * never wait on, or fail because of, SLA bookkeeping.
 */
@Injectable()
export class InboxSlaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('InboxSlaService');
  private readonly seen = new Map<string, true>();
  private readonly chains = new Map<string, Promise<void>>();
  private stopSweep?: () => void;

  constructor(
    @InjectRepository(InboxConversation, 'data')
    private readonly conversations: Repository<InboxConversation>,
    private readonly inbox: InboxService,
    private readonly divisions: DivisionService,
    private readonly events: EventsGateway,
    private readonly audit: AuditService,
    private readonly hooks: HookManager,
  ) {}

  onModuleInit(): void {
    // Priority 90: after the built-in providers that must see the message first, before plugins that
    // only read it. The handler returns `continue: true` unconditionally — it never vetoes anything.
    this.hooks.register('inbox-sla', 'message:persisted', ctx => this.onPersisted(ctx), 90);
    this.stopSweep = startGuardedInterval(
      () => this.sweep(),
      SWEEP_INTERVAL_MS,
      error => this.logger.warn('SLA sweep failed', { error: this.describe(error) }),
    );
  }

  onModuleDestroy(): void {
    this.stopSweep?.();
  }

  private async onPersisted(ctx: HookContext<unknown>): Promise<HookResult> {
    try {
      const data = ctx.data as { sessionId?: unknown; message?: PersistedMessage } | undefined;
      const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : undefined;
      const message = data?.message;
      const chatId = typeof message?.chatId === 'string' ? message.chatId : undefined;
      if (!sessionId || !message || !chatId) return { continue: true };

      const key = `${message.id ?? `${chatId}|${message.timestamp ?? ''}`}|${message.direction ?? ''}|${message.status ?? ''}`;
      if (!this.remember(key)) return { continue: true };

      const at = this.messageTime(message);
      if (message.direction === MessageDirection.INCOMING) {
        await this.enqueue(sessionId, chatId, () => this.onInbound(sessionId, chatId, at));
      } else if (message.direction === MessageDirection.OUTGOING && message.status === MessageStatus.SENT) {
        if (getRequestActor()?.apiKeyId) {
          await this.enqueue(sessionId, chatId, () => this.onHumanReply(sessionId, chatId, at));
        }
      }
    } catch (error) {
      this.logger.warn('SLA bookkeeping failed', { error: this.describe(error) });
    }
    return { continue: true };
  }

  /** A customer message opens (or restarts) the window. */
  private async onInbound(sessionId: string, chatId: string, at: Date): Promise<void> {
    const row = await this.inbox.ensureConversation(sessionId, chatId);

    // A message on a resolved conversation reopens it. The inbox list performs the same
    // reconciliation on read; doing it here keeps the clock off a conversation nobody has looked at.
    // A message older than the resolution (a reconnect replay) is not new activity: it starts nothing.
    if (row.status === 'resolved') {
      if (row.resolvedAt && at.getTime() <= row.resolvedAt.getTime()) return;
      row.status = 'open';
      row.resolvedAt = null;
    }

    const target = row.divisionId
      ? ((await this.divisions.slaMinutesByDivision(sessionId)).get(row.divisionId) ?? null)
      : null;

    row.firstInboundAt ??= at;
    row.lastInboundAt = at;
    // Started even without a target: routing runs after this hook, and it fills in the deadline from
    // this same instant once the customer has picked a division.
    row.slaStartedAt = at;
    row.slaMinutes = target;
    row.slaDueAt = target !== null ? new Date(at.getTime() + target * 60_000) : null;
    // A fresh customer message is a fresh wait; the earlier breach stays in the audit log.
    row.slaBreachedAt = null;

    await this.conversations.save(row);
    // Only a window with a deadline is visible in the inbox; an untagged chat has no badge to update.
    if (target !== null) this.inbox.notifyChanged(row);
  }

  /** A human reply closes the window; the breach (if any) is kept for the reports. */
  private async onHumanReply(sessionId: string, chatId: string, at: Date): Promise<void> {
    const row = await this.conversations.findOne({ where: { sessionId, chatId } });
    if (!row) return;

    const hadClock = row.slaStartedAt !== null || row.slaDueAt !== null;
    row.firstResponseAt ??= at;
    row.slaStartedAt = null;
    row.slaDueAt = null;

    await this.conversations.save(row);
    if (hadClock) this.inbox.notifyChanged(row);
  }

  /** Claims and announces overdue windows. One node wins each row; the rest see `affected === 0`. */
  private async sweep(): Promise<void> {
    for (let batch = 0; batch < SWEEP_BATCHES; batch += 1) {
      const now = new Date();
      const overdue = await this.conversations
        .createQueryBuilder('conversation')
        .where('conversation.slaDueAt IS NOT NULL')
        .andWhere('conversation.slaDueAt <= :now', { now: now.toISOString() })
        .andWhere('conversation.slaBreachedAt IS NULL')
        .andWhere('conversation.status != :resolved', { resolved: 'resolved' })
        .orderBy('conversation.slaDueAt', 'ASC')
        .take(SWEEP_BATCH)
        .getMany();
      if (overdue.length === 0) return;

      for (const row of overdue) {
        const claimed = await this.conversations
          .createQueryBuilder()
          .update(InboxConversation)
          .set({ slaBreachedAt: now })
          .where('id = :id AND "slaBreachedAt" IS NULL', { id: row.id })
          .execute();
        if (claimed.affected !== 1) continue;

        this.events.emitInboxSlaBreached(row.sessionId, {
          chatId: row.chatId,
          divisionId: row.divisionId,
          divisionName: row.divisionName,
          assigneeKeyId: row.assigneeKeyId,
          assigneeName: row.assigneeName,
          slaMinutes: row.slaMinutes,
          slaStartedAt: row.slaStartedAt ? row.slaStartedAt.toISOString() : null,
          slaDueAt: row.slaDueAt ? row.slaDueAt.toISOString() : null,
          breachedAt: now.toISOString(),
        });
        await this.audit.logWarn(AuditAction.INBOX_SLA_BREACHED, {
          sessionId: row.sessionId,
          metadata: {
            chatId: row.chatId,
            divisionId: row.divisionId,
            divisionName: row.divisionName,
            assigneeKeyId: row.assigneeKeyId,
            slaMinutes: row.slaMinutes,
            slaDueAt: row.slaDueAt ? row.slaDueAt.toISOString() : null,
          },
        });
      }

      if (overdue.length < SWEEP_BATCH) return;
    }
  }

  /** Serialises work per chat so two messages arriving together cannot interleave their writes. */
  private enqueue(sessionId: string, chatId: string, task: () => Promise<void>): Promise<void> {
    const key = `${sessionId}|${chatId}`;
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(task, task).catch(error => {
      this.logger.warn('SLA clock update failed', { sessionId, chatId, error: this.describe(error) });
    });
    this.chains.set(key, next);
    void next.then(() => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    });
    return next;
  }

  /** True the first time this emission id is seen; keeps the map bounded as an insertion-ordered LRU. */
  private remember(key: string): boolean {
    if (this.seen.delete(key)) {
      this.seen.set(key, true);
      return false;
    }
    this.seen.set(key, true);
    if (this.seen.size > SEEN_LIMIT) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }

  private messageTime(message: PersistedMessage): Date {
    if (typeof message.timestamp === 'number' && message.timestamp > 0) {
      return new Date(message.timestamp * 1000);
    }
    return new Date();
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
