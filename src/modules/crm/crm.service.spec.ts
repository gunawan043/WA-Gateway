import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { CrmDeal } from './entities/crm-deal.entity';
import { CrmStage } from './entities/crm-stage.entity';
import { CrmService } from './crm.service';

const now = new Date('2026-11-20T10:00:00.000Z');

function stage(overrides: Partial<CrmStage> = {}): CrmStage {
  return {
    id: 'stage-new',
    name: 'New',
    kind: 'open',
    position: 0,
    color: null,
    deals: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function deal(overrides: Partial<CrmDeal> = {}): CrmDeal {
  return {
    id: 'deal-1',
    stageId: 'stage-new',
    title: 'Kontrak tahunan',
    sessionId: 'sess-1',
    chatId: '628111@c.us',
    value: 5_000_000,
    currency: 'IDR',
    status: 'open',
    assigneeKeyId: null,
    assigneeName: null,
    expectedCloseAt: null,
    closedAt: null,
    notes: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as CrmDeal;
}

function makeService() {
  const stages = {
    find: jest.fn().mockResolvedValue([stage()]),
    findOne: jest.fn().mockResolvedValue(stage()),
    save: jest.fn((row: unknown) => Promise.resolve(row)),
  };
  const deals = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn((row: unknown) => Promise.resolve(row)),
    create: jest.fn((row: unknown) => row),
    remove: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
  const activities = {
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn((row: Record<string, unknown>) => Promise.resolve({ ...row, id: 'activity-1', createdAt: now })),
    create: jest.fn((row: unknown) => row),
  };
  const apiKeys = { findOne: jest.fn() };
  const audit = { logInfo: jest.fn().mockResolvedValue(null) };

  const service = new CrmService(
    stages as never,
    deals as never,
    activities as never,
    apiKeys as never,
    audit as never,
  );

  return { service, stages, deals, activities, apiKeys, audit };
}

const actor = { id: 'key-1', name: 'Agen A' } as never;

/** `expect.objectContaining` returns `any`; type it so it can be nested without an unsafe assignment. */
// eslint-disable-next-line @typescript-eslint/no-unsafe-return
const subset = (value: Record<string, unknown>): Record<string, unknown> => expect.objectContaining(value);
const anyDate = expect.any(Date) as unknown as Date;

describe('CrmService.board', () => {
  it('groups deals into stage columns and derives the header counts', async () => {
    const { service, stages, deals } = makeService();
    stages.find.mockResolvedValue([
      stage({ id: 's1', name: 'New', position: 0 }),
      stage({ id: 's2', name: 'Won', kind: 'won', position: 1 }),
    ]);
    deals.find.mockResolvedValue([
      deal({ id: 'd1', stageId: 's1', status: 'open', value: 100 }),
      deal({ id: 'd2', stageId: 's1', status: 'open', value: 50 }),
      deal({ id: 'd3', stageId: 's2', status: 'won', value: 900 }),
    ]);

    const board = await service.board();

    expect(board.columns.map(column => column.stage.id)).toEqual(['s1', 's2']);
    expect(board.columns[0].deals.map(item => item.id)).toEqual(['d1', 'd2']);
    expect(board.columns[1].deals.map(item => item.id)).toEqual(['d3']);
    expect({ open: board.open, won: board.won, lost: board.lost, openValue: board.openValue }).toEqual({
      open: 2,
      won: 1,
      lost: 0,
      openValue: 150,
    });
  });

  it('keeps a stage with no deals as an empty column', async () => {
    const { service, stages } = makeService();
    stages.find.mockResolvedValue([stage({ id: 's1' }), stage({ id: 's2' })]);

    const board = await service.board();

    expect(board.columns).toHaveLength(2);
    expect(board.columns[1].deals).toEqual([]);
  });
});

describe('CrmService.create', () => {
  it('defaults to the first stage and records creation', async () => {
    const { service, stages, deals, activities, audit } = makeService();
    stages.find.mockResolvedValue([stage({ id: 'stage-new', name: 'New' })]);
    let saved: CrmDeal | null = null;
    deals.save.mockImplementation((row: Record<string, unknown>) => {
      saved = { ...row, id: 'deal-1', createdAt: now, updatedAt: now } as CrmDeal;
      return Promise.resolve(saved);
    });
    deals.findOne.mockImplementation(() => Promise.resolve(saved));

    const created = await service.create({ title: '  Kontrak tahunan  ' }, actor);

    expect(stages.find).toHaveBeenCalledWith({ order: { position: 'ASC', createdAt: 'ASC' }, take: 1 });
    expect(deals.create).toHaveBeenCalledWith(
      expect.objectContaining({ stageId: 'stage-new', title: 'Kontrak tahunan', status: 'open', currency: 'IDR' }),
    );
    expect(activities.create).toHaveBeenCalledWith(
      expect.objectContaining({ dealId: 'deal-1', kind: 'created', authorName: 'Agen A' }),
    );
    expect(audit.logInfo).toHaveBeenCalledWith(
      AuditAction.CRM_DEAL_CREATED,
      expect.objectContaining({ metadata: subset({ dealId: 'deal-1' }) }),
    );
    expect(created).toMatchObject({ id: 'deal-1', title: 'Kontrak tahunan', status: 'open' });
  });

  it('derives won status and a closed timestamp from the stage kind', async () => {
    const { service, stages, deals } = makeService();
    stages.findOne.mockResolvedValue(stage({ id: 'stage-won', name: 'Won', kind: 'won' }));
    let saved: CrmDeal | null = null;
    deals.save.mockImplementation((row: Record<string, unknown>) => {
      saved = { ...row, id: 'deal-1', createdAt: now, updatedAt: now } as CrmDeal;
      return Promise.resolve(saved);
    });
    deals.findOne.mockImplementation(() => Promise.resolve(saved));

    await service.create({ title: 'Deal', stageId: 'stage-won' }, actor);

    expect(deals.create).toHaveBeenCalledWith(expect.objectContaining({ status: 'won', closedAt: anyDate }));
  });

  it('refuses an unknown stage', async () => {
    const { service, stages } = makeService();
    stages.findOne.mockResolvedValue(null);

    await expect(service.create({ title: 'Deal', stageId: 'ghost' }, actor)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses to create a deal when the pipeline has no stages', async () => {
    const { service, stages } = makeService();
    stages.find.mockResolvedValue([]);

    await expect(service.create({ title: 'Deal' }, actor)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses an assignee that is not an active API key', async () => {
    const { service, apiKeys } = makeService();
    apiKeys.findOne.mockResolvedValue({ id: 'key-2', name: 'Agen B', isActive: false });

    await expect(
      service.create({ title: 'Deal', stageId: 'stage-new', assigneeKeyId: 'key-2' }, actor),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('CrmService.update', () => {
  it('moves a deal between stages, rewrites status and records the move', async () => {
    const { service, stages, deals, activities, audit } = makeService();
    const existing = deal({ id: 'deal-1', stageId: 'stage-new', status: 'open' });
    deals.findOne.mockResolvedValue(existing);
    stages.findOne.mockResolvedValue(stage({ id: 'stage-lost', name: 'Lost', kind: 'lost' }));

    await service.update('deal-1', { stageId: 'stage-lost' }, actor);

    expect(existing.stageId).toBe('stage-lost');
    expect(existing.status).toBe('lost');
    expect(existing.closedAt).toBeInstanceOf(Date);
    expect(activities.create).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'stage_change',
        fromStageId: 'stage-new',
        toStageId: 'stage-lost',
      }),
    );
    expect(audit.logInfo).toHaveBeenCalledWith(
      AuditAction.CRM_DEAL_STAGE_CHANGED,
      expect.objectContaining({ metadata: subset({ status: 'lost' }) }),
    );
  });

  it('clears the closed timestamp when a deal moves back to an open stage', async () => {
    const { service, stages, deals } = makeService();
    const existing = deal({ status: 'won', stageId: 'stage-won', closedAt: new Date('2026-01-01T00:00:00.000Z') });
    deals.findOne.mockResolvedValue(existing);
    stages.findOne.mockResolvedValue(stage({ id: 'stage-new', kind: 'open' }));

    await service.update('deal-1', { stageId: 'stage-new' }, actor);

    expect(existing.status).toBe('open');
    expect(existing.closedAt).toBeNull();
  });

  it('records a single update entry for edited fields', async () => {
    const { service, deals, activities } = makeService();
    deals.findOne.mockResolvedValue(deal({ id: 'deal-1', title: 'Old', notes: null }));

    await service.update('deal-1', { title: 'New', notes: 'catatan' }, actor);

    expect(activities.create).toHaveBeenCalledWith(expect.objectContaining({ kind: 'update', body: 'title, notes' }));
  });

  it('404s for a deal that does not exist', async () => {
    const { service } = makeService();
    await expect(service.update('ghost', { title: 'x' }, actor)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('CrmService.remove', () => {
  it('deletes the deal and audits the deletion with its last state', async () => {
    const { service, deals, audit } = makeService();
    const existing = deal({ id: 'deal-1', title: 'Kontrak', status: 'open' });
    deals.findOne.mockResolvedValue(existing);

    await service.remove('deal-1', actor);

    expect(deals.remove).toHaveBeenCalledWith(existing);
    expect(audit.logInfo).toHaveBeenCalledWith(
      AuditAction.CRM_DEAL_DELETED,
      expect.objectContaining({ metadata: subset({ dealId: 'deal-1', title: 'Kontrak' }) }),
    );
  });

  it('404s for a deal that does not exist', async () => {
    const { service } = makeService();
    await expect(service.remove('ghost', actor)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('CrmService activities', () => {
  it('appends a note to the deal history', async () => {
    const { service, deals, activities } = makeService();
    deals.findOne.mockResolvedValue(deal({ id: 'deal-1' }));

    const activity = await service.addActivity('deal-1', { body: 'Telpon besok' }, actor);

    expect(activities.create).toHaveBeenCalledWith(
      expect.objectContaining({ dealId: 'deal-1', kind: 'note', body: 'Telpon besok', authorKeyId: 'key-1' }),
    );
    expect(activity).toMatchObject({ id: 'activity-1', kind: 'note', body: 'Telpon besok' });
  });

  it('404s for a deal that does not exist', async () => {
    const { service } = makeService();
    await expect(service.addActivity('ghost', { body: 'x' }, actor)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('CrmService.listDeals', () => {
  function makeQueryBuilder(rows: CrmDeal[] = []) {
    const qb = {
      orderBy: jest.fn(),
      andWhere: jest.fn(),
      skip: jest.fn(),
      take: jest.fn(),
      getMany: jest.fn().mockResolvedValue(rows),
    };
    qb.orderBy.mockReturnValue(qb);
    qb.andWhere.mockReturnValue(qb);
    qb.skip.mockReturnValue(qb);
    qb.take.mockReturnValue(qb);
    return qb;
  }

  it('applies status, stage and assignee filters and pages in SQL', async () => {
    const { service, deals } = makeService();
    const qb = makeQueryBuilder([deal()]);
    deals.createQueryBuilder.mockReturnValue(qb);

    const rows = await service.listDeals({ status: 'open', stageId: 's1', assignee: 'me' }, 10, 20, 'key-1');

    expect(qb.andWhere).toHaveBeenCalledWith('deal.status = :status', { status: 'open' });
    expect(qb.andWhere).toHaveBeenCalledWith('deal.stageId = :stageId', { stageId: 's1' });
    expect(qb.andWhere).toHaveBeenCalledWith('deal.assigneeKeyId = :assignee', { assignee: 'key-1' });
    expect(qb.skip).toHaveBeenCalledWith(20);
    expect(qb.take).toHaveBeenCalledWith(10);
    expect(rows).toHaveLength(1);
  });

  it('filters unassigned deals and escapes the search term', async () => {
    const { service, deals } = makeService();
    const qb = makeQueryBuilder();
    deals.createQueryBuilder.mockReturnValue(qb);

    await service.listDeals({ assignee: 'unassigned', q: '50%_off' });

    expect(qb.andWhere).toHaveBeenCalledWith('deal.assigneeKeyId IS NULL');
    expect(qb.andWhere).toHaveBeenCalledWith(expect.stringContaining('LOWER(deal.title) LIKE :q'), {
      q: '%50\\%\\_off%',
    });
  });
});

describe('CrmService.updateStage', () => {
  it('renames, reorders and recolours a stage', async () => {
    const { service, stages } = makeService();
    const existing = stage({ id: 's1', name: 'New', position: 0, color: null });
    stages.findOne.mockResolvedValue(existing);

    const updated = await service.updateStage('s1', { name: 'Prospek', position: 2, color: '#22c55e' });

    expect(existing).toMatchObject({ name: 'Prospek', position: 2, color: '#22c55e' });
    expect(updated).toMatchObject({ name: 'Prospek', position: 2, color: '#22c55e' });
  });

  it('404s for a stage that does not exist', async () => {
    const { service, stages } = makeService();
    stages.findOne.mockResolvedValue(null);

    await expect(service.updateStage('ghost', { name: 'x' })).rejects.toBeInstanceOf(NotFoundException);
  });
});
