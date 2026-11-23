import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AuditAction } from '../audit/entities/audit-log.entity';
import type { ApiKey } from '../auth/entities/api-key.entity';
import { CampaignService, DEFAULT_CAMPAIGN_OPTIONS } from './campaign.service';
import { CAMPAIGN_AUDIENCE_MAX } from './dto/campaign.dto';
import type { Campaign, CampaignStatus } from './entities/campaign.entity';

const ACTOR = { id: 'key-1', name: 'Operator' } as ApiKey;

/** A stored campaign row, with the timestamps `toDto` reads. */
function campaignRow(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: 'camp-1',
    sessionId: 'sess-1',
    name: 'Promo',
    status: 'draft',
    content: { type: 'text', content: { text: 'Halo' } },
    options: { ...DEFAULT_CAMPAIGN_OPTIONS },
    audience: { kind: 'manual', chatIds: ['628111@c.us'] },
    progress: { total: 0, sent: 0, failed: 0, skipped: 0 },
    scheduledAt: null,
    startedAt: null,
    completedAt: null,
    createdByKeyId: 'key-1',
    createdByName: 'Operator',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  };
}

function makeService() {
  const campaigns = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((row: unknown) => row),
    save: jest.fn((row: Record<string, unknown>) => Promise.resolve(campaignRow(row as Partial<Campaign>))),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const recipients = { find: jest.fn().mockResolvedValue([]) };
  const segments = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((row: unknown) => row),
    save: jest.fn((row: Record<string, unknown>) =>
      Promise.resolve({ id: 'seg-1', createdAt: new Date(), updatedAt: new Date(), ...row }),
    ),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const sessionService = {
    findOne: jest.fn().mockResolvedValue({ id: 'sess-1' }),
    listChats: jest.fn().mockResolvedValue([]),
  };
  const labelService = { getChatsByLabel: jest.fn().mockResolvedValue([]) };
  const audit = { logInfo: jest.fn().mockResolvedValue(null) };

  const service = new CampaignService(
    campaigns as never,
    recipients as never,
    segments as never,
    sessionService as never,
    labelService as never,
    audit as never,
  );
  return { service, campaigns, recipients, segments, sessionService, labelService, audit };
}

const textContent = { type: 'text', content: { text: 'Halo' } } as never;

describe('CampaignService listing', () => {
  it('checks the session and filters by status when one is given', async () => {
    const { service, campaigns, sessionService } = makeService();
    campaigns.find.mockResolvedValueOnce([campaignRow({ status: 'scheduled' })]);

    const rows = await service.list('sess-1', 'scheduled', 10, 5);

    expect(sessionService.findOne).toHaveBeenCalledWith('sess-1');
    expect(campaigns.find).toHaveBeenCalledWith({
      where: { sessionId: 'sess-1', status: 'scheduled' },
      order: { createdAt: 'DESC' },
      skip: 5,
      take: 10,
    });
    expect(rows[0]).toMatchObject({ id: 'camp-1', status: 'scheduled' });
  });

  it('omits the status predicate when the caller did not ask for one', async () => {
    const { service, campaigns } = makeService();

    await service.list('sess-1', undefined, 20, 0);

    expect(campaigns.find).toHaveBeenCalledWith(expect.objectContaining({ where: { sessionId: 'sess-1' } }));
  });

  it('refuses a campaign that belongs to another session', async () => {
    const { service } = makeService();

    await expect(service.findOne('sess-1', 'camp-9')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns the detail with at most 50 recipients, oldest first', async () => {
    const { service, campaigns, recipients } = makeService();
    campaigns.findOne.mockResolvedValueOnce(campaignRow());
    recipients.find.mockResolvedValueOnce([
      {
        chatId: '628111@c.us',
        chatName: 'Budi',
        status: 'sent',
        messageId: 'wamid.1',
        errorCode: null,
        errorMessage: null,
        sentAt: new Date('2026-01-03T00:00:00.000Z'),
      },
      {
        chatId: '628222@c.us',
        chatName: null,
        status: 'pending',
        messageId: null,
        errorCode: null,
        errorMessage: null,
        sentAt: null,
      },
    ]);

    const detail = await service.get('sess-1', 'camp-1');

    expect(recipients.find).toHaveBeenCalledWith({
      where: { campaignId: 'camp-1' },
      order: { createdAt: 'ASC' },
      take: 50,
    });
    expect(detail.recipients).toEqual([
      expect.objectContaining({ chatId: '628111@c.us', sentAt: '2026-01-03T00:00:00.000Z' }),
      expect.objectContaining({ chatId: '628222@c.us', sentAt: null }),
    ]);
  });

  it('serialises a stored campaign, nulling every unset timestamp', () => {
    const { service } = makeService();

    const dto = service.toDto(
      campaignRow({ startedAt: new Date('2026-01-04T00:00:00.000Z'), completedAt: null, scheduledAt: null }),
    );

    expect(dto).toMatchObject({
      scheduledAt: null,
      startedAt: '2026-01-04T00:00:00.000Z',
      completedAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
  });
});

describe('CampaignService create', () => {
  it('stores a draft with default options and a zeroed progress', async () => {
    const { service, campaigns, sessionService } = makeService();

    const dto = await service.create(
      'sess-1',
      { name: '  Promo  ', content: textContent, audience: { kind: 'manual', chatIds: ['628111@c.us'] } } as never,
      ACTOR,
    );

    expect(sessionService.findOne).toHaveBeenCalledWith('sess-1');
    expect(campaigns.create).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-1',
        name: 'Promo',
        status: 'draft',
        options: DEFAULT_CAMPAIGN_OPTIONS,
        progress: { total: 0, sent: 0, failed: 0, skipped: 0 },
        scheduledAt: null,
        createdByKeyId: 'key-1',
        createdByName: 'Operator',
      }),
    );
    expect(dto.id).toBe('camp-1');
  });

  it('marks a campaign scheduled when a start time is given', async () => {
    const { service, campaigns } = makeService();

    await service.create(
      'sess-1',
      {
        name: 'Promo',
        content: textContent,
        audience: { kind: 'manual', chatIds: ['628111@c.us'] },
        scheduledAt: '2026-02-01T09:00:00.000Z',
      } as never,
      ACTOR,
    );

    expect(campaigns.create).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'scheduled', scheduledAt: new Date('2026-02-01T09:00:00.000Z') }),
    );
  });

  it('keeps the campaign a draft when the start time cannot be parsed', async () => {
    const { service, campaigns } = makeService();

    await service.create(
      'sess-1',
      {
        name: 'Promo',
        content: textContent,
        audience: { kind: 'manual', chatIds: ['628111@c.us'] },
        scheduledAt: 'not-a-date',
      } as never,
      ACTOR,
    );

    expect(campaigns.create).toHaveBeenCalledWith(expect.objectContaining({ status: 'draft', scheduledAt: null }));
  });

  it('refuses text content with no body', async () => {
    const { service, campaigns } = makeService();

    await expect(
      service.create('sess-1', { name: 'Promo', content: { type: 'text', content: { text: '   ' } } } as never, ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(campaigns.save).not.toHaveBeenCalled();
  });

  it('refuses media content of the named type that has no file', async () => {
    const { service } = makeService();

    await expect(
      service.create('sess-1', { name: 'Promo', content: { type: 'image', content: {} } } as never, ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a manual audience with no chats', async () => {
    const { service } = makeService();

    await expect(
      service.create(
        'sess-1',
        { name: 'Promo', content: textContent, audience: { kind: 'manual', chatIds: [] } } as never,
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('keeps only the field the chosen audience kind uses', async () => {
    const { service, campaigns } = makeService();

    await service.create(
      'sess-1',
      {
        name: 'Promo',
        content: textContent,
        audience: { kind: 'segment', segmentId: '11111111-1111-4111-8111-111111111111', chatIds: ['628111@c.us'] },
      } as never,
      ACTOR,
    );

    expect(campaigns.create).toHaveBeenCalledWith(
      expect.objectContaining({
        audience: { kind: 'segment', segmentId: '11111111-1111-4111-8111-111111111111' },
      }),
    );
  });
});

describe('CampaignService update and delete', () => {
  it('refuses to edit a campaign that has already run', async () => {
    const { service, campaigns } = makeService();
    campaigns.findOne.mockResolvedValueOnce(campaignRow({ status: 'completed' }));

    await expect(service.update('sess-1', 'camp-1', { name: 'Baru' })).rejects.toBeInstanceOf(BadRequestException);
    expect(campaigns.save).not.toHaveBeenCalled();
  });

  it('applies name, content, options and audience, trimming the name', async () => {
    const { service, campaigns } = makeService();
    campaigns.findOne.mockResolvedValueOnce(campaignRow());

    await service.update('sess-1', 'camp-1', {
      name: '  Baru  ',
      content: { type: 'text', content: { text: 'Hai' } },
      options: { delayBetweenMessages: 5000 },
      audience: { kind: 'all' },
    } as never);

    expect(campaigns.save).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Baru',
        content: { type: 'text', content: { text: 'Hai' } },
        options: { delayBetweenMessages: 5000, randomizeDelay: true, stopOnError: false },
        audience: { kind: 'all' },
      }),
    );
  });

  it('moves a scheduled campaign back to draft when the start time is cleared', async () => {
    const { service, campaigns } = makeService();
    campaigns.findOne.mockResolvedValueOnce(campaignRow({ status: 'scheduled', scheduledAt: new Date() }));

    await service.update('sess-1', 'camp-1', { scheduledAt: null });

    expect(campaigns.save).toHaveBeenCalledWith(expect.objectContaining({ status: 'draft', scheduledAt: null }));
  });

  it('moves a draft to scheduled when a start time is set', async () => {
    const { service, campaigns } = makeService();
    campaigns.findOne.mockResolvedValueOnce(campaignRow());

    await service.update('sess-1', 'camp-1', { scheduledAt: '2026-03-01T00:00:00.000Z' });

    expect(campaigns.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'scheduled', scheduledAt: new Date('2026-03-01T00:00:00.000Z') }),
    );
  });

  it('refuses to delete a completed run and audits a real deletion', async () => {
    const { service, campaigns, audit } = makeService();
    campaigns.findOne.mockResolvedValueOnce(campaignRow({ status: 'completed' }));

    await expect(service.remove('sess-1', 'camp-1', ACTOR)).rejects.toBeInstanceOf(BadRequestException);
    expect(campaigns.remove).not.toHaveBeenCalled();

    const deletable = campaignRow({ status: 'cancelled' });
    campaigns.findOne.mockResolvedValueOnce(deletable);
    await service.remove('sess-1', 'camp-1', ACTOR);

    expect(campaigns.remove).toHaveBeenCalledWith(deletable);
    expect(audit.logInfo).toHaveBeenCalledWith(
      AuditAction.CAMPAIGN_DELETED,
      expect.objectContaining({
        apiKey: ACTOR,
        sessionId: 'sess-1',
        metadata: { campaignId: 'camp-1', name: 'Promo', status: 'cancelled' },
      }),
    );
  });

  it('lists recipients with the status filter and pagination', async () => {
    const { service, campaigns, recipients } = makeService();
    campaigns.findOne.mockResolvedValueOnce(campaignRow());

    await service.listRecipients('sess-1', 'camp-1', 'failed', 25, 50);

    expect(recipients.find).toHaveBeenCalledWith({
      where: { campaignId: 'camp-1', status: 'failed' },
      order: { createdAt: 'ASC' },
      skip: 50,
      take: 25,
    });
  });
});

describe('CampaignService audience resolution', () => {
  it('dedupes a manual audience and fills in the known chat name', async () => {
    const { service, sessionService } = makeService();
    sessionService.listChats.mockResolvedValueOnce([{ id: '628111@c.us', name: 'Budi' }]);

    const resolved = await service.resolveAudience('sess-1', {
      kind: 'manual',
      chatIds: ['628111@c.us', '628111@c.us'],
    });

    expect(resolved).toEqual({ chats: [{ chatId: '628111@c.us', chatName: 'Budi' }], truncated: false });
  });

  it('accepts a manual audience when the session knows no chats yet', async () => {
    const { service } = makeService();

    const resolved = await service.resolveAudience('sess-1', { kind: 'manual', chatIds: ['628999@c.us'] });

    expect(resolved.chats).toEqual([{ chatId: '628999@c.us', chatName: null }]);
  });

  it('names up to five unknown chats and counts the rest', async () => {
    const { service, sessionService } = makeService();
    sessionService.listChats.mockResolvedValueOnce([{ id: '628111@c.us', name: 'Budi' }]);

    await expect(
      service.resolveAudience('sess-1', {
        kind: 'manual',
        chatIds: ['a@c.us', 'b@c.us', 'c@c.us', 'd@c.us', 'e@c.us', 'f@c.us', 'g@c.us'],
      }),
    ).rejects.toThrow('a@c.us, b@c.us, c@c.us, d@c.us, e@c.us and 2 more');
  });

  it('refuses an empty manual audience', async () => {
    const { service } = makeService();

    await expect(service.resolveAudience('sess-1', { kind: 'manual', chatIds: [] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('drops segment members the session no longer knows, and refuses an empty result', async () => {
    const { service, segments, sessionService } = makeService();
    sessionService.listChats.mockResolvedValue([{ id: '628111@c.us', name: null }]);
    segments.findOne.mockResolvedValueOnce({
      id: 'seg-1',
      sessionId: 'sess-1',
      name: 'Seg',
      chatIds: ['628111@c.us', '628999@c.us'],
    });

    const resolved = await service.resolveAudience('sess-1', {
      kind: 'segment',
      segmentId: '11111111-1111-4111-8111-111111111111',
    });
    expect(resolved.chats).toEqual([{ chatId: '628111@c.us', chatName: null }]);

    segments.findOne.mockResolvedValueOnce({ id: 'seg-1', sessionId: 'sess-1', name: 'Seg', chatIds: ['628999@c.us'] });
    await expect(
      service.resolveAudience('sess-1', { kind: 'segment', segmentId: '11111111-1111-4111-8111-111111111111' }),
    ).rejects.toThrow('The segment resolves to no chats in this session');
  });

  it('refuses a segment audience without a segmentId', async () => {
    const { service } = makeService();

    await expect(service.resolveAudience('sess-1', { kind: 'segment' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('resolves every chat of the session, with a null name when unnamed', async () => {
    const { service, sessionService } = makeService();
    sessionService.listChats.mockResolvedValueOnce([
      { id: '628111@c.us', name: 'Budi' },
      { id: '628222@c.us', name: '' },
    ]);

    const resolved = await service.resolveAudience('sess-1', { kind: 'all' });

    expect(resolved.chats).toEqual([
      { chatId: '628111@c.us', chatName: 'Budi' },
      { chatId: '628222@c.us', chatName: null },
    ]);
  });

  it('delegates a label audience to the label service and requires a labelId', async () => {
    const { service, labelService } = makeService();
    labelService.getChatsByLabel.mockResolvedValueOnce([{ id: '628111@c.us', name: 'Budi' }]);

    const resolved = await service.resolveAudience('sess-1', { kind: 'label', labelId: 'lbl-1' });
    expect(labelService.getChatsByLabel).toHaveBeenCalledWith('sess-1', 'lbl-1');
    expect(resolved.chats).toEqual([{ chatId: '628111@c.us', chatName: 'Budi' }]);

    await expect(service.resolveAudience('sess-1', { kind: 'label' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('caps the audience at the configured maximum and reports the truncation', async () => {
    const { service, sessionService } = makeService();
    sessionService.listChats.mockResolvedValueOnce(
      Array.from({ length: CAMPAIGN_AUDIENCE_MAX + 1 }, (_, index) => ({ id: `628${index}@c.us`, name: null })),
    );

    const resolved = await service.resolveAudience('sess-1', { kind: 'all' });

    expect(resolved.chats).toHaveLength(CAMPAIGN_AUDIENCE_MAX);
    expect(resolved.truncated).toBe(true);
  });

  it('previews the first 20 by default and honours a smaller sample', async () => {
    const { service, sessionService } = makeService();
    const chats = Array.from({ length: 30 }, (_, index) => ({ id: `628${index}@c.us`, name: null }));
    sessionService.listChats.mockResolvedValue(chats);

    const preview = await service.preview('sess-1', { audience: { kind: 'all' } });
    expect(preview.count).toBe(30);
    expect(preview.sample).toHaveLength(20);
    expect(preview.truncated).toBe(false);

    const smaller = await service.preview('sess-1', { audience: { kind: 'all' }, sampleSize: 5 });
    expect(smaller.sample).toHaveLength(5);
  });
});

describe('CampaignService segments', () => {
  it('lists segments for the session, newest first', async () => {
    const { service, segments, sessionService } = makeService();
    segments.find.mockResolvedValueOnce([
      { id: 'seg-1', name: 'Seg', chatIds: ['628111@c.us'], createdAt: new Date(), updatedAt: new Date() },
    ]);

    const rows = await service.listSegments('sess-1');

    expect(sessionService.findOne).toHaveBeenCalledWith('sess-1');
    expect(segments.find).toHaveBeenCalledWith({ where: { sessionId: 'sess-1' }, order: { createdAt: 'DESC' } });
    expect(rows[0]).toMatchObject({ id: 'seg-1', chatIds: ['628111@c.us'] });
  });

  it('dedupes segment members and refuses an empty segment', async () => {
    const { service, segments } = makeService();

    const created = await service.createSegment('sess-1', { name: '  Seg  ', chatIds: ['628111@c.us', '628111@c.us'] });
    expect(segments.create).toHaveBeenCalledWith({ sessionId: 'sess-1', name: 'Seg', chatIds: ['628111@c.us'] });
    expect(created.id).toBe('seg-1');

    await expect(service.createSegment('sess-1', { name: 'Seg', chatIds: [] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('updates a segment name and member list, refusing an empty list', async () => {
    const { service, segments } = makeService();
    segments.findOne.mockResolvedValueOnce({
      id: 'seg-1',
      sessionId: 'sess-1',
      name: 'Lama',
      chatIds: ['628111@c.us'],
    });

    await service.updateSegment('sess-1', 'seg-1', { name: ' Baru ', chatIds: ['628222@c.us', '628222@c.us'] });
    expect(segments.save).toHaveBeenCalledWith(expect.objectContaining({ name: 'Baru', chatIds: ['628222@c.us'] }));

    segments.findOne.mockResolvedValueOnce({ id: 'seg-1', sessionId: 'sess-1', name: 'Baru', chatIds: [] });
    await expect(service.updateSegment('sess-1', 'seg-1', { chatIds: [] })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('removes a segment and refuses one that is not in the session', async () => {
    const { service, segments } = makeService();
    const segment = { id: 'seg-1', sessionId: 'sess-1', name: 'Seg', chatIds: [] };
    segments.findOne.mockResolvedValueOnce(segment);

    await service.removeSegment('sess-1', 'seg-1');
    expect(segments.remove).toHaveBeenCalledWith(segment);

    await expect(service.findSegment('sess-1', 'seg-9')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('CampaignService status boundaries', () => {
  it.each<CampaignStatus>(['draft', 'scheduled'])('allows editing a %s campaign', async status => {
    const { service, campaigns } = makeService();
    campaigns.findOne.mockResolvedValueOnce(campaignRow({ status }));

    await expect(service.update('sess-1', 'camp-1', { name: 'Baru' })).resolves.toMatchObject({
      id: 'camp-1',
    });
  });

  it.each<CampaignStatus>(['running', 'completed', 'failed'])('refuses editing a %s campaign', async status => {
    const { service, campaigns } = makeService();
    campaigns.findOne.mockResolvedValueOnce(campaignRow({ status }));

    await expect(service.update('sess-1', 'camp-1', { name: 'Baru' })).rejects.toBeInstanceOf(BadRequestException);
  });
});
