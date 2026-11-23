import { BadRequestException } from '@nestjs/common';
import { CrmController } from './crm.controller';
import type { CrmService } from './crm.service';
import type { ApiKey } from '../auth/entities/api-key.entity';

/**
 * The pipeline controller owns two things: it validates the `status` query and it refuses an empty
 * patch, then hands everything to the service with the caller's key. Both are pinned here because a
 * silent fallback would let a client believe it filtered when it did not.
 */
function makeController() {
  const crm = {
    board: jest.fn().mockResolvedValue({}),
    listStages: jest.fn().mockResolvedValue([]),
    updateStage: jest.fn().mockResolvedValue({}),
    listDeals: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({}),
    get: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
    remove: jest.fn().mockResolvedValue(undefined),
    addActivity: jest.fn().mockResolvedValue({}),
  };
  const controller = new CrmController(crm as unknown as CrmService);
  const apiKey = { id: 'key-1', name: 'Rina' } as ApiKey;
  return { controller, crm, apiKey };
}

describe('CrmController read routes', () => {
  it('reads the board and the stages', async () => {
    const { controller, crm } = makeController();

    await controller.board();
    await controller.listStages();

    expect(crm.board).toHaveBeenCalledTimes(1);
    expect(crm.listStages).toHaveBeenCalledTimes(1);
  });

  it('lists deals with the default page and the caller key id', async () => {
    const { controller, crm, apiKey } = makeController();

    await controller.list(apiKey, undefined, undefined, undefined, undefined, undefined, undefined);

    expect(crm.listDeals).toHaveBeenCalledWith(
      { status: undefined, stageId: undefined, assignee: undefined, q: undefined },
      50,
      0,
      'key-1',
    );
  });

  it('passes the filters and the page through', async () => {
    const { controller, crm } = makeController();

    await controller.list(undefined, 'won', 'stg-1', 'me', 'acme', '10', '5');

    expect(crm.listDeals).toHaveBeenCalledWith(
      { status: 'won', stageId: 'stg-1', assignee: 'me', q: 'acme' },
      10,
      5,
      undefined,
    );
  });

  it('refuses an unknown status', async () => {
    const { controller, crm } = makeController();

    await expect(
      controller.list(undefined, 'archived', undefined, undefined, undefined, undefined, undefined),
    ).rejects.toThrow(BadRequestException);
    expect(crm.listDeals).not.toHaveBeenCalled();
  });

  it.each([
    ['0', 50],
    ['-1', 50],
    ['x', 50],
    ['999', 200],
  ])('clamps limit %s to %i', async (limit, expected) => {
    const { controller, crm } = makeController();

    await controller.list(undefined, undefined, undefined, undefined, undefined, limit, undefined);

    expect(crm.listDeals).toHaveBeenCalledWith(expect.anything(), expected, 0, undefined);
  });

  it.each([
    ['-4', 0],
    ['x', 0],
    ['4', 4],
  ])('clamps offset %s to %i', async (offset, expected) => {
    const { controller, crm } = makeController();

    await controller.list(undefined, undefined, undefined, undefined, undefined, undefined, offset);

    expect(crm.listDeals).toHaveBeenCalledWith(expect.anything(), 50, expected, undefined);
  });

  it('reads one deal', async () => {
    const { controller, crm } = makeController();

    await controller.get('deal-1');

    expect(crm.get).toHaveBeenCalledWith('deal-1');
  });
});

describe('CrmController write routes', () => {
  it('creates, updates, deletes and appends activity with the caller key', async () => {
    const { controller, crm, apiKey } = makeController();

    await controller.create({ title: 'Acme' }, apiKey);
    await controller.update('deal-1', { title: 'Acme 2' }, apiKey);
    await controller.remove('deal-1', apiKey);
    await controller.addActivity('deal-1', { type: 'note', body: 'called' } as never, apiKey);

    expect(crm.create).toHaveBeenCalledWith({ title: 'Acme' }, apiKey);
    expect(crm.update).toHaveBeenCalledWith('deal-1', { title: 'Acme 2' }, apiKey);
    expect(crm.remove).toHaveBeenCalledWith('deal-1', apiKey);
    expect(crm.addActivity).toHaveBeenCalledWith('deal-1', { type: 'note', body: 'called' }, apiKey);
  });

  it('refuses an empty deal patch', async () => {
    const { controller, crm, apiKey } = makeController();

    await expect(controller.update('deal-1', {}, apiKey)).rejects.toThrow(BadRequestException);
    expect(crm.update).not.toHaveBeenCalled();
  });

  it('updates a stage when at least one field is present', async () => {
    const { controller, crm } = makeController();

    await controller.updateStage('stg-1', { position: 3 });

    expect(crm.updateStage).toHaveBeenCalledWith('stg-1', { position: 3 });
  });

  it('refuses an empty stage patch', async () => {
    const { controller, crm } = makeController();

    await expect(controller.updateStage('stg-1', {})).rejects.toThrow(BadRequestException);
    expect(crm.updateStage).not.toHaveBeenCalled();
  });
});
