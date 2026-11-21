import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { AuditService } from '../audit/audit.service';
import { ApiKey } from '../auth/entities/api-key.entity';
import { ChatSummary } from '../../engine/interfaces/whatsapp-engine.interface';
import { EventsGateway } from '../events/events.gateway';
import { SessionService } from '../session/session.service';
import { InboxConversation, InboxConversationStatus } from './entities/inbox-conversation.entity';
import { InboxNote } from './entities/inbox-note.entity';
import {
  InboxConversationDetailDto,
  InboxConversationDto,
  InboxNoteDto,
  InboxSummaryDto,
  UpdateInboxConversationDto,
} from './dto/inbox.dto';

export interface InboxListFilters {
  status?: InboxConversationStatus;
  /** `me`, `unassigned`, or an API key id. */
  assignee?: string;
  q?: string;
}

/**
 * Team inbox over the engine's chat list.
 *
 * There is no chat table in this gateway: a chat is `(sessionId, chatId)` and its name, unread count
 * and last message live in the engine. This service therefore joins the engine list with the small
 * `inbox_conversations` table at read time. A chat without a row is implicitly `open` and
 * unassigned, so reads never write and a fresh deployment needs no backfill.
 *
 * The one write on a read path is the reopen reconciliation: a resolved conversation whose chat has
 * seen activity since `resolvedAt` is flipped back to `open`. It touches only rows that were
 * resolved and then received something, so it stays bounded.
 */
@Injectable()
export class InboxService {
  constructor(
    @InjectRepository(InboxConversation, 'data')
    private readonly conversations: Repository<InboxConversation>,
    @InjectRepository(InboxNote, 'data')
    private readonly notes: Repository<InboxNote>,
    @InjectRepository(ApiKey, 'main')
    private readonly apiKeys: Repository<ApiKey>,
    private readonly sessionService: SessionService,
    private readonly audit: AuditService,
    private readonly events: EventsGateway,
  ) {}

  /**
   * Every chat in the session as an inbox row, newest activity first, before chat-scope filtering
   * and pagination. The controller owns both so a restricted key filters BEFORE paging.
   */
  async listAll(
    sessionId: string,
    filters: InboxListFilters = {},
    viewerKeyId?: string,
  ): Promise<InboxConversationDto[]> {
    const chats = await this.sessionService.listChats(sessionId);
    const rows = await this.conversations.find({ where: { sessionId } });
    const byChat = new Map(rows.map(row => [row.chatId, row]));

    await this.reopenActiveConversations(chats, byChat);

    const query = filters.q?.trim().toLowerCase();
    const wantedAssignee = this.resolveAssigneeFilter(filters.assignee, viewerKeyId);

    return chats
      .map(chat => this.toView(chat, byChat.get(chat.id)))
      .filter(view => !filters.status || view.status === filters.status)
      .filter(view => {
        if (wantedAssignee === undefined) return true;
        if (wantedAssignee === null) return view.assigneeKeyId === null;
        return view.assigneeKeyId === wantedAssignee;
      })
      .filter(view => {
        if (!query) return true;
        return (
          view.name.toLowerCase().includes(query) ||
          (view.lastMessage ?? '').toLowerCase().includes(query) ||
          view.chatId.toLowerCase().includes(query)
        );
      });
  }

  async get(sessionId: string, chatId: string): Promise<InboxConversationDetailDto> {
    const chat = await this.findChat(sessionId, chatId);
    const row = await this.conversations.findOne({ where: { sessionId, chatId } });
    const notes = row ? await this.notes.find({ where: { conversationId: row.id }, order: { createdAt: 'ASC' } }) : [];

    return { ...this.toView(chat, row), notes: notes.map(note => this.toNoteDto(note)) };
  }

  async update(
    sessionId: string,
    chatId: string,
    dto: UpdateInboxConversationDto,
    actor: ApiKey,
  ): Promise<InboxConversationDetailDto> {
    await this.findChat(sessionId, chatId);
    const row = await this.getOrCreateRow(sessionId, chatId);
    const previousStatus = row.status;
    const previousAssignee = row.assigneeKeyId;

    if (dto.status !== undefined && dto.status !== row.status) {
      row.status = dto.status;
      row.resolvedAt = dto.status === 'resolved' ? new Date() : null;
      await this.audit.logInfo(AuditAction.INBOX_CONVERSATION_STATUS_CHANGED, {
        sessionId,
        apiKey: actor,
        metadata: { chatId, from: previousStatus, to: dto.status },
      });
    }

    if (dto.assigneeKeyId !== undefined) {
      await this.applyAssignee(row, dto.assigneeKeyId);
      if (row.assigneeKeyId !== previousAssignee) {
        await this.audit.logInfo(AuditAction.INBOX_CONVERSATION_ASSIGNED, {
          sessionId,
          apiKey: actor,
          metadata: { chatId, from: previousAssignee, to: row.assigneeKeyId, assigneeName: row.assigneeName },
        });
      }
    }

    const saved = await this.conversations.save(row);
    this.events.emitInboxUpdated(sessionId, {
      chatId,
      status: saved.status,
      assigneeKeyId: saved.assigneeKeyId,
      assigneeName: saved.assigneeName,
    });

    return this.get(sessionId, chatId);
  }

  async addNote(sessionId: string, chatId: string, body: string, actor: ApiKey): Promise<InboxNoteDto> {
    await this.findChat(sessionId, chatId);
    const row = await this.getOrCreateRow(sessionId, chatId);
    const note = await this.notes.save(
      this.notes.create({ conversationId: row.id, authorKeyId: actor.id, authorName: actor.name, body }),
    );

    await this.audit.logInfo(AuditAction.INBOX_NOTE_ADDED, {
      sessionId,
      apiKey: actor,
      metadata: { chatId, noteId: note.id },
    });

    return this.toNoteDto(note);
  }

  async deleteNote(sessionId: string, chatId: string, noteId: string, actor: ApiKey): Promise<void> {
    const row = await this.conversations.findOne({ where: { sessionId, chatId } });
    const note = row ? await this.notes.findOne({ where: { id: noteId, conversationId: row.id } }) : null;
    if (!note) throw new NotFoundException('No such note on this conversation');

    await this.notes.remove(note);
    await this.audit.logInfo(AuditAction.INBOX_NOTE_DELETED, {
      sessionId,
      apiKey: actor,
      metadata: { chatId, noteId },
    });
  }

  /** Counts for the inbox header, computed from the same (already chat-scope-filtered) list. */
  summarize(conversations: InboxConversationDto[], viewerKeyId?: string): InboxSummaryDto {
    return {
      total: conversations.length,
      open: conversations.filter(c => c.status === 'open').length,
      pending: conversations.filter(c => c.status === 'pending').length,
      resolved: conversations.filter(c => c.status === 'resolved').length,
      unassigned: conversations.filter(c => c.assigneeKeyId === null).length,
      mine: conversations.filter(c => viewerKeyId !== undefined && c.assigneeKeyId === viewerKeyId).length,
    };
  }

  private async findChat(sessionId: string, chatId: string): Promise<ChatSummary> {
    const chat = (await this.sessionService.listChats(sessionId)).find(item => item.id === chatId);
    if (!chat) throw new NotFoundException(`No chat ${chatId} in this session`);
    return chat;
  }

  private async getOrCreateRow(sessionId: string, chatId: string): Promise<InboxConversation> {
    const existing = await this.conversations.findOne({ where: { sessionId, chatId } });
    if (existing) return existing;
    // Persist before returning: a note needs this row's id, and two agents acting at once rely on
    // the unique (sessionId, chatId) index rather than a read-then-write race.
    return this.conversations.save(
      this.conversations.create({
        sessionId,
        chatId,
        status: 'open' as InboxConversationStatus,
        assigneeKeyId: null,
        assigneeName: null,
        resolvedAt: null,
        lastInboundAt: null,
      }),
    );
  }

  private async applyAssignee(row: InboxConversation, assigneeKeyId: string | null): Promise<void> {
    if (assigneeKeyId === null) {
      row.assigneeKeyId = null;
      row.assigneeName = null;
      return;
    }

    const key = await this.apiKeys.findOne({ where: { id: assigneeKeyId } });
    if (!key || !key.isActive) {
      throw new BadRequestException('assigneeKeyId does not name an active API key');
    }
    row.assigneeKeyId = key.id;
    row.assigneeName = key.name;
  }

  /** `undefined` = no filter, `null` = unassigned only, string = that key id. */
  private resolveAssigneeFilter(assignee: string | undefined, viewerKeyId?: string): string | null | undefined {
    if (!assignee || assignee === 'all') return undefined;
    if (assignee === 'unassigned') return null;
    if (assignee === 'me') return viewerKeyId ?? null;
    return assignee;
  }

  /**
   * A resolved conversation with newer chat activity is open again. Only rows already resolved are
   * touched, and the update is batched, so the write path stays small even on a busy session.
   */
  private async reopenActiveConversations(chats: ChatSummary[], byChat: Map<string, InboxConversation>): Promise<void> {
    const reopened: InboxConversation[] = [];

    for (const chat of chats) {
      const row = byChat.get(chat.id);
      if (!row || row.status !== 'resolved' || !row.resolvedAt) continue;
      const lastActivityMs = (chat.timestamp || 0) * 1000;
      if (lastActivityMs <= row.resolvedAt.getTime()) continue;

      row.status = 'open';
      row.resolvedAt = null;
      row.lastInboundAt = new Date(lastActivityMs);
      reopened.push(row);
    }

    if (reopened.length === 0) return;
    await this.conversations.save(reopened);
    for (const row of reopened) {
      this.events.emitInboxUpdated(row.sessionId, {
        chatId: row.chatId,
        status: row.status,
        assigneeKeyId: row.assigneeKeyId,
        assigneeName: row.assigneeName,
      });
    }
  }

  private toView(chat: ChatSummary, row?: InboxConversation | null): InboxConversationDto {
    return {
      chatId: chat.id,
      name: chat.name,
      isGroup: chat.isGroup,
      kind: chat.kind,
      unreadCount: chat.unreadCount,
      timestamp: chat.timestamp,
      lastMessage: chat.lastMessage,
      lastMessageType: chat.lastMessageType,
      archived: chat.archived,
      pinned: chat.pinned,
      status: row?.status ?? 'open',
      assigneeKeyId: row?.assigneeKeyId ?? null,
      assigneeName: row?.assigneeName ?? null,
      resolvedAt: row?.resolvedAt ? row.resolvedAt.toISOString() : null,
    };
  }

  private toNoteDto(note: InboxNote): InboxNoteDto {
    return {
      id: note.id,
      authorKeyId: note.authorKeyId,
      authorName: note.authorName,
      body: note.body,
      createdAt: note.createdAt.toISOString(),
    };
  }
}
