import { DataSource, In, MoreThan, Repository } from 'typeorm';
import { ApprovalRetryService } from './approval-retry.service';
import { ApprovalCommand } from './entities/approval-command.entity';
import type { ApprovalProcessorService } from './approval-processor.service';
import {
  approvalMetricLines,
  recordApprovalCommand,
  resetApprovalMetricsForTest,
} from '../../common/metrics/approval-metrics';
import { readRetryPolicy, retryDelayMs } from './approval-retry.policy';

/**
 * Soak for the retry worker: many commands, many passes, one process.
 *
 * The unit suite proves each rule once; this proves the rules still hold when hundreds of rows
 * move through the same worker at once — that every row reaches a terminal state, that no row is
 * dispatched more often than the policy allows, and that the counters an operator alerts on agree
 * with what actually happened in the table.
 *
 * Bounded by default so the normal lane stays fast. For a real soak, raise the knobs:
 *
 *   SOAK_COMMANDS=5000 SOAK_MAX_PASSES=200 npx jest modules/approval/approval-retry.soak --runInBand
 *
 * The mock processor is not a shortcut around the worker: it implements the processor's contract
 * (increment `attempts`, schedule the next attempt, leave exhaustion to the worker) and every
 * assertion is made on rows the worker actually claimed. The worker's own claiming logic — the
 * conditional UPDATE with `affected === 1` — runs for real against SQLite.
 */
const COMMANDS = Number(process.env.SOAK_COMMANDS ?? 400);
const BATCH_SIZE = Number(process.env.SOAK_BATCH_SIZE ?? 50);
const MAX_PASSES = Number(process.env.SOAK_MAX_PASSES ?? 40);
/** Share of commands that fail transiently every attempt, until the policy parks them. */
const TRANSIENT_PERCENT = Number(process.env.SOAK_TRANSIENT_PERCENT ?? 40);

const NOW = new Date('2026-11-22T02:00:00.000Z');

/** Deterministic per-command decision, so a run is reproducible instead of luck. */
function hash(id: string): number {
  let value = 0;
  for (let index = 0; index < id.length; index++) value = (value * 31 + id.charCodeAt(index)) >>> 0;
  return value;
}

const metricValue = (lines: string[], series: string): number => {
  const line = lines.find(entry => entry.startsWith(`${series} `));
  return line ? Number(line.slice(series.length + 1)) : 0;
};

describe('Approval retry worker soak', () => {
  let ds: DataSource;
  let commands: Repository<ApprovalCommand>;

  beforeAll(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [ApprovalCommand],
      synchronize: true,
    });
    await ds.initialize();
  });

  afterAll(async () => {
    await ds.destroy();
  });

  beforeEach(() => {
    resetApprovalMetricsForTest();
  });

  it('drains every command to a terminal state and keeps the counters honest', async () => {
    commands = ds.getRepository(ApprovalCommand);
    await commands.clear();

    const settings: Record<string, number> = {
      'connect.approval.retry.intervalMs': 0,
      'connect.approval.retry.batchSize': BATCH_SIZE,
      'connect.approval.retry.maxAttempts': 5,
      'connect.approval.retry.baseDelayMs': 30_000,
      'connect.approval.retry.maxDelayMs': 900_000,
      'connect.approval.retry.leaseMs': 60_000,
    };
    const config = { get: (key: string, fallback?: number) => settings[key] ?? fallback };
    const policy = readRetryPolicy(config as never);

    const rows: ApprovalCommand[] = [];
    for (let index = 0; index < COMMANDS; index++) {
      rows.push(
        commands.create({
          commandId: `soak-${index}`,
          approvalRequestId: `req-${index}`,
          externalMessageId: `wamid.soak.${index}`,
          decision: 'approved',
          durationDays: 2,
          status: 'UNKNOWN',
          attempts: 0,
          nextAttemptAt: new Date(NOW.getTime() - 1000),
        }),
      );
    }
    await commands.save(rows, { chunk: 100 });

    // The processor contract, implemented against the table the worker claims from.
    const inFlight = new Set<string>();
    let dispatches = 0;
    let appliedByProcessor = 0;

    const retryUnknown = jest.fn(async (commandId: string) => {
      if (inFlight.has(commandId)) throw new Error(`command ${commandId} dispatched concurrently`);
      inFlight.add(commandId);
      try {
        const command = await commands.findOneOrFail({ where: { commandId } });
        const attempt = command.attempts + 1;
        const transient = hash(commandId) % 100 < TRANSIENT_PERCENT;
        dispatches += 1;

        if (!transient) {
          await commands.update({ id: command.id }, { status: 'APPLIED', attempts: attempt, nextAttemptAt: null });
          appliedByProcessor += 1;
          recordApprovalCommand('applied');
          return 'applied';
        }

        // Still unknown: keep the row recoverable and schedule it. Exhaustion is the worker's
        // decision (it parks a row whose `attempts` reached the limit), exactly as in production.
        await commands.update(
          { id: command.id },
          {
            attempts: attempt,
            nextAttemptAt: new Date(NOW.getTime() + retryDelayMs(attempt, policy)),
            lastError: 'core tidak menjawab',
          },
        );
        return 'core_unavailable';
      } finally {
        inFlight.delete(commandId);
      }
    });

    const service = new ApprovalRetryService(
      commands,
      { retryUnknown } as unknown as ApprovalProcessorService,
      config as never,
    );

    const started = Date.now();
    let clock = NOW.getTime();
    let passes = 0;
    let totalRetried = 0;

    while (passes < MAX_PASSES) {
      const remaining = await commands.count({ where: { status: In(['UNKNOWN', 'PENDING']) } });
      if (remaining === 0) break;

      const stats = await service.runOnce(new Date(clock));
      totalRetried += stats.retried;
      passes += 1;
      // Past the lease, so a row the worker just claimed (or rescheduled) is due again next pass.
      clock += policy.leaseMs + 1000;
    }
    const elapsedMs = Date.now() - started;

    // 1. Nothing is left mid-flight: every command is decided or parked for a human.
    const statuses = await commands
      .createQueryBuilder('c')
      .select('c.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('c.status')
      .getRawMany<{ status: string; count: string }>();
    const byStatus = new Map(statuses.map(row => [row.status, Number(row.count)]));

    expect(byStatus.get('UNKNOWN') ?? 0).toBe(0);
    expect(byStatus.get('PENDING') ?? 0).toBe(0);
    expect((byStatus.get('APPLIED') ?? 0) + (byStatus.get('FAILED') ?? 0)).toBe(COMMANDS);

    // 2. The worker never dispatched a row more often than the policy allows.
    const overAttempted = await commands.count({ where: { attempts: MoreThan(policy.maxAttempts) } });
    expect(overAttempted).toBe(0);
    expect(dispatches).toBe(totalRetried);

    // 3. The counters agree with the table — that is what an alert reads at 3 a.m.
    const lines = approvalMetricLines();
    expect(metricValue(lines, 'openwa_approval_retry_attempts_total')).toBe(totalRetried);
    expect(metricValue(lines, 'openwa_approval_command_transitions_total{status="applied"}')).toBe(appliedByProcessor);
    expect(metricValue(lines, 'openwa_approval_command_transitions_total{status="failed"}')).toBe(
      byStatus.get('FAILED') ?? 0,
    );

    // 4. Parked rows carry no lease, so no worker revisits them.
    const parked = await commands.find({ where: { status: 'FAILED' } });
    expect(parked.every(row => row.nextAttemptAt === null)).toBe(true);

    // Progress line, so a long run is measurable rather than merely green.
    console.log(
      `[soak] ${COMMANDS} commands · ${passes} passes · ${dispatches} dispatches · ` +
        `applied ${byStatus.get('APPLIED') ?? 0} · parked ${byStatus.get('FAILED') ?? 0} · ` +
        `${(COMMANDS / (elapsedMs / 1000)).toFixed(0)} cmd/s · ${elapsedMs} ms`,
    );
  }, 120_000);
});
