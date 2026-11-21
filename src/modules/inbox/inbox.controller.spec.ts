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
