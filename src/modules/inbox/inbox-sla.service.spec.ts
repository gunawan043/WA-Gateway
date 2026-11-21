import { InboxSlaService } from './inbox-sla.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { MessageDirection, MessageStatus } from '../message/entities/message.entity';
import { runWithRequestId, setRequestActor } from '../../common/services/request-context';
import type { HookHandler, HookResult } from '../../core/hooks';

const AT = 1_700_000_000; // unix seconds
const at = new Date(AT * 1000);

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'conv-1',
    sessionId: 'sess-1',
    chatId: '628111@c.us',
    status: 'open',
    assigneeKeyId: null,
    assigneeName: null,
    divisionId: null,
    divisionName: null,
    firstInboundAt: null,
    firstResponseAt: null,
    slaStartedAt: null,
    slaDueAt: null,
    slaBreachedAt: null,
    slaMinutes: null,
    resolvedAt: null,
    lastInboundAt: null,
    ...overrides,
  };
}

function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg-1',
    chatId: '628111@c.us',
    direction: MessageDirection.INCOMING,
    status: MessageStatus.SENT,
    timestamp: AT,
    ...overrides,
  };
}

function makeSweepBuilder(rows: unknown[] = [], affected = 1) {
  const builder: Record<string, jest.Mock> = {};
  for (const method of ['where', 'andWhere', 'orderBy', 'take', 'update', 'set']) {
    builder[method] = jest.fn(() => builder);
  }
  builder.getMany = jest.fn().mockResolvedValue(rows);
  builder.execute = jest.fn().mockResolvedValue({ affected });
  return builder;
}

const handlers = new WeakMap<InboxSlaService, () => HookHandler>();
const started = new WeakSet<InboxSlaService>();

function makeService(options: { sweep?: ReturnType<typeof makeSweepBuilder> } = {}) {
  const sweep = options.sweep ?? makeSweepBuilder();
  const conversations = {
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn((saved: unknown) => Promise.resolve(saved)),
    createQueryBuilder: jest.fn(() => sweep),
  };
  const inbox = {
    ensureConversation: jest.fn().mockResolvedValue(row()),
    notifyChanged: jest.fn(),
  };
  const divisions = { slaMinutesByDivision: jest.fn().mockResolvedValue(new Map<string, number>()) };
  const events = { emitInboxSlaBreached: jest.fn() };
  const audit = { logWarn: jest.fn().mockResolvedValue(null) };
  let registered: HookHandler | undefined;
  const hooks = {
    register: jest.fn((_pluginId: string, _event: string, handler: HookHandler) => {
      registered = handler;
      return 'hook-1';
    }),
  };

  const service = new InboxSlaService(
    conversations as never,
    inbox as never,
    divisions as never,
    events as never,
    audit as never,
    hooks as never,
  );

  handlers.set(service, () => registered!);

  return { service, conversations, inbox, divisions, events, audit, hooks, sweep };
}

/** Starts the service once per instance: registering twice would double the work, not the coverage. */
function ensureStarted(service: InboxSlaService): void {
  if (started.has(service)) return;
  started.add(service);
  service.onModuleInit();
}

async function fire(service: InboxSlaService, data: Record<string, unknown>): Promise<HookResult> {
  ensureStarted(service);
  return handlers.get(service)!()({
    event: 'message:persisted',
    data,
    sessionId: data.sessionId as string,
    timestamp: new Date(),
    source: 'test',
  });
}

describe('InboxSlaService inbound', () => {
  it('opens a window with the division target and remembers the first message', async () => {
    const { service, conversations, inbox, divisions } = makeService();
    divisions.slaMinutesByDivision.mockResolvedValue(new Map([['div-1', 15]]));
    inbox.ensureConversation.mockResolvedValue(row({ divisionId: 'div-1', divisionName: 'SMP' }));

    await fire(service, { sessionId: 'sess-1', message: message() });

    const saved = conversations.save.mock.calls[0][0] as Record<string, unknown>;
    expect(saved.firstInboundAt).toEqual(at);
    expect(saved.lastInboundAt).toEqual(at);
    expect(saved.slaStartedAt).toEqual(at);
    expect(saved.slaMinutes).toBe(15);
    expect(saved.slaDueAt).toEqual(new Date(at.getTime() + 15 * 60_000));
    expect(saved.slaBreachedAt).toBeNull();
    expect(inbox.notifyChanged).toHaveBeenCalledWith(saved);
  });

  it('starts the clock even without a division, so routing can fill the deadline in later', async () => {
    const { service, conversations, inbox } = makeService();

    await fire(service, { sessionId: 'sess-1', message: message() });

    const saved = conversations.save.mock.calls[0][0] as Record<string, unknown>;
    expect(saved.slaStartedAt).toEqual(at);
    expect(saved.slaDueAt).toBeNull();
    expect(saved.slaMinutes).toBeNull();
    expect(inbox.notifyChanged).not.toHaveBeenCalled();
  });

  it('restarts the window on a newer message and clears the breach of the old one', async () => {
    const { service, conversations, inbox, divisions } = makeService();
    divisions.slaMinutesByDivision.mockResolvedValue(new Map([['div-1', 15]]));
    const previous = new Date(at.getTime() - 3_600_000);
    inbox.ensureConversation.mockResolvedValue(
      row({
        divisionId: 'div-1',
        firstInboundAt: previous,
        slaStartedAt: previous,
        slaDueAt: previous,
        slaBreachedAt: previous,
        slaMinutes: 15,
      }),
    );

    await fire(service, { sessionId: 'sess-1', message: message() });

    const saved = conversations.save.mock.calls[0][0] as Record<string, unknown>;
    expect(saved.firstInboundAt).toEqual(previous);
    expect(saved.slaStartedAt).toEqual(at);
    expect(saved.slaBreachedAt).toBeNull();
    expect(saved.slaDueAt).toEqual(new Date(at.getTime() + 15 * 60_000));
  });

  it('reopens a resolved conversation that received a newer message', async () => {
    const { service, conversations, inbox } = makeService();
    inbox.ensureConversation.mockResolvedValue(
      row({ status: 'resolved', resolvedAt: new Date(at.getTime() - 60_000) }),
    );

    await fire(service, { sessionId: 'sess-1', message: message() });

    const saved = conversations.save.mock.calls[0][0] as Record<string, unknown>;
    expect(saved.status).toBe('open');
    expect(saved.resolvedAt).toBeNull();
    expect(saved.slaStartedAt).toEqual(at);
  });

  it('ignores a replayed message older than the resolution', async () => {
    const { service, conversations, inbox } = makeService();
    inbox.ensureConversation.mockResolvedValue(
      row({ status: 'resolved', resolvedAt: new Date(at.getTime() + 60_000) }),
    );

    await fire(service, { sessionId: 'sess-1', message: message() });

    expect(conversations.save).not.toHaveBeenCalled();
    expect(inbox.notifyChanged).not.toHaveBeenCalled();
  });
});

describe('InboxSlaService human reply', () => {
  const outbound = () => message({ id: 'msg-2', direction: MessageDirection.OUTGOING, status: MessageStatus.SENT });

  it('stops the clock, records the first response and keeps the breach', async () => {
    const { service, conversations, inbox } = makeService();
    conversations.findOne.mockResolvedValue(
      row({
        firstInboundAt: new Date(at.getTime() - 3_600_000),
        slaStartedAt: new Date(at.getTime() - 3_600_000),
        slaDueAt: new Date(at.getTime() - 3_000_000),
        slaBreachedAt: new Date(at.getTime() - 3_000_000),
        slaMinutes: 15,
      }),
    );

    await runWithRequestId('req-1', async () => {
      setRequestActor({ apiKeyId: 'key-1', apiKeyName: 'Agen A' });
      await fire(service, { sessionId: 'sess-1', message: outbound() });
    });

    const saved = conversations.save.mock.calls[0][0] as Record<string, unknown>;
    expect(saved.firstResponseAt).toEqual(at);
    expect(saved.slaStartedAt).toBeNull();
    expect(saved.slaDueAt).toBeNull();
    expect(saved.slaBreachedAt).not.toBeNull();
    expect(inbox.notifyChanged).toHaveBeenCalledWith(saved);
  });

  it('does not overwrite an earlier first response', async () => {
    const { service, conversations } = makeService();
    const first = new Date(at.getTime() - 600_000);
    conversations.findOne.mockResolvedValue(row({ firstResponseAt: first }));

    await runWithRequestId('req-1', async () => {
      setRequestActor({ apiKeyId: 'key-1' });
      await fire(service, { sessionId: 'sess-1', message: outbound() });
    });

    const saved = conversations.save.mock.calls[0][0] as Record<string, unknown>;
    expect(saved.firstResponseAt).toEqual(first);
  });

  it('ignores a send with no request actor: the gateway answering is not the team answering', async () => {
    const { service, conversations } = makeService();
    conversations.findOne.mockResolvedValue(row({ slaStartedAt: at }));

    await fire(service, { sessionId: 'sess-1', message: outbound() });

    expect(conversations.findOne).not.toHaveBeenCalled();
    expect(conversations.save).not.toHaveBeenCalled();
  });

  it('ignores a PENDING or FAILED send even with an actor', async () => {
    const { service, conversations } = makeService();
    conversations.findOne.mockResolvedValue(row({ slaStartedAt: at }));

    await runWithRequestId('req-1', async () => {
      setRequestActor({ apiKeyId: 'key-1' });
      await fire(service, {
        sessionId: 'sess-1',
        message: message({ id: 'msg-3', direction: MessageDirection.OUTGOING, status: MessageStatus.PENDING }),
      });
      await fire(service, {
        sessionId: 'sess-1',
        message: message({ id: 'msg-4', direction: MessageDirection.OUTGOING, status: MessageStatus.FAILED }),
      });
    });

    expect(conversations.save).not.toHaveBeenCalled();
  });
});

describe('InboxSlaService emission hygiene', () => {
  it('handles one row once even though message:persisted fires per state', async () => {
    const { service, conversations } = makeService();

    await fire(service, { sessionId: 'sess-1', message: message() });
    await fire(service, { sessionId: 'sess-1', message: message() });

    expect(conversations.save).toHaveBeenCalledTimes(1);
  });

  it('swallows a database failure and keeps the chain going', async () => {
    const { service, conversations } = makeService();
    conversations.save.mockRejectedValue(new Error('database is locked'));

    const result = await fire(service, { sessionId: 'sess-1', message: message() });

    expect(result).toEqual({ continue: true });
  });

  it('registers at priority 90 on message:persisted', () => {
    const { service, hooks } = makeService();
    service.onModuleInit();

    expect(hooks.register).toHaveBeenCalledWith('inbox-sla', 'message:persisted', expect.any(Function), 90);
    service.onModuleDestroy();
  });
});

describe('InboxSlaService sweeper', () => {
  it('claims an overdue window once and announces it', async () => {
    const overdue = row({
      id: 'conv-9',
      divisionId: 'div-1',
      divisionName: 'SMP',
      assigneeKeyId: 'key-1',
      assigneeName: 'Rina',
      slaStartedAt: new Date(at.getTime() - 3_600_000),
      slaDueAt: new Date(at.getTime() - 1_800_000),
      slaMinutes: 15,
    });
    const sweep = makeSweepBuilder([overdue], 1);
    const { service, events, audit } = makeService({ sweep });

    await (service as unknown as { sweep: () => Promise<void> }).sweep();

    expect(events.emitInboxSlaBreached).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({
        chatId: '628111@c.us',
        divisionId: 'div-1',
        assigneeKeyId: 'key-1',
        slaMinutes: 15,
      }),
    );
    const [action, context] = audit.logWarn.mock.calls[0] as [
      AuditAction,
      { sessionId: string; metadata: Record<string, unknown> },
    ];
    expect(action).toBe(AuditAction.INBOX_SLA_BREACHED);
    expect(context.sessionId).toBe('sess-1');
    expect(context.metadata).toMatchObject({ chatId: '628111@c.us', divisionId: 'div-1' });
  });

  it('stays silent when another node already claimed the row', async () => {
    const sweep = makeSweepBuilder([row({ slaDueAt: new Date(at.getTime() - 60_000) })], 0);
    const { service, events, audit } = makeService({ sweep });

    await (service as unknown as { sweep: () => Promise<void> }).sweep();

    expect(events.emitInboxSlaBreached).not.toHaveBeenCalled();
    expect(audit.logWarn).not.toHaveBeenCalled();
  });

  it('stops after the first empty batch', async () => {
    const sweep = makeSweepBuilder([], 0);
    const { service } = makeService({ sweep });

    await (service as unknown as { sweep: () => Promise<void> }).sweep();

    expect(sweep.getMany).toHaveBeenCalledTimes(1);
  });
});
