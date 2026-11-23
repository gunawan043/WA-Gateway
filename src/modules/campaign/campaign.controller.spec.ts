import { BadRequestException } from '@nestjs/common';
import { CampaignController } from './campaign.controller';
import type { CampaignService } from './campaign.service';
import type { CampaignRunnerService } from './campaign-runner.service';
import type { ApiKey } from '../auth/entities/api-key.entity';

/**
 * The controller is a thin delegator, so these tests pin the two things it actually owns: the query
 * parsing (a bad `status` is a 400, a silly `limit` falls back to the default) and that each route
 * reaches the right service method with the caller's key. The service has its own spec; nothing here
 * re-tests it.
 */
function makeController() {
  const campaigns = {
    list: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({}),
    listSegments: jest.fn().mockResolvedValue([]),
    createSegment: jest.fn().mockResolvedValue({}),
    updateSegment: jest.fn().mockResolvedValue({}),
    removeSegment: jest.fn().mockResolvedValue(undefined),
    preview: jest.fn().mockResolvedValue({}),
    get: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
    remove: jest.fn().mockResolvedValue(undefined),
    listRecipients: jest.fn().mockResolvedValue([]),
  };
  const runner = {
    start: jest.fn().mockResolvedValue({}),
    cancel: jest.fn().mockResolvedValue({}),
  };
  const controller = new CampaignController(
    campaigns as unknown as CampaignService,
    runner as unknown as CampaignRunnerService,
  );
  const apiKey = { id: 'key-1', name: 'Rina' } as ApiKey;
  return { controller, campaigns, runner, apiKey };
}

describe('CampaignController.list', () => {
  it('defaults the page and passes no status through', async () => {
    const { controller, campaigns } = makeController();

    await controller.list('sess-1', undefined, undefined, undefined);

    expect(campaigns.list).toHaveBeenCalledWith('sess-1', undefined, 50, 0);
  });

  it('passes a known status through', async () => {
    const { controller, campaigns } = makeController();

    await controller.list('sess-1', 'running', '10', '20');

    expect(campaigns.list).toHaveBeenCalledWith('sess-1', 'running', 10, 20);
  });

  it('refuses an unknown status instead of ignoring it', async () => {
    const { controller, campaigns } = makeController();

    await expect(controller.list('sess-1', 'paused', undefined, undefined)).rejects.toThrow(BadRequestException);
    expect(campaigns.list).not.toHaveBeenCalled();
  });

  it.each([
    ['0', 50],
    ['-3', 50],
    ['not-a-number', 50],
    ['500', 200],
    ['1', 1],
  ])('clamps limit %s to %i', async (limit, expected) => {
    const { controller, campaigns } = makeController();

    await controller.list('sess-1', undefined, limit, undefined);

    expect(campaigns.list).toHaveBeenCalledWith('sess-1', undefined, expected, 0);
  });

  it.each([
    ['-10', 0],
    ['abc', 0],
    ['0', 0],
    ['7', 7],
  ])('clamps offset %s to %i', async (offset, expected) => {
    const { controller, campaigns } = makeController();

    await controller.list('sess-1', undefined, undefined, offset);

    expect(campaigns.list).toHaveBeenCalledWith('sess-1', undefined, 50, expected);
  });
});

describe('CampaignController.write routes', () => {
  it('creates with the caller key', async () => {
    const { controller, campaigns, apiKey } = makeController();
    const dto = { name: 'Promo' };

    await controller.create('sess-1', dto as never, apiKey);

    expect(campaigns.create).toHaveBeenCalledWith('sess-1', dto, apiKey);
  });

  it('lists, creates, updates and removes segments', async () => {
    const { controller, campaigns } = makeController();

    await controller.listSegments('sess-1');
    await controller.createSegment('sess-1', { name: 'VIP' } as never);
    await controller.updateSegment('sess-1', 'seg-1', { name: 'VIP 2' });
    await controller.removeSegment('sess-1', 'seg-1');

    expect(campaigns.listSegments).toHaveBeenCalledWith('sess-1');
    expect(campaigns.createSegment).toHaveBeenCalledWith('sess-1', { name: 'VIP' });
    expect(campaigns.updateSegment).toHaveBeenCalledWith('sess-1', 'seg-1', { name: 'VIP 2' });
    expect(campaigns.removeSegment).toHaveBeenCalledWith('sess-1', 'seg-1');
  });

  it('accepts a chatIds-only segment update', async () => {
    const { controller, campaigns } = makeController();

    await controller.updateSegment('sess-1', 'seg-1', { chatIds: ['a@c.us'] });

    expect(campaigns.updateSegment).toHaveBeenCalledWith('sess-1', 'seg-1', { chatIds: ['a@c.us'] });
  });

  it('refuses an empty segment update', async () => {
    const { controller, campaigns } = makeController();

    await expect(controller.updateSegment('sess-1', 'seg-1', {})).rejects.toThrow(BadRequestException);
    expect(campaigns.updateSegment).not.toHaveBeenCalled();
  });

  it('previews an audience without saving it', async () => {
    const { controller, campaigns } = makeController();
    const dto = { audience: { type: 'all' } };

    await controller.preview('sess-1', dto as never);

    expect(campaigns.preview).toHaveBeenCalledWith('sess-1', dto);
  });

  it('reads one campaign', async () => {
    const { controller, campaigns } = makeController();

    await controller.get('sess-1', 'cmp-1');

    expect(campaigns.get).toHaveBeenCalledWith('sess-1', 'cmp-1');
  });

  it('updates when at least one field is present', async () => {
    const { controller, campaigns } = makeController();
    const dto = { name: 'Renamed' };

    await controller.update('sess-1', 'cmp-1', dto);

    expect(campaigns.update).toHaveBeenCalledWith('sess-1', 'cmp-1', dto);
  });

  it('refuses an empty update', async () => {
    const { controller, campaigns } = makeController();

    await expect(controller.update('sess-1', 'cmp-1', {})).rejects.toThrow(BadRequestException);
    expect(campaigns.update).not.toHaveBeenCalled();
  });

  it('deletes with the caller key', async () => {
    const { controller, campaigns, apiKey } = makeController();

    await controller.remove('sess-1', 'cmp-1', apiKey);

    expect(campaigns.remove).toHaveBeenCalledWith('sess-1', 'cmp-1', apiKey);
  });

  it('starts and cancels through the runner, not the service', async () => {
    const { controller, campaigns, runner, apiKey } = makeController();

    await controller.start('sess-1', 'cmp-1', apiKey);
    await controller.cancel('sess-1', 'cmp-1', apiKey);

    expect(runner.start).toHaveBeenCalledWith('sess-1', 'cmp-1', apiKey);
    expect(runner.cancel).toHaveBeenCalledWith('sess-1', 'cmp-1', apiKey);
    expect(campaigns.update).not.toHaveBeenCalled();
  });
});

describe('CampaignController.listRecipients', () => {
  it('defaults the page and passes no status through', async () => {
    const { controller, campaigns } = makeController();

    await controller.listRecipients('sess-1', 'cmp-1', undefined, undefined, undefined);

    expect(campaigns.listRecipients).toHaveBeenCalledWith('sess-1', 'cmp-1', undefined, 50, 0);
  });

  it('passes a known recipient status and page through', async () => {
    const { controller, campaigns } = makeController();

    await controller.listRecipients('sess-1', 'cmp-1', 'failed', '5', '10');

    expect(campaigns.listRecipients).toHaveBeenCalledWith('sess-1', 'cmp-1', 'failed', 5, 10);
  });

  it('refuses an unknown recipient status', async () => {
    const { controller, campaigns } = makeController();

    await expect(controller.listRecipients('sess-1', 'cmp-1', 'queued', undefined, undefined)).rejects.toThrow(
      BadRequestException,
    );
    expect(campaigns.listRecipients).not.toHaveBeenCalled();
  });
});
