import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  InboxReportAgentDto,
  InboxReportDailyDto,
  InboxReportDivisionDto,
  InboxReportDto,
  InboxReportTotalsDto,
} from './dto/inbox-report.dto';
import { InboxConversation } from './entities/inbox-conversation.entity';

const DAY_MS = 86_400_000;
const DEFAULT_RANGE_DAYS = 30;
const MAX_RANGE_DAYS = 366;
/**
 * Hard cap on the rows one report may load. A busier range is refused with a 400 rather than
 * truncated: a silently short report is worse than an error that says "narrow the range".
 */
const MAX_ROWS = 20_000;

export interface InboxReportOptions {
  from?: string;
  to?: string;
  /** `unassigned`, or a division id. Omit for every conversation. */
  division?: string;
}

/** A loaded, still unfiltered set of conversations plus the range it came from. */
export interface InboxReportRows {
  from: Date;
  to: Date;
  rows: InboxConversation[];
}

/**
 * Aggregates first-response metrics for the inbox.
 *
 * The rows are loaded once and aggregated in JS. The alternative — GROUP BY with dialect-specific
 * date functions — would need a different expression for SQLite (`strftime`) and PostgreSQL
 * (`date_trunc`), and the daily buckets are the only place the difference would show. At the row cap
 * below, the JS pass is not the bottleneck.
 *
 * Loading and aggregating are two steps on purpose: the controller filters the loaded rows to the
 * key's chats in between, so a restricted key sees metrics computed only from the chats it may read.
 * A total that included chats it cannot see would leak their existence.
 */
@Injectable()
export class InboxReportsService {
  constructor(
    @InjectRepository(InboxConversation, 'data')
    private readonly conversations: Repository<InboxConversation>,
  ) {}

  async load(sessionId: string, options: InboxReportOptions): Promise<InboxReportRows> {
    const { from, to } = this.parseRange(options.from, options.to);

    const query = this.conversations
      .createQueryBuilder('conversation')
      .where('conversation.sessionId = :sessionId', { sessionId })
      .andWhere('conversation.firstInboundAt IS NOT NULL')
      .andWhere('conversation.firstInboundAt >= :from', { from: from.toISOString() })
      .andWhere('conversation.firstInboundAt <= :to', { to: to.toISOString() })
      .orderBy('conversation.firstInboundAt', 'ASC')
      .take(MAX_ROWS + 1);

    const division = options.division?.trim();
    if (division === 'unassigned') {
      query.andWhere('conversation.divisionId IS NULL');
    } else if (division && division !== 'all') {
      query.andWhere('conversation.divisionId = :division', { division });
    }

    const rows = await query.getMany();
    if (rows.length > MAX_ROWS) {
      throw new BadRequestException(
        `This range holds more than ${MAX_ROWS} conversations; narrow the dates or pick a division`,
      );
    }

    return { from, to, rows };
  }

  /** Aggregates the rows the caller passes; it must already be the set the key may read. */
  build({ from, to, rows }: InboxReportRows): InboxReportDto {
    const totals = this.totals(rows);
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      totals,
      byDivision: this.byDivision(rows),
      byAgent: this.byAgent(rows),
      daily: this.daily(rows, from, to),
    };
  }

  private totals(rows: InboxConversation[]): InboxReportTotalsDto {
    return {
      conversations: rows.length,
      open: rows.filter(row => row.status === 'open').length,
      resolved: rows.filter(row => row.status === 'resolved').length,
      unassigned: rows.filter(row => row.assigneeKeyId === null).length,
      awaitingFirstResponse: rows.filter(row => row.firstResponseAt === null).length,
      ...this.responseStats(rows),
    };
  }

  private byDivision(rows: InboxConversation[]): InboxReportDivisionDto[] {
    const groups = new Map<string, InboxConversation[]>();
    for (const row of rows) {
      const key = row.divisionId ?? '';
      const bucket = groups.get(key);
      if (bucket) bucket.push(row);
      else groups.set(key, [row]);
    }

    const result: InboxReportDivisionDto[] = [];
    for (const [key, bucket] of groups) {
      result.push({
        divisionId: key === '' ? null : key,
        divisionName: bucket[0].divisionName,
        conversations: bucket.length,
        ...this.responseStats(bucket),
      });
    }
    return result.sort(
      (a, b) =>
        b.conversations - a.conversations ||
        (a.divisionName ?? '').localeCompare(b.divisionName ?? '') ||
        (a.divisionId ?? '').localeCompare(b.divisionId ?? ''),
    );
  }

  private byAgent(rows: InboxConversation[]): InboxReportAgentDto[] {
    const groups = new Map<string, InboxConversation[]>();
    for (const row of rows) {
      const key = row.assigneeKeyId ?? '';
      const bucket = groups.get(key);
      if (bucket) bucket.push(row);
      else groups.set(key, [row]);
    }

    const result: InboxReportAgentDto[] = [];
    for (const [key, bucket] of groups) {
      const stats = this.responseStats(bucket);
      result.push({
        assigneeKeyId: key === '' ? null : key,
        assigneeName: bucket[0].assigneeName,
        conversations: bucket.length,
        resolved: bucket.filter(row => row.status === 'resolved').length,
        slaEligible: stats.slaEligible,
        slaBreached: stats.slaBreached,
        avgFirstResponseMinutes: stats.avgFirstResponseMinutes,
      });
    }
    return result.sort(
      (a, b) =>
        b.conversations - a.conversations ||
        (a.assigneeName ?? '').localeCompare(b.assigneeName ?? '') ||
        (a.assigneeKeyId ?? '').localeCompare(b.assigneeKeyId ?? ''),
    );
  }

  /** UTC buckets, zero-filled across the range so a quiet day is a zero rather than a gap. */
  private daily(rows: InboxConversation[], from: Date, to: Date): InboxReportDailyDto[] {
    const buckets = new Map<string, InboxConversation[]>();
    const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
    const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
    for (let time = start; time <= end; time += DAY_MS) {
      buckets.set(new Date(time).toISOString().slice(0, 10), []);
    }

    for (const row of rows) {
      const key = row.firstInboundAt ? row.firstInboundAt.toISOString().slice(0, 10) : null;
      const bucket = key ? buckets.get(key) : undefined;
      if (bucket) bucket.push(row);
    }

    return [...buckets].map(([date, bucket]) => {
      const stats = this.responseStats(bucket);
      return {
        date,
        conversations: bucket.length,
        slaBreached: stats.slaBreached,
        avgFirstResponseMinutes: stats.avgFirstResponseMinutes,
      };
    });
  }

  /** The metrics every breakdown shares: response time, eligibility and compliance. */
  private responseStats(
    rows: InboxConversation[],
  ): Pick<InboxReportTotalsDto, 'avgFirstResponseMinutes' | 'slaEligible' | 'slaBreached' | 'slaComplianceRate'> {
    const minutes: number[] = [];
    for (const row of rows) {
      if (!row.firstInboundAt || !row.firstResponseAt) continue;
      minutes.push(Math.max(0, row.firstResponseAt.getTime() - row.firstInboundAt.getTime()) / 60_000);
    }

    const eligible = rows.filter(row => row.slaMinutes !== null && row.slaMinutes !== undefined);
    const breached = eligible.filter(row => row.slaBreachedAt !== null);

    return {
      avgFirstResponseMinutes: minutes.length
        ? Math.round((minutes.reduce((sum, value) => sum + value, 0) / minutes.length) * 10) / 10
        : null,
      slaEligible: eligible.length,
      slaBreached: breached.length,
      slaComplianceRate: eligible.length
        ? Math.round(((eligible.length - breached.length) / eligible.length) * 1_000) / 1_000
        : null,
    };
  }

  private parseRange(fromRaw?: string, toRaw?: string): { from: Date; to: Date } {
    const to = toRaw ? new Date(toRaw) : new Date();
    const from = fromRaw ? new Date(fromRaw) : new Date(to.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('from and to must be ISO dates');
    }
    if (from.getTime() >= to.getTime()) {
      throw new BadRequestException('from must be earlier than to');
    }
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
      throw new BadRequestException(`The range must not exceed ${MAX_RANGE_DAYS} days`);
    }
    return { from, to };
  }
}
