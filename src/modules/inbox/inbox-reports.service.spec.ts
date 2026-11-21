import { BadRequestException } from '@nestjs/common';
import { InboxReportsService } from './inbox-reports.service';
import type { InboxConversation } from './entities/inbox-conversation.entity';

function row(overrides: Partial<InboxConversation> = {}): InboxConversation {
  return {
    id: 'conv-1',
    sessionId: 'sess-1',
    chatId: '628111@c.us',
    status: 'open',
    assigneeKeyId: null,
    assigneeName: null,
    divisionId: null,
    divisionName: null,
    firstInboundAt: new Date('2026-11-20T08:00:00.000Z'),
    firstResponseAt: new Date('2026-11-20T08:10:00.000Z'),
    slaStartedAt: null,
    slaDueAt: null,
    slaBreachedAt: null,
    slaMinutes: 15,
    resolvedAt: null,
    lastInboundAt: null,
    createdAt: new Date('2026-11-20T08:00:00.000Z'),
    updatedAt: new Date('2026-11-20T08:00:00.000Z'),
    ...overrides,
  } as InboxConversation;
}

function makeBuilder(rows: InboxConversation[]) {
  const builder: Record<string, jest.Mock> = {};
  for (const method of ['where', 'andWhere', 'orderBy', 'take']) {
    builder[method] = jest.fn(() => builder);
  }
  builder.getMany = jest.fn().mockResolvedValue(rows);
  return builder;
}

function makeService(rows: InboxConversation[] = []) {
  const builder = makeBuilder(rows);
  const conversations = { createQueryBuilder: jest.fn(() => builder) };

  const service = new InboxReportsService(conversations as never);
  return { service, builder };
}

/** The two steps the controller runs, in order, with no chat-scope filter in between. */
async function buildReport(
  service: InboxReportsService,
  sessionId: string,
  options: { from?: string; to?: string; division?: string },
) {
  return service.build(await service.load(sessionId, options));
}

const RANGE = { from: '2026-11-01T00:00:00.000Z', to: '2026-11-30T23:59:59.000Z' };

describe('InboxReportsService totals', () => {
  it('counts conversations, answers and eligibility', async () => {
    const { service } = makeService([
      row({ id: 'a', status: 'open', assigneeKeyId: 'key-1', assigneeName: 'Rina', firstResponseAt: null }),
      row({ id: 'b', status: 'resolved', assigneeKeyId: 'key-1', assigneeName: 'Rina', slaBreachedAt: new Date() }),
      row({
        id: 'c',
        status: 'resolved',
        assigneeKeyId: 'key-2',
        assigneeName: 'Budi',
        firstResponseAt: new Date('2026-11-20T08:20:00.000Z'),
        slaMinutes: null,
      }),
    ]);

    const report = await buildReport(service, 'sess-1', RANGE);

    expect(report.totals).toEqual({
      conversations: 3,
      open: 1,
      resolved: 2,
      unassigned: 0,
      awaitingFirstResponse: 1,
      // (10 + 20) / 2: the unanswered conversation contributes no sample.
      avgFirstResponseMinutes: 15,
      slaEligible: 2,
      slaBreached: 1,
      slaComplianceRate: 0.5,
    });
  });

  it('reports a null compliance instead of a fake 100% when nothing was measured', async () => {
    const { service } = makeService([row({ slaMinutes: null, slaBreachedAt: null })]);

    const report = await buildReport(service, 'sess-1', RANGE);

    expect(report.totals.slaEligible).toBe(0);
    expect(report.totals.slaComplianceRate).toBeNull();
  });

  it('breaks the numbers down by division and by agent, unassigned included', async () => {
    const { service } = makeService([
      row({ id: 'a', divisionId: 'div-1', divisionName: 'SMP', assigneeKeyId: 'key-1', assigneeName: 'Rina' }),
      row({ id: 'b', divisionId: 'div-1', divisionName: 'SMP', assigneeKeyId: null }),
      row({ id: 'c', divisionId: null, divisionName: null, assigneeKeyId: null }),
    ]);

    const report = await buildReport(service, 'sess-1', RANGE);

    expect(report.byDivision).toEqual([
      expect.objectContaining({ divisionId: 'div-1', divisionName: 'SMP', conversations: 2, slaEligible: 2 }),
      expect.objectContaining({ divisionId: null, divisionName: null, conversations: 1 }),
    ]);
    expect(report.byAgent).toEqual([
      expect.objectContaining({ assigneeKeyId: null, assigneeName: null, conversations: 2 }),
      expect.objectContaining({ assigneeKeyId: 'key-1', assigneeName: 'Rina', conversations: 1, resolved: 0 }),
    ]);
  });
});

describe('InboxReportsService daily buckets', () => {
  it('zero-fills every UTC day in the range', async () => {
    const { service } = makeService([
      row({ id: 'a', firstInboundAt: new Date('2026-11-02T10:00:00.000Z') }),
      row({ id: 'b', firstInboundAt: new Date('2026-11-02T23:30:00.000Z') }),
      row({ id: 'c', firstInboundAt: new Date('2026-11-04T00:00:00.000Z'), slaBreachedAt: new Date() }),
    ]);

    const report = await buildReport(service, 'sess-1', {
      from: '2026-11-01T12:00:00.000Z',
      to: '2026-11-04T12:00:00.000Z',
    });

    expect(report.daily.map(day => [day.date, day.conversations, day.slaBreached])).toEqual([
      ['2026-11-01', 0, 0],
      ['2026-11-02', 2, 0],
      ['2026-11-03', 0, 0],
      ['2026-11-04', 1, 1],
    ]);
  });

  it('returns an empty but complete report for a period with no conversation', async () => {
    const { service } = makeService([]);

    const report = await buildReport(service, 'sess-1', {
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-03T00:00:00.000Z',
    });

    expect(report.totals.conversations).toBe(0);
    expect(report.totals.avgFirstResponseMinutes).toBeNull();
    expect(report.daily).toHaveLength(3);
    expect(report.byDivision).toEqual([]);
    expect(report.byAgent).toEqual([]);
  });
});

describe('InboxReportsService filters and limits', () => {
  it('filters by division and by unassigned', async () => {
    const { service, builder } = makeService([]);

    await buildReport(service, 'sess-1', { ...RANGE, division: 'div-1' });
    expect(builder.andWhere).toHaveBeenCalledWith('conversation.divisionId = :division', { division: 'div-1' });

    builder.andWhere.mockClear();
    await buildReport(service, 'sess-1', { ...RANGE, division: 'unassigned' });
    expect(builder.andWhere).toHaveBeenCalledWith('conversation.divisionId IS NULL');
  });

  it('aggregates exactly the rows it is handed, so a filtered set never leaks a hidden chat', () => {
    const { service } = makeService([]);
    const loaded = {
      from: new Date('2026-11-01T00:00:00.000Z'),
      to: new Date('2026-11-03T00:00:00.000Z'),
      rows: [row({ id: 'a', chatId: 'allowed@c.us', firstInboundAt: new Date('2026-11-02T10:00:00.000Z') })],
    };

    const report = service.build(loaded);

    expect(report.totals.conversations).toBe(1);
    expect(report.daily.reduce((sum, day) => sum + day.conversations, 0)).toBe(1);
  });

  it('refuses more than 20000 rows instead of truncating', async () => {
    const rows = Array.from({ length: 20_001 }, (_, index) => row({ id: `conv-${index}` }));
    const { service } = makeService(rows);

    await expect(service.load('sess-1', RANGE)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a range longer than a year', async () => {
    const { service } = makeService([]);

    await expect(
      service.load('sess-1', { from: '2024-01-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a range that ends before it starts', async () => {
    const { service } = makeService([]);

    await expect(service.load('sess-1', { from: RANGE.to, to: RANGE.from })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
