import { BadRequestException, NotFoundException } from '@nestjs/common';
import { InboxService } from './inbox.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { ChatSummary } from '../../engine/interfaces/whatsapp-engine.interface';

function chat(overrides: Partial<ChatSummary> = {}): ChatSummary {
  return {
    id: '628111@c.us',
    name: 'Alice',
    isGroup: false,
    kind: 'individual',
    unreadCount: 0,
    timestamp: 1_700_000_000,
    archived: false,
    pinned: false,
    muted: false,
    ...overrides,
  };
}

function makeService() {
  const conversations = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn((row: unknown) => Promise.resolve(row)),
    create: jest.fn((row: unknown) => row),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    createQueryBuilder: jest.fn(),
  };
  const notes = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn((row: Record<string, unknown>) => Promise.resolve({ ...row, id: 'note-1', createdAt: new Date() })),
    create: jest.fn((row: unknown) => row),
    remove: jest.fn(),
  };
  const apiKeys = { findOne: jest.fn(), find: jest.fn().mockResolvedValue([]) };
  const sessionService = { listChats: jest.fn().mockResolvedValue([chat()]) };
  const audit = { logInfo: jest.fn().mockResolvedValue(null) };
  const events = { emitInboxUpdated: jest.fn() };
  const divisions = { rearm: jest.fn().mockResolvedValue(undefined), lookup: jest.fn().mockResolvedValue(null) };

  const service = new InboxService(
    conversations as never,
    notes as never,
    apiKeys as never,
    sessionService as never,
    audit as never,
    events as never,
    divisions as never,
  );

  return { service, conversations, notes, apiKeys, sessionService, audit, events, divisions };
}

const actor = { id: 'key-1', name: 'Agen A' } as never;

describe('InboxService.listAll', () => {
  it('treats a chat with no inbox row as open and unassigned', async () => {
    const { service } = makeService();

    const rows = await service.listAll('sess-1');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      chatId: '628111@c.us',
      name: 'Alice',
      status: 'open',
      assigneeKeyId: null,
      assigneeName: null,
      resolvedAt: null,
    });
  });

  it('overlays the stored assignment and status', async () => {
    const { service, conversations } = makeService();
    conversations.find.mockResolvedValue([
      {
        sessionId: 'sess-1',
        chatId: '628111@c.us',
        status: 'pending',
        assigneeKeyId: 'key-1',
        assigneeName: 'Agen A',
        resolvedAt: null,
        lastInboundAt: null,
      },
    ]);

    const [row] = await service.listAll('sess-1');

    expect(row.status).toBe('pending');
    expect(row.assigneeKeyId).toBe('key-1');
    expect(row.assigneeName).toBe('Agen A');
  });

  it('reopens a resolved conversation whose chat saw newer activity', async () => {
    const { service, conversations, events } = makeService();
    const resolvedAt = new Date(1_600_000_000_000);
    conversations.find.mockResolvedValue([
      {
        sessionId: 'sess-1',
        chatId: '628111@c.us',
        status: 'resolved',
        assigneeKeyId: null,
        assigneeName: null,
        resolvedAt,
        lastInboundAt: null,
      },
    ]);

    const [row] = await service.listAll('sess-1');

    expect(row.status).toBe('open');
    expect(row.resolvedAt).toBeNull();
    expect(conversations.save).toHaveBeenCalledTimes(1);
    expect(events.emitInboxUpdated).toHaveBeenCalledWith('sess-1', expect.objectContaining({ status: 'open' }));
  });

  it('filters by assignee=me and unassigned', async () => {
    const { service, conversations, sessionService } = makeService();
    sessionService.listChats.mockResolvedValue([
      chat({ id: 'a@c.us' }),
      chat({ id: 'b@c.us' }),
      chat({ id: 'c@c.us' }),
    ]);
    conversations.find.mockResolvedValue([
      { sessionId: 'sess-1', chatId: 'a@c.us', status: 'open', assigneeKeyId: 'key-1', assigneeName: 'Agen A' },
      { sessionId: 'sess-1', chatId: 'b@c.us', status: 'open', assigneeKeyId: 'key-2', assigneeName: 'Agen B' },
    ]);

    const mine = await service.listAll('sess-1', { assignee: 'me' }, 'key-1');
    const unassigned = await service.listAll('sess-1', { assignee: 'unassigned' }, 'key-1');

    expect(mine.map(row => row.chatId)).toEqual(['a@c.us']);
    expect(unassigned.map(row => row.chatId)).toEqual(['c@c.us']);
  });

  it('searches name, chat id and last message', async () => {
    const { service, sessionService } = makeService();
    sessionService.listChats.mockResolvedValue([
      chat({ id: 'a@c.us', name: 'Alice' }),
      chat({ id: 'b@c.us', name: 'Bob', lastMessage: 'harga berapa?' }),
    ]);

    expect((await service.listAll('sess-1', { q: 'ali' })).map(row => row.chatId)).toEqual(['a@c.us']);
    expect((await service.listAll('sess-1', { q: 'harga' })).map(row => row.chatId)).toEqual(['b@c.us']);
    expect((await service.listAll('sess-1', { q: 'b@' })).map(row => row.chatId)).toEqual(['b@c.us']);
  });
});

describe('InboxService.update', () => {
  it('resolves the assignee name, audits and emits', async () => {
    const { service, conversations, apiKeys, audit, events } = makeService();
    conversations.findOne.mockResolvedValue({
      id: 'conv-1',
      sessionId: 'sess-1',
      chatId: '628111@c.us',
      status: 'open',
      assigneeKeyId: null,
      assigneeName: null,
      resolvedAt: null,
    });
    apiKeys.findOne.mockResolvedValue({ id: 'key-2', name: 'Agen B', isActive: true });

    await service.update('sess-1', '628111@c.us', { assigneeKeyId: 'key-2' }, actor);

    expect(apiKeys.findOne).toHaveBeenCalledWith({ where: { id: 'key-2' } });
    expect(conversations.save).toHaveBeenCalledWith(
      expect.objectContaining({ assigneeKeyId: 'key-2', assigneeName: 'Agen B' }),
    );
    expect(audit.logInfo).toHaveBeenCalledWith(
      AuditAction.INBOX_CONVERSATION_ASSIGNED,
      expect.objectContaining({ sessionId: 'sess-1' }),
    );
    expect(events.emitInboxUpdated).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ chatId: '628111@c.us', assigneeKeyId: 'key-2' }),
    );
  });

  it('refuses an assignee that is not an active API key', async () => {
    const { service, conversations, apiKeys } = makeService();
    conversations.findOne.mockResolvedValue({
      id: 'conv-1',
      sessionId: 'sess-1',
      chatId: '628111@c.us',
      status: 'open',
      assigneeKeyId: null,
      assigneeName: null,
      resolvedAt: null,
    });
    apiKeys.findOne.mockResolvedValue({ id: 'key-2', name: 'Agen B', isActive: false });

    await expect(service.update('sess-1', '628111@c.us', { assigneeKeyId: 'key-2' }, actor)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('sets resolvedAt when resolving and clears it on reopen', async () => {
    const { service, conversations } = makeService();
    const row = {
      id: 'conv-1',
      sessionId: 'sess-1',
      chatId: '628111@c.us',
      status: 'open',
      assigneeKeyId: null,
      assigneeName: null,
      resolvedAt: null as Date | null,
    };
    conversations.findOne.mockResolvedValue(row);

    await service.update('sess-1', '628111@c.us', { status: 'resolved' }, actor);
    expect(row.resolvedAt).toBeInstanceOf(Date);

    await service.update('sess-1', '628111@c.us', { status: 'open' }, actor);
    expect(row.resolvedAt).toBeNull();
  });

  it('404s for a chat the session does not have', async () => {
    const { service } = makeService();
    await expect(service.update('sess-1', 'ghost@c.us', { status: 'open' }, actor)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('InboxService notes', () => {
  it('creates a conversation row when the chat had none and records the author', async () => {
    const { service, conversations, notes, audit } = makeService();
    conversations.save.mockImplementation((row: unknown) =>
      Promise.resolve({ ...(row as Record<string, unknown>), id: 'conv-1' }),
    );

    const note = await service.addNote('sess-1', '628111@c.us', 'Follow up besok', actor);

    expect(conversations.create).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-1', chatId: '628111@c.us', status: 'open' }),
    );
    expect(notes.create).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', authorKeyId: 'key-1', authorName: 'Agen A' }),
    );
    expect(note).toMatchObject({ id: 'note-1', authorName: 'Agen A', body: 'Follow up besok' });
    expect(audit.logInfo).toHaveBeenCalledWith(
      AuditAction.INBOX_NOTE_ADDED,
      expect.objectContaining({ sessionId: 'sess-1' }),
    );
  });

  it('404s when deleting a note that is not on the conversation', async () => {
    const { service, conversations, notes } = makeService();
    conversations.findOne.mockResolvedValue({ id: 'conv-1' });
    notes.findOne.mockResolvedValue(null);

    await expect(service.deleteNote('sess-1', '628111@c.us', 'note-x', actor)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('InboxService.summarize', () => {
  it('counts statuses, unassigned and mine', () => {
    const { service } = makeService();
    const rows = [
      { status: 'open', assigneeKeyId: 'key-1' },
      { status: 'open', assigneeKeyId: null },
      { status: 'pending', assigneeKeyId: 'key-2' },
      { status: 'resolved', assigneeKeyId: null },
    ] as never[];

    expect(service.summarize(rows, 'key-1')).toEqual({
      total: 4,
      open: 2,
      pending: 1,
      resolved: 1,
      unassigned: 2,
      mine: 1,
    });
  });
});

describe('InboxService division routing', () => {
  /** `pickLeastBusy` reads one grouped count through a query builder. */
  function countBuilder(rows: Array<{ assigneeKeyId: string; load: string | number }>) {
    const builder: Record<string, jest.Mock> = {};
    for (const method of ['select', 'addSelect', 'where', 'andWhere', 'groupBy']) {
      builder[method] = jest.fn(() => builder);
    }
    builder.getRawMany = jest.fn().mockResolvedValue(rows);
    return builder;
  }

  it('tags the conversation and assigns the least busy active agent', async () => {
    const { service, conversations, apiKeys, events } = makeService();
    conversations.findOne.mockResolvedValue(null);
    apiKeys.find.mockResolvedValue([
      { id: 'key-1', name: 'Agen A', isActive: true },
      { id: 'key-2', name: 'Agen B', isActive: true },
    ]);
    conversations.createQueryBuilder.mockReturnValue(
      countBuilder([
        { assigneeKeyId: 'key-1', load: '4' },
        { assigneeKeyId: 'key-2', load: '1' },
      ]),
    );

    const result = await service.routeConversation({
      sessionId: 'sess-1',
      chatId: '628111@c.us',
      divisionId: 'div-1',
      divisionName: 'CS SMP Putra',
      slaMinutes: 0,
      agentKeyIds: ['key-1', 'key-2'],
    });

    expect(result).toEqual({ assigneeKeyId: 'key-2', assigneeName: 'Agen B' });
    expect(conversations.save).toHaveBeenCalledWith(
      expect.objectContaining({ divisionId: 'div-1', divisionName: 'CS SMP Putra', assigneeKeyId: 'key-2' }),
    );
    expect(events.emitInboxUpdated).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ divisionId: 'div-1', assigneeKeyId: 'key-2' }),
    );
  });

  it('keeps the current CS when the chat already belongs to that division', async () => {
    const { service, conversations, apiKeys } = makeService();
    conversations.findOne.mockResolvedValue({
      id: 'conv-1',
      sessionId: 'sess-1',
      chatId: '628111@c.us',
      status: 'open',
      divisionId: 'div-1',
      assigneeKeyId: 'key-1',
      assigneeName: 'Agen A',
    });
    apiKeys.find.mockResolvedValue([{ id: 'key-1', name: 'Agen A', isActive: true }]);

    const result = await service.routeConversation({
      sessionId: 'sess-1',
      chatId: '628111@c.us',
      divisionId: 'div-1',
      divisionName: 'CS SMP Putra',
      slaMinutes: 0,
      agentKeyIds: ['key-1'],
    });

    expect(result.assigneeKeyId).toBe('key-1');
    expect(conversations.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('tags without an assignee when no member key is active', async () => {
    const { service, conversations, apiKeys } = makeService();
    conversations.findOne.mockResolvedValue(null);
    apiKeys.find.mockResolvedValue([{ id: 'key-1', name: 'Agen A', isActive: false }]);

    const result = await service.routeConversation({
      sessionId: 'sess-1',
      chatId: '628111@c.us',
      divisionId: 'div-1',
      divisionName: 'CS SMP Putra',
      slaMinutes: 0,
      agentKeyIds: ['key-1'],
    });

    expect(result).toEqual({ assigneeKeyId: null, assigneeName: null });
    expect(conversations.save).toHaveBeenCalledWith(
      expect.objectContaining({ divisionId: 'div-1', assigneeKeyId: null }),
    );
  });

  it('rejects a division that belongs to another session', async () => {
    const { service, conversations, divisions } = makeService();
    conversations.findOne.mockResolvedValue({ id: 'conv-1', sessionId: 'sess-1', chatId: '628111@c.us' });
    divisions.lookup.mockResolvedValue(null);

    await expect(service.update('sess-1', '628111@c.us', { divisionId: 'div-other' }, actor)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('re-arms the routing when the conversation is resolved', async () => {
    const { service, conversations, divisions } = makeService();
    conversations.findOne.mockResolvedValue({
      id: 'conv-1',
      sessionId: 'sess-1',
      chatId: '628111@c.us',
      status: 'open',
      assigneeKeyId: null,
      divisionId: null,
    });

    await service.update('sess-1', '628111@c.us', { status: 'resolved' }, actor);

    expect(divisions.rearm).toHaveBeenCalledWith('sess-1', '628111@c.us');
  });

  it('filters the list by division, with `unassigned` meaning untagged', async () => {
    const { service, conversations } = makeService();
    conversations.find.mockResolvedValue([
      { sessionId: 'sess-1', chatId: '628111@c.us', status: 'open', divisionId: 'div-1', divisionName: 'Putra' },
    ]);

    const tagged = await service.listAll('sess-1', { division: 'div-1' });
    const untagged = await service.listAll('sess-1', { division: 'unassigned' });

    expect(tagged).toHaveLength(1);
    expect(tagged[0].divisionName).toBe('Putra');
    expect(untagged).toHaveLength(0);
  });
});

describe('InboxService first-response SLA', () => {
  const STARTED = new Date('2026-11-20T08:00:00.000Z');
  const DUE = new Date('2026-11-20T08:15:00.000Z');

  it('resolving clears the clock but keeps the response history', async () => {
    const { service, conversations } = makeService();
    conversations.findOne.mockResolvedValue({
      id: 'conv-1',
      sessionId: 'sess-1',
      chatId: '628111@c.us',
      status: 'open',
      assigneeKeyId: null,
      assigneeName: null,
      divisionId: 'div-1',
      divisionName: 'SMP',
      firstInboundAt: STARTED,
      firstResponseAt: null,
      slaStartedAt: STARTED,
      slaDueAt: DUE,
      slaBreachedAt: new Date('2026-11-20T08:20:00.000Z'),
      slaMinutes: 15,
      resolvedAt: null,
    });

    await service.update('sess-1', '628111@c.us', { status: 'resolved' }, actor);

    expect(conversations.save).toHaveBeenCalledWith(
      expect.objectContaining({
        slaStartedAt: null,
        slaDueAt: null,
        slaBreachedAt: null,
        firstInboundAt: STARTED,
        slaMinutes: 15,
      }),
    );
  });

  it('re-measures an open window against the division the chat is moved to', async () => {
    const { service, conversations, divisions } = makeService();
    conversations.findOne.mockResolvedValue({
      id: 'conv-1',
      sessionId: 'sess-1',
      chatId: '628111@c.us',
      status: 'open',
      divisionId: 'div-1',
      divisionName: 'SMP',
      slaStartedAt: STARTED,
      slaDueAt: DUE,
      slaMinutes: 15,
    });
    divisions.lookup.mockResolvedValue({ id: 'div-2', name: 'SMA', slaMinutes: 30 });

    await service.update('sess-1', '628111@c.us', { divisionId: 'div-2' }, actor);

    expect(conversations.save).toHaveBeenCalledWith(
      expect.objectContaining({
        divisionId: 'div-2',
        slaMinutes: 30,
        slaDueAt: new Date(STARTED.getTime() + 30 * 60_000),
      }),
    );
  });

  it('clears the deadline when the chat is untagged', async () => {
    const { service, conversations } = makeService();
    conversations.findOne.mockResolvedValue({
      id: 'conv-1',
      sessionId: 'sess-1',
      chatId: '628111@c.us',
      status: 'open',
      divisionId: 'div-1',
      divisionName: 'SMP',
      slaStartedAt: STARTED,
      slaDueAt: DUE,
      slaMinutes: 15,
    });

    await service.update('sess-1', '628111@c.us', { divisionId: null }, actor);

    expect(conversations.save).toHaveBeenCalledWith(
      expect.objectContaining({ divisionId: null, slaMinutes: null, slaDueAt: null, slaStartedAt: STARTED }),
    );
  });

  it('gives the first contact a deadline when routing runs after the inbound hook', async () => {
    const { service, conversations } = makeService();
    conversations.findOne.mockResolvedValue({
      id: 'conv-1',
      sessionId: 'sess-1',
      chatId: '628111@c.us',
      status: 'open',
      divisionId: null,
      divisionName: null,
      slaStartedAt: STARTED,
      slaDueAt: null,
      slaMinutes: null,
    });

    await service.routeConversation({
      sessionId: 'sess-1',
      chatId: '628111@c.us',
      divisionId: 'div-1',
      divisionName: 'SMP',
      slaMinutes: 15,
      agentKeyIds: [],
    });

    expect(conversations.save).toHaveBeenCalledWith(
      expect.objectContaining({
        divisionId: 'div-1',
        slaMinutes: 15,
        slaDueAt: new Date(STARTED.getTime() + 15 * 60_000),
      }),
    );
  });

  it('drops the deadline of a deleted division from every tagged conversation', async () => {
    const { service, conversations } = makeService();
    conversations.find.mockResolvedValue([
      {
        sessionId: 'sess-1',
        chatId: '628111@c.us',
        status: 'open',
        assigneeKeyId: null,
        assigneeName: null,
        divisionId: 'div-1',
        divisionName: 'SMP',
        slaStartedAt: STARTED,
        slaDueAt: DUE,
        slaMinutes: 15,
      },
    ]);

    await service.clearDivision('sess-1', 'div-1');

    expect(conversations.update).toHaveBeenCalledWith(
      { sessionId: 'sess-1', divisionId: 'div-1' },
      { divisionId: null, divisionName: null, slaMinutes: null, slaDueAt: null },
    );
  });

  it('carries the six SLA fields in the view and in inbox.updated', async () => {
    const { service, conversations, events } = makeService();
    conversations.find.mockResolvedValue([
      {
        sessionId: 'sess-1',
        chatId: '628111@c.us',
        status: 'open',
        assigneeKeyId: null,
        assigneeName: null,
        divisionId: 'div-1',
        divisionName: 'SMP',
        firstInboundAt: STARTED,
        firstResponseAt: null,
        slaStartedAt: STARTED,
        slaDueAt: DUE,
        slaBreachedAt: null,
        slaMinutes: 15,
      },
    ]);

    const rows = await service.listAll('sess-1');

    expect(rows[0]).toMatchObject({
      firstInboundAt: STARTED.toISOString(),
      firstResponseAt: null,
      slaStartedAt: STARTED.toISOString(),
      slaDueAt: DUE.toISOString(),
      slaBreachedAt: null,
      slaMinutes: 15,
    });
    // The row is open and untouched, so the list read does not announce anything.
    expect(events.emitInboxUpdated).not.toHaveBeenCalled();
  });
});
