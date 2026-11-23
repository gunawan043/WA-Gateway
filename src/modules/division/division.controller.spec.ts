import { DivisionController } from './division.controller';
import type { DivisionService } from './division.service';
import type { ApiKey } from '../auth/entities/api-key.entity';

/**
 * Routing configuration is admin-only, and the only thing the controller adds to the service is
 * passing the caller's key through so the audit trail names the actor. `settings` must also never be
 * parsed as a division id, which the route order pins and the `updateSettings` case below exercises.
 */
function makeController() {
  const divisions = {
    list: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({}),
    getSettings: jest.fn().mockResolvedValue({}),
    updateSettings: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const controller = new DivisionController(divisions as unknown as DivisionService);
  const apiKey = { id: 'key-1', name: 'Rina' } as ApiKey;
  return { controller, divisions, apiKey };
}

describe('DivisionController', () => {
  it('lists the divisions of a session', async () => {
    const { controller, divisions } = makeController();

    await controller.list('sess-1');

    expect(divisions.list).toHaveBeenCalledWith('sess-1');
  });

  it('creates with the caller key', async () => {
    const { controller, divisions, apiKey } = makeController();
    const dto = { name: 'Sales', keyword: '1' };

    await controller.create('sess-1', dto, apiKey);

    expect(divisions.create).toHaveBeenCalledWith('sess-1', dto, apiKey);
  });

  it('creates without a key too, because the route is reachable by a master key', async () => {
    const { controller, divisions } = makeController();

    await controller.create('sess-1', { name: 'Sales', keyword: '1' } as never);

    expect(divisions.create).toHaveBeenCalledWith('sess-1', { name: 'Sales', keyword: '1' }, undefined);
  });

  it('reads the session settings without touching the division list', async () => {
    const { controller, divisions } = makeController();

    await controller.getSettings('sess-1');

    expect(divisions.getSettings).toHaveBeenCalledWith('sess-1');
    expect(divisions.list).not.toHaveBeenCalled();
  });

  it('updates the settings and keeps the caller key', async () => {
    const { controller, divisions, apiKey } = makeController();

    await controller.updateSettings('sess-1', { fallbackDivisionId: 'div-2' } as never, apiKey);

    expect(divisions.updateSettings).toHaveBeenCalledWith('sess-1', { fallbackDivisionId: 'div-2' }, apiKey);
    expect(divisions.update).not.toHaveBeenCalled();
  });

  it('updates a division by id', async () => {
    const { controller, divisions, apiKey } = makeController();

    await controller.update('sess-1', 'div-1', { name: 'Sales 2' }, apiKey);

    expect(divisions.update).toHaveBeenCalledWith('sess-1', 'div-1', { name: 'Sales 2' }, apiKey);
  });

  it('deletes a division', async () => {
    const { controller, divisions, apiKey } = makeController();

    await controller.remove('sess-1', 'div-1', apiKey);

    expect(divisions.remove).toHaveBeenCalledWith('sess-1', 'div-1', apiKey);
  });
});
