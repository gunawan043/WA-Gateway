import { BadRequestException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InboxController } from './inbox.controller';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { REQUIRED_ROLE_KEY } from '../auth/decorators/auth.decorators';

function makeController() {
  const loaded = {
    from: new Date('2026-11-01T00:00:00.000Z'),
    to: new Date('2026-11-30T00:00:00.000Z'),
    rows: [{ chatId: 'allowed@c.us' }, { chatId: 'hidden@c.us' }],
  };
  const visible = [loaded.rows[0]];
  const reports = {
    load: jest.fn().mockResolvedValue(loaded),
    build: jest.fn().mockReturnValue({ totals: { conversations: 1 } }),
  };
  const chatScope = { filter: jest.fn().mockResolvedValue(visible) };
  const inbox = {};
  const controller = new InboxController(inbox as never, reports as never, chatScope as never);
  return { controller, reports, chatScope, loaded, visible };
}

describe('InboxController.report', () => {
  it('passes the range and the division filter through, then builds from the visible rows', async () => {
    const { controller, reports, chatScope, loaded, visible } = makeController();
    const apiKey = { id: 'key-1', name: 'Rina' } as never;

    await controller.report('sess-1', apiKey, '2026-11-01T00:00:00.000Z', '2026-11-30T00:00:00.000Z', 'div-1');

    expect(reports.load).toHaveBeenCalledWith('sess-1', {
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-30T00:00:00.000Z',
      division: 'div-1',
    });
    expect(chatScope.filter).toHaveBeenCalledWith(apiKey, loaded.rows, expect.any(Function));
    expect(reports.build).toHaveBeenCalledWith({ from: loaded.from, to: loaded.to, rows: visible });
  });

  it('leaves the defaults to the service when no query is given', async () => {
    const { controller, reports } = makeController();

    await controller.report('sess-1', undefined, undefined, undefined, undefined);

    expect(reports.load).toHaveBeenCalledWith('sess-1', {
      from: undefined,
      to: undefined,
      division: undefined,
    });
  });

  it('filters before aggregating, so a hidden chat never reaches the totals', async () => {
    const { controller, reports, chatScope } = makeController();

    await controller.report('sess-1', undefined, undefined, undefined, undefined);

    expect(chatScope.filter.mock.invocationCallOrder[0]).toBeLessThan(reports.build.mock.invocationCallOrder[0]);
  });

  it('is readable by every role that may open the inbox', () => {
    /* eslint-disable @typescript-eslint/unbound-method -- reading route metadata, not invoking */
    const handler = InboxController.prototype.report;
    /* eslint-enable @typescript-eslint/unbound-method */
    const role: unknown = Reflect.getMetadata(REQUIRED_ROLE_KEY, handler);
    expect(role).toBe(ApiKeyRole.VIEWER);
    expect(new Reflector().getAllAndOverride<ApiKeyRole>(REQUIRED_ROLE_KEY, [handler])).toBe(ApiKeyRole.VIEWER);
  });
});

function makeConversationController() {
  const all = [
    { chatId: 'allowed@c.us', name: 'Allowed' },
    { chatId: 'hidden@c.us', name: 'Hidden' },
  ];
  const visible = [all[0]];
  const inbox = {
    listAll: jest.fn().mockResolvedValue(all),
    summarize: jest.fn().mockReturnValue({ open: 1 }),
    get: jest.fn().mockResolvedValue({ chatId: 'allowed@c.us' }),
    update: jest.fn().mockResolvedValue({ chatId: 'allowed@c.us' }),
    addNote: jest.fn().mockResolvedValue({ id: 'note-1' }),
    deleteNote: jest.fn().mockResolvedValue(undefined),
  };
  const chatScope = { filter: jest.fn().mockResolvedValue(visible) };
  const controller = new InboxController(inbox as never, {} as never, chatScope as never);
  const apiKey = { id: 'key-1', name: 'Rina' } as never;
  return { controller, inbox, chatScope, all, visible, apiKey };
}

describe('InboxController.list', () => {
  it('filters before paging and applies the default page', async () => {
    const { controller, inbox, chatScope, all, visible, apiKey } = makeConversationController();

    const out = await controller.list('sess-1', apiKey);

    expect(inbox.listAll).toHaveBeenCalledWith(
      'sess-1',
      { status: undefined, assignee: undefined, division: undefined, q: undefined },
      'key-1',
    );
    expect(chatScope.filter).toHaveBeenCalledWith(apiKey, all, expect.any(Function));
    expect(out).toEqual(visible);
  });

  it('passes a known status and the page through', async () => {
    const { controller, inbox } = makeConversationController();

    await controller.list('sess-1', undefined, 'pending', 'me', 'div-1', 'acme', '1', '1');

    expect(inbox.listAll).toHaveBeenCalledWith(
      'sess-1',
      { status: 'pending', assignee: 'me', division: 'div-1', q: 'acme' },
      undefined,
    );
  });

  it('refuses an unknown status instead of ignoring the filter', async () => {
    const { controller, inbox } = makeConversationController();

    await expect(controller.list('sess-1', undefined, 'archived')).rejects.toThrow(BadRequestException);
    expect(inbox.listAll).not.toHaveBeenCalled();
  });

  it.each([
    ['0', 50],
    ['-2', 50],
    ['x', 50],
    ['999', 200],
  ])('clamps limit %s to %i', async (limit, expected) => {
    const { controller, chatScope } = makeConversationController();
    chatScope.filter.mockResolvedValue(new Array(250).fill(0).map((_, index) => ({ chatId: `c${index}@c.us` })));

    const out = await controller.list('sess-1', undefined, undefined, undefined, undefined, undefined, limit);

    expect(out).toHaveLength(expected);
  });

  it.each([
    ['-3', 0],
    ['x', 0],
    ['2', 2],
  ])('clamps offset %s to %i', async (offset, expected) => {
    const { controller, chatScope } = makeConversationController();
    chatScope.filter.mockResolvedValue(new Array(250).fill(0).map((_, index) => ({ chatId: `c${index}@c.us` })));

    const out = await controller.list('sess-1', undefined, undefined, undefined, undefined, undefined, '1', offset);

    expect(out).toHaveLength(1);
    expect((out[0] as { chatId: string }).chatId).toBe(`c${expected}@c.us`);
  });
});

describe('InboxController.summary', () => {
  it('summarises only the visible conversations', async () => {
    const { controller, inbox, visible, apiKey } = makeConversationController();

    const out = await controller.summary('sess-1', apiKey);

    expect(inbox.summarize).toHaveBeenCalledWith(visible, 'key-1');
    expect(out).toEqual({ open: 1 });
  });
});

describe('InboxController conversation routes', () => {
  it('reads one conversation', async () => {
    const { controller, inbox } = makeConversationController();

    await controller.get('sess-1', 'allowed@c.us');

    expect(inbox.get).toHaveBeenCalledWith('sess-1', 'allowed@c.us');
  });

  it('updates a conversation with the caller key', async () => {
    const { controller, inbox, apiKey } = makeConversationController();
    const dto = { status: 'resolved' };

    await controller.update('sess-1', 'allowed@c.us', dto as never, apiKey);

    expect(inbox.update).toHaveBeenCalledWith('sess-1', 'allowed@c.us', dto, apiKey);
  });

  it('refuses an empty conversation update', async () => {
    const { controller, inbox, apiKey } = makeConversationController();

    await expect(controller.update('sess-1', 'allowed@c.us', {}, apiKey)).rejects.toThrow(BadRequestException);
    expect(inbox.update).not.toHaveBeenCalled();
  });

  it('adds a note', async () => {
    const { controller, inbox, apiKey } = makeConversationController();

    await controller.addNote('sess-1', 'allowed@c.us', { body: 'called back' }, apiKey);

    expect(inbox.addNote).toHaveBeenCalledWith('sess-1', 'allowed@c.us', 'called back', apiKey);
  });

  it('deletes a note', async () => {
    const { controller, inbox, apiKey } = makeConversationController();

    await controller.deleteNote('sess-1', 'allowed@c.us', 'note-1', apiKey);

    expect(inbox.deleteNote).toHaveBeenCalledWith('sess-1', 'allowed@c.us', 'note-1', apiKey);
  });
});
