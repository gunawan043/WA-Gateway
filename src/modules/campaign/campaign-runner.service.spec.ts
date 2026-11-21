import { BadRequestException } from '@nestjs/common';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { BatchMessageStatus, BatchStatus } from '../message/entities/message-batch.entity';
import { CampaignRunnerService } from './campaign-runner.service';
import { CampaignService } from './campaign.service';
import { CampaignRecipient } from './entities/campaign-recipient.entity';
import { Campaign } from './entities/campaign.entity';

const now = new Date('2026-11-20T10:00:00.000Z');

function campaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: 'cmp-1',
    sessionId: 'sess-1',
    name: 'Promo akhir tahun',
    status: 'draft',
    content: { type: 'text', content: { text: 'Halo {{name}}' } },
    options: { delayBetweenMessages: 3000, randomizeDelay: true, stopOnError: false },
    audience: { kind: 'manual', chatIds: ['628111@c.us', '628222@c.us'] },
    progress: { total: 0, sent: 0, failed: 0, skipped: 0 },
    scheduledAt: null,
    startedAt: null,
    completedAt: null,
    createdByKeyId: 'key-1',
    createdByName: 'Agen A',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function recipient(overrides: Partial<CampaignRecipient> = {}): CampaignRecipient {
  return {
    id: 'rcp-1',
    campaignId: 'cmp-1',
    chatId: '628111@c.us',
    chatName: 'Budi',
    status: 'pending',
    batchId: null,
    messageId: null,
    errorCode: null,
    errorMessage: null,
    sentAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as CampaignRecipient;
}

function makeRunner(initial: Campaign) {
  const state = { campaign: initial, recipients: [] as CampaignRecipient[] };

  const matches = (row: CampaignRecipient, where: Record<string, unknown>): boolean =>
    (where.campaignId === undefined || row.campaignId === where.campaignId) &&
    (where.status === undefined || row.status === where.status) &&
    (where.batchId === undefined || row.batchId === where.batchId);

  const campaigns = {
    findOne: jest.fn(() => Promise.resolve(state.campaign)),
    find: jest.fn((options?: { where?: { status?: string } }) =>
      Promise.resolve(options?.where?.status === state.campaign.status ? [state.campaign] : []),
    ),
    save: jest.fn((row: Campaign) => Promise.resolve(row)),
  };

  let recipientSeq = 0;
  const recipients = {
    find: jest.fn((options?: { where?: Record<string, unknown> }) =>
      Promise.resolve(state.recipients.filter(row => matches(row, options?.where ?? {}))),
    ),
    count: jest.fn((options?: { where?: Record<string, unknown> }) =>
      Promise.resolve(state.recipients.filter(row => matches(row, options?.where ?? {})).length),
    ),
    save: jest.fn((rows: CampaignRecipient[]) => Promise.resolve(rows)),
    update: jest.fn((criteria: Record<string, unknown>, patch: Partial<CampaignRecipient>) => {
      const idFilter = criteria.id as { value?: string[] } | undefined;
      const where = idFilter ? { ...criteria, id: undefined } : criteria;
      let affected = 0;
      for (const row of state.recipients) {
        if (idFilter && !(idFilter.value ?? []).includes(row.id)) continue;
        if (!matches(row, where)) continue;
        Object.assign(row, patch);
        affected++;
      }
      return Promise.resolve({ affected });
    }),
    create: jest.fn((row: Partial<CampaignRecipient>) => ({ ...recipient(), id: `rcp-${++recipientSeq}`, ...row })),
    createQueryBuilder: jest.fn(() => {
      let pending: CampaignRecipient[] = [];
      const chain = {
        insert: () => chain,
        values: (rows: CampaignRecipient[]) => {
          pending = rows;
          return chain;
        },
        orIgnore: () => chain,
        execute: () => {
          const known = new Set(state.recipients.map(row => row.chatId));
          for (const row of pending) if (!known.has(row.chatId)) state.recipients.push(row);
          return Promise.resolve({});
        },
      };
      return chain;
    }),
  };

  const campaignService = {
    findOne: jest.fn(() => Promise.resolve(state.campaign)),
    resolveAudience: jest.fn(() =>
      Promise.resolve({
        chats: [
          { chatId: '628111@c.us', chatName: 'Budi' },
          { chatId: '628222@c.us', chatName: null },
        ],
        truncated: false,
      }),
    ),
    toDto: jest.fn((row: Campaign) => ({ ...row })),
  };

  const bulk = {
    createBatch: jest.fn(() => Promise.resolve({ batchId: 'batch-1' })),
    getBatchStatus: jest.fn(() =>
      Promise.resolve({
        batchId: 'batch-1',
        status: BatchStatus.COMPLETED,
        results: [
          { chatId: '628111@c.us', status: BatchMessageStatus.SENT, messageId: 'm1', sentAt: now },
          { chatId: '628222@c.us', status: BatchMessageStatus.FAILED, error: { code: 'NO_WA', message: 'nope' } },
        ],
      }),
    ),
    cancelBatch: jest.fn(() => Promise.resolve({})),
  };

  const audit = { logInfo: jest.fn().mockResolvedValue(null) };
  const events = { emitCampaignUpdated: jest.fn() };

  const runner = new CampaignRunnerService(
    campaigns as never,
    recipients as never,
    campaignService as never,
    bulk as never,
    audit as never,
    events as never,
  );

  return { runner, state, campaigns, recipients, campaignService, bulk, audit, events };
}

/** Wait for every detached driver to settle. */
async function settle(runner: CampaignRunnerService): Promise<void> {
  const drivers = (runner as unknown as { drivers: Map<string, Promise<void>> }).drivers;
  for (let i = 0; i < 20 && drivers.size > 0; i++) {
    await Promise.all([...drivers.values()]);
  }
}

const actor = { id: 'key-1', name: 'Agen A' } as never;

describe('CampaignRunnerService.start', () => {
  it('resolves the audience, fills recipients and starts the driver', async () => {
    const { runner, state, recipients, campaignService, audit } = makeRunner(campaign());

    await runner.start('sess-1', 'cmp-1', actor);

    expect(campaignService.resolveAudience).toHaveBeenCalledWith('sess-1', {
      kind: 'manual',
      chatIds: ['628111@c.us', '628222@c.us'],
    });
    expect(state.recipients.map(row => row.chatId)).toEqual(['628111@c.us', '628222@c.us']);
    expect(state.campaign.status).toBe('running');
    expect(state.campaign.progress).toEqual({ total: 2, sent: 0, failed: 0, skipped: 0 });
    expect(recipients.update).not.toHaveBeenCalled();
    expect(audit.logInfo).toHaveBeenCalledWith(AuditAction.CAMPAIGN_STARTED, expect.anything());
  });

  it('is a no-op while the campaign is already running', async () => {
    const { runner, campaignService } = makeRunner(campaign({ status: 'running' }));

    await runner.start('sess-1', 'cmp-1', actor);

    expect(campaignService.resolveAudience).not.toHaveBeenCalled();
  });

  it('refuses a campaign that already ran', async () => {
    const { runner } = makeRunner(campaign({ status: 'completed' }));

    await expect(runner.start('sess-1', 'cmp-1', actor)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses an audience larger than the cap instead of sending to a subset', async () => {
    const { runner, campaignService } = makeRunner(campaign());
    campaignService.resolveAudience.mockResolvedValue({
      chats: [{ chatId: 'a@c.us', chatName: null }],
      truncated: true,
    });

    await expect(runner.start('sess-1', 'cmp-1', actor)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('CampaignRunnerService.cancel', () => {
  it('marks every unattempted recipient skipped and cancels the active batch', async () => {
    const { runner, state, bulk, audit } = makeRunner(campaign({ status: 'running' }));
    state.recipients.push(
      recipient({ id: 'r1', chatId: '628111@c.us', status: 'sent' }),
      recipient({ id: 'r2', chatId: '628222@c.us', status: 'pending' }),
    );
    (runner as unknown as { activeBatches: Map<string, string> }).activeBatches.set('cmp-1', 'batch-1');

    await runner.cancel('sess-1', 'cmp-1', actor);

    expect(state.campaign.status).toBe('cancelled');
    expect(state.recipients.map(row => row.status)).toEqual(['sent', 'skipped']);
    expect(state.recipients[1].errorCode).toBe('CAMPAIGN_CANCELLED');
    expect(state.campaign.progress).toEqual({ total: 2, sent: 1, failed: 0, skipped: 1 });
    expect(bulk.cancelBatch).toHaveBeenCalledWith('sess-1', 'batch-1');
    expect(audit.logInfo).toHaveBeenCalledWith(AuditAction.CAMPAIGN_CANCELLED, expect.anything());
  });

  it('is a no-op on an already-cancelled campaign', async () => {
    const { runner, bulk } = makeRunner(campaign({ status: 'cancelled' }));

    await runner.cancel('sess-1', 'cmp-1', actor);

    expect(bulk.cancelBatch).not.toHaveBeenCalled();
  });

  it('refuses a completed campaign', async () => {
    const { runner } = makeRunner(campaign({ status: 'completed' }));

    await expect(runner.cancel('sess-1', 'cmp-1', actor)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('CampaignRunnerService.drive', () => {
  it('records per-recipient outcomes and completes the campaign', async () => {
    const { runner, state, bulk, audit, events } = makeRunner(campaign());

    await runner.start('sess-1', 'cmp-1', actor);
    await settle(runner);

    expect(bulk.createBatch).toHaveBeenCalledTimes(1);
    const dto = bulk.createBatch.mock.calls[0][1] as {
      messages: Array<{ chatId: string; variables: Record<string, string> }>;
    };
    expect(dto.messages.map(message => message.chatId)).toEqual(['628111@c.us', '628222@c.us']);
    expect(dto.messages[0].variables).toEqual({ chatId: '628111@c.us', name: 'Budi' });
    expect(dto.messages[1].variables).toEqual({ chatId: '628222@c.us' });

    expect(state.recipients.map(row => [row.status, row.messageId, row.errorCode])).toEqual([
      ['sent', 'm1', null],
      ['failed', null, 'NO_WA'],
    ]);
    expect(state.campaign.status).toBe('completed');
    expect(state.campaign.progress).toEqual({ total: 2, sent: 1, failed: 1, skipped: 0 });
    expect(audit.logInfo).toHaveBeenCalledWith(AuditAction.CAMPAIGN_COMPLETED, expect.anything());
    expect(events.emitCampaignUpdated).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({ campaignId: 'cmp-1', status: 'completed' }),
    );
  });

  it('fails the campaign and skips the rest when stopOnError stops a batch', async () => {
    const { runner, state, bulk, campaignService } = makeRunner(
      campaign({ options: { delayBetweenMessages: 3000, randomizeDelay: true, stopOnError: true } }),
    );
    campaignService.resolveAudience.mockResolvedValue({
      chats: [
        { chatId: '628111@c.us', chatName: 'Budi' },
        { chatId: '628222@c.us', chatName: null },
        { chatId: '628333@c.us', chatName: null },
      ],
      truncated: false,
    });
    bulk.getBatchStatus.mockResolvedValue({
      batchId: 'batch-1',
      status: BatchStatus.FAILED,
      results: [
        { chatId: '628111@c.us', status: BatchMessageStatus.SENT, messageId: 'm1', sentAt: now },
        { chatId: '628222@c.us', status: BatchMessageStatus.FAILED, error: { code: 'NO_WA', message: 'nope' } },
      ],
    });

    await runner.start('sess-1', 'cmp-1', actor);
    await settle(runner);

    expect(state.campaign.status).toBe('failed');
    expect(state.recipients.map(row => row.status)).toEqual(['sent', 'failed', 'skipped']);
    expect(state.campaign.progress).toEqual({ total: 3, sent: 1, failed: 1, skipped: 1 });
  });

  it('reconciles a batch left by a previous process before sending anything new', async () => {
    const { runner, state, bulk } = makeRunner(campaign({ status: 'running' }));
    state.recipients.push(
      recipient({ id: 'r1', chatId: '628111@c.us', status: 'pending', batchId: 'old-batch' }),
      recipient({ id: 'r2', chatId: '628222@c.us', status: 'pending', batchId: 'old-batch' }),
    );
    bulk.getBatchStatus.mockResolvedValue({
      batchId: 'old-batch',
      status: BatchStatus.COMPLETED,
      results: [
        { chatId: '628111@c.us', status: BatchMessageStatus.SENT, messageId: 'm-old', sentAt: now },
        { chatId: '628222@c.us', status: BatchMessageStatus.SENT, messageId: 'm-old-2', sentAt: now },
      ],
    });

    await (runner as unknown as { drive: (id: string) => Promise<void> }).drive('cmp-1');

    // Both were already delivered by the previous process, so no new batch was created.
    expect(bulk.createBatch).not.toHaveBeenCalled();
    expect(state.recipients.map(row => row.status)).toEqual(['sent', 'sent']);
    expect(state.campaign.status).toBe('completed');
  });

  it('leaves recipients pending and retries when the batch cannot be created yet', async () => {
    const { runner, state, bulk } = makeRunner(campaign());
    bulk.createBatch.mockRejectedValueOnce(new BadRequestException("Session 'sess-1' is not active"));

    await runner.start('sess-1', 'cmp-1', actor);
    await settle(runner);

    expect(state.campaign.status).toBe('running');
    expect(state.recipients.every(row => row.status === 'pending' && row.batchId === null)).toBe(true);
  });
});

describe('CampaignRunnerService.tick', () => {
  it('starts a scheduled campaign whose time has passed', async () => {
    const { runner, state } = makeRunner(campaign({ status: 'scheduled', scheduledAt: new Date(Date.now() - 60_000) }));

    await (runner as unknown as { tick: () => Promise<void> }).tick();
    await settle(runner);

    expect(state.campaign.status).toBe('completed');
    expect(state.campaign.startedAt).toBeInstanceOf(Date);
  });

  it('leaves a scheduled campaign alone until its time arrives', async () => {
    const { runner, state } = makeRunner(campaign({ status: 'scheduled', scheduledAt: new Date(Date.now() + 60_000) }));

    await (runner as unknown as { tick: () => Promise<void> }).tick();

    expect(state.campaign.status).toBe('scheduled');
  });
});

describe('CampaignRunnerService lifecycle', () => {
  it('stops the sweeper and does not mark a running campaign failed on shutdown', () => {
    const { runner, state } = makeRunner(campaign({ status: 'running' }));

    runner.onModuleDestroy();

    expect(state.campaign.status).toBe('running');
    expect((runner as unknown as { stopping: boolean }).stopping).toBe(true);
  });
});

describe('CampaignService audience normalisation', () => {
  it('keeps only the field the audience kind uses', () => {
    const service = new CampaignService(
      { find: jest.fn(), findOne: jest.fn(), create: jest.fn(), save: jest.fn() } as never,
      { find: jest.fn() } as never,
      { find: jest.fn(), findOne: jest.fn(), create: jest.fn(), save: jest.fn(), remove: jest.fn() } as never,
      { findOne: jest.fn() } as never,
      { getChatsByLabel: jest.fn() } as never,
      { logInfo: jest.fn() } as never,
    );

    const normalize = (service as unknown as { normalizeAudience: (value: unknown) => unknown }).normalizeAudience.bind(
      service,
    );

    expect(normalize({ kind: 'all', chatIds: ['628111@c.us'], segmentId: 'seg-1' })).toEqual({ kind: 'all' });
    expect(normalize({ kind: 'segment', segmentId: 'seg-1', labelId: 'lbl-1' })).toEqual({
      kind: 'segment',
      segmentId: 'seg-1',
    });
    expect(normalize({ kind: 'manual', chatIds: ['628111@c.us', '628111@c.us'] })).toEqual({
      kind: 'manual',
      chatIds: ['628111@c.us'],
    });
    expect(() => normalize({ kind: 'manual', chatIds: [] })).toThrow(BadRequestException);
  });
});
