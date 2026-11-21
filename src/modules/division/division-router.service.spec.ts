import { AuditAction } from '../audit/entities/audit-log.entity';
import { DIVISION_INBOX_PORT } from './division-inbox.port';
import {
  DivisionRouterService,
  DEFAULT_INVALID_REPLY,
  DEFAULT_MENU_FOOTER,
  DEFAULT_MENU_HEADER,
} from './division-router.service';
import type { DivisionRoutingContext } from './division.service';

const nowSeconds = () => Math.floor(Date.now() / 1000);

function context(overrides: Partial<DivisionRoutingContext> = {}): DivisionRoutingContext {
  return {
    enabled: true,
    idleHours: 24,
    menuHeader: null,
    invalidReply: null,
    divisions: [
      {
        id: 'div-a',
        name: 'CS SMP Putra',
        menuLabel: 'CS SMP Putra',
        welcomeText: null,
        keywords: ['smp', 'smp putra'],
        sortOrder: 0,
        slaMinutes: 0,
        agentKeyIds: ['key-1'],
      },
      {
        id: 'div-b',
        name: 'CS SMP Putri',
        menuLabel: 'CS SMP Putri',
        welcomeText: 'Halo dari Putri',
        keywords: ['smp putri', 'putri'],
        sortOrder: 1,
        slaMinutes: 0,
        agentKeyIds: ['key-2'],
      },
    ],
    ...overrides,
  };
}

function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chatId: '628111@c.us',
    body: 'halo',
    type: 'text',
    timestamp: nowSeconds(),
    fromMe: false,
    isGroup: false,
    kind: 'individual',
    ...overrides,
  };
}

/**
 * The router builds two query builders per prompt: the insert that makes the row exist and the
 * conditional update that claims it. Each builder is its own object with its own mode, so the claim
 * result is never confused with the insert's.
 */
type ClaimResult = { affected?: number };

function makeRouter(options: { claim?: jest.Mock<Promise<ClaimResult>, []> } = {}) {
  const claim = options.claim ?? jest.fn<Promise<ClaimResult>, []>().mockResolvedValue({ affected: 1 });
  const builders: Array<Record<string, jest.Mock>> = [];

  const createQueryBuilder = jest.fn(() => {
    let mode: 'insert' | 'update' = 'insert';
    const builder: Record<string, jest.Mock> = {};
    builder.insert = jest.fn(() => {
      mode = 'insert';
      return builder;
    });
    builder.update = jest.fn(() => {
      mode = 'update';
      return builder;
    });
    for (const method of ['into', 'values', 'orIgnore', 'set', 'where', 'andWhere']) {
      builder[method] = jest.fn(() => builder);
    }
    builder.execute = jest.fn(() => (mode === 'update' ? claim() : Promise.resolve({})));
    builders.push(builder);
    return builder;
  });

  const states = {
    findOne: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    createQueryBuilder,
  };
  const divisions = { routingContext: jest.fn().mockResolvedValue(context()) };
  const audit = { logInfo: jest.fn().mockResolvedValue(null) };
  const messagePort = { sendText: jest.fn().mockResolvedValue({}) };
  const inboxPort = {
    routeConversation: jest.fn().mockResolvedValue({ assigneeKeyId: 'key-1', assigneeName: 'Agen A' }),
    rearm: jest.fn(),
    clearDivision: jest.fn(),
  };
  const moduleRef = {
    get: jest.fn((token: unknown) => (token === DIVISION_INBOX_PORT ? inboxPort : messagePort)),
  };

  const router = new DivisionRouterService(states as never, divisions as never, audit as never, moduleRef as never);
  return { router, states, divisions, audit, messagePort, inboxPort, builders, claim };
}

type SendTextArgs = [string, { chatId: string; text: string }];

const lastText = (sendText: jest.Mock): string => {
  const calls = sendText.mock.calls as SendTextArgs[];
  return calls[calls.length - 1][1].text;
};

describe('DivisionRouterService.evaluateInbound', () => {
  it('sends the numbered menu on the first message and claims the prompt', async () => {
    const { router, messagePort, builders } = makeRouter();

    await expect(router.evaluateInbound('sess-1', message())).resolves.toBe(true);

    expect(messagePort.sendText).toHaveBeenCalledTimes(1);
    expect(lastText(messagePort.sendText)).toBe(
      [DEFAULT_MENU_HEADER, '', '1. CS SMP Putra', '2. CS SMP Putri', '', DEFAULT_MENU_FOOTER].join('\n'),
    );
    // The claim stores the ids the customer was shown, not the current list.
    const set = (
      builders[builders.length - 1].set.mock.calls as Array<[{ menuDivisionIds: string[]; promptedAt: Date }]>
    )[0][0];
    expect(set.menuDivisionIds).toEqual(['div-a', 'div-b']);
    expect(set.promptedAt).toBeInstanceOf(Date);
  });

  it('does not send a second menu when the claim is already held', async () => {
    const { router, messagePort } = makeRouter({ claim: jest.fn().mockResolvedValue({ affected: 0 }) });

    await expect(router.evaluateInbound('sess-1', message())).resolves.toBe(false);

    expect(messagePort.sendText).not.toHaveBeenCalled();
  });

  it('routes a numeric reply to the division the customer was actually shown', async () => {
    const { router, states, messagePort, inboxPort, audit } = makeRouter();
    states.findOne.mockResolvedValueOnce({
      id: 'state-1',
      status: 'awaiting',
      promptedAt: new Date(),
      invalidReplyAt: null,
      menuDivisionIds: ['div-b', 'div-a'],
    });

    await expect(router.evaluateInbound('sess-1', message({ body: '2' }))).resolves.toBe(true);

    expect(states.update).toHaveBeenCalledWith(
      { sessionId: 'sess-1', chatId: '628111@c.us' },
      expect.objectContaining({ status: 'routed', divisionId: 'div-a' }),
    );
    expect(inboxPort.routeConversation).toHaveBeenCalledWith(
      expect.objectContaining({ divisionId: 'div-a', divisionName: 'CS SMP Putra', agentKeyIds: ['key-1'] }),
    );
    expect(audit.logInfo).toHaveBeenCalledWith(AuditAction.DIVISION_ROUTED, expect.anything());
    // The welcome text, not the menu.
    expect(lastText(messagePort.sendText)).toContain('CS SMP Putra');
  });

  it('routes a keyword on the first message without showing a menu', async () => {
    const { router, messagePort, inboxPort } = makeRouter();

    await expect(
      router.evaluateInbound('sess-1', message({ body: 'Halo, mau tanya soal SMP Putri dong' })),
    ).resolves.toBe(true);

    expect(inboxPort.routeConversation).toHaveBeenCalledWith(expect.objectContaining({ divisionId: 'div-b' }));
    expect(messagePort.sendText).toHaveBeenCalledWith('sess-1', { chatId: '628111@c.us', text: 'Halo dari Putri' });
  });

  it('prefers the longest keyword when two divisions claim the message', async () => {
    const { router, inboxPort } = makeRouter();

    await router.evaluateInbound('sess-1', message({ body: 'smp putra' }));

    expect(inboxPort.routeConversation).toHaveBeenCalledWith(expect.objectContaining({ divisionId: 'div-a' }));
  });

  it('re-sends the menu when the customer asks for it', async () => {
    const { router, states, messagePort } = makeRouter();
    states.findOne.mockResolvedValueOnce({
      id: 'state-1',
      status: 'awaiting',
      promptedAt: new Date(),
      invalidReplyAt: null,
      menuDivisionIds: ['div-a', 'div-b'],
    });

    await expect(router.evaluateInbound('sess-1', message({ body: 'menu' }))).resolves.toBe(true);

    expect(lastText(messagePort.sendText)).toContain('1. CS SMP Putra');
  });

  it('answers an unmatched text once per prompt, then stays quiet', async () => {
    const { router, states, messagePort } = makeRouter();
    const promptedAt = new Date();
    states.findOne.mockResolvedValueOnce({
      id: 'state-1',
      status: 'awaiting',
      promptedAt,
      invalidReplyAt: null,
      menuDivisionIds: ['div-a', 'div-b'],
    });

    await expect(router.evaluateInbound('sess-1', message({ body: 'saya mau komplain' }))).resolves.toBe(true);
    expect(lastText(messagePort.sendText)).toBe(DEFAULT_INVALID_REPLY);

    states.findOne.mockResolvedValueOnce({
      id: 'state-1',
      status: 'awaiting',
      promptedAt,
      invalidReplyAt: new Date(),
      menuDivisionIds: ['div-a', 'div-b'],
    });
    await expect(router.evaluateInbound('sess-1', message({ body: 'halo?' }))).resolves.toBe(false);
    expect(messagePort.sendText).toHaveBeenCalledTimes(1);
  });

  it('leaves a routed conversation to the automation rules', async () => {
    const { router, states, messagePort } = makeRouter();
    states.findOne.mockResolvedValueOnce({
      id: 'state-1',
      status: 'routed',
      divisionId: 'div-a',
      routedAt: new Date(),
      lastInboundAt: new Date(),
      promptedAt: new Date(),
    });

    await expect(router.evaluateInbound('sess-1', message())).resolves.toBe(false);

    expect(messagePort.sendText).not.toHaveBeenCalled();
  });

  it('shows the menu again after the idle window', async () => {
    const { router, states, messagePort } = makeRouter();
    states.findOne.mockResolvedValueOnce({
      id: 'state-1',
      status: 'routed',
      divisionId: 'div-a',
      routedAt: new Date(Date.now() - 25 * 3_600_000),
      lastInboundAt: new Date(Date.now() - 25 * 3_600_000),
      promptedAt: null,
    });

    await expect(router.evaluateInbound('sess-1', message())).resolves.toBe(true);

    expect(lastText(messagePort.sendText)).toContain('1. CS SMP Putra');
  });

  it('shows the menu again when the routed division no longer exists', async () => {
    const { router, states, messagePort } = makeRouter();
    states.findOne.mockResolvedValueOnce({
      id: 'state-1',
      status: 'routed',
      divisionId: 'div-deleted',
      routedAt: new Date(),
      lastInboundAt: new Date(),
      promptedAt: null,
    });

    await expect(router.evaluateInbound('sess-1', message())).resolves.toBe(true);
    expect(lastText(messagePort.sendText)).toContain('1. CS SMP Putra');
  });

  it.each([
    ['the account own message', message({ fromMe: true })],
    ['a group chat', message({ isGroup: true, kind: 'group' })],
    ['a channel', message({ kind: 'channel' })],
    ['a stale message', message({ timestamp: nowSeconds() - 3_600 })],
  ])('ignores %s', async (_label, payload) => {
    const { router, messagePort, divisions } = makeRouter();

    await expect(router.evaluateInbound('sess-1', payload)).resolves.toBe(false);

    expect(divisions.routingContext).not.toHaveBeenCalled();
    expect(messagePort.sendText).not.toHaveBeenCalled();
  });

  it('does nothing when routing is disabled', async () => {
    const { router, messagePort, divisions } = makeRouter();
    divisions.routingContext.mockResolvedValueOnce(context({ enabled: false }));

    await expect(router.evaluateInbound('sess-1', message())).resolves.toBe(false);
    expect(messagePort.sendText).not.toHaveBeenCalled();
  });

  it('releases the claim and reports unhandled when the menu cannot be sent', async () => {
    const { router, states, messagePort } = makeRouter();
    messagePort.sendText.mockRejectedValueOnce(new Error('session disconnected'));

    await expect(router.evaluateInbound('sess-1', message())).resolves.toBe(false);

    expect(states.update).toHaveBeenCalledWith({ sessionId: 'sess-1', chatId: '628111@c.us' }, { promptedAt: null });
  });

  it('sends only one menu when two messages arrive at once', async () => {
    const claim = jest.fn().mockResolvedValueOnce({ affected: 1 }).mockResolvedValue({ affected: 0 });
    const { router, messagePort } = makeRouter({ claim });

    const [first, second] = await Promise.all([
      router.evaluateInbound('sess-1', message({ body: 'halo' })),
      router.evaluateInbound('sess-1', message({ body: 'halo lagi' })),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(messagePort.sendText).toHaveBeenCalledTimes(1);
  });
});
