import { DataSource, Repository } from 'typeorm';
import { ApprovalRetryService } from './approval-retry.service';
import { ApprovalCommand } from './entities/approval-command.entity';
import type { ApprovalProcessorService } from './approval-processor.service';

/**
 * Retry safety for commands whose outcome Core never confirmed.
 *
 * The worker must reuse the same `commandId`, claim a row before sending (so two processes do
 * not both send), leave a restart able to resume, and stop at the configured attempt limit with
 * the command parked for manual review. None of these may produce a second decision.
 */
describe('ApprovalRetryService', () => {
  let ds: DataSource;
  let commands: Repository<ApprovalCommand>;
  let retryUnknown: jest.Mock;
  let processor: ApprovalProcessorService;
  let settings: Record<string, number>;
  let service: ApprovalRetryService;

  const NOW = new Date('2026-11-22T02:00:00.000Z');

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

  beforeEach(async () => {
    await ds.getRepository(ApprovalCommand).clear();
    commands = ds.getRepository(ApprovalCommand);
    retryUnknown = jest.fn().mockResolvedValue('applied');
    processor = { retryUnknown } as unknown as ApprovalProcessorService;
    settings = {
      'connect.approval.retry.intervalMs': 60_000,
      'connect.approval.retry.batchSize': 20,
      'connect.approval.retry.maxAttempts': 5,
      'connect.approval.retry.baseDelayMs': 30_000,
      'connect.approval.retry.maxDelayMs': 900_000,
      'connect.approval.retry.leaseMs': 60_000,
    };
    service = new ApprovalRetryService(commands, processor, {
      get: (key: string, fallback?: number) => settings[key] ?? fallback,
    } as never);
  });

  async function seedCommand(overrides: Partial<ApprovalCommand> = {}): Promise<ApprovalCommand> {
    return commands.save(
      commands.create({
        commandId: `cmd-${Math.random().toString(36).slice(2)}`,
        approvalRequestId: 'req-1',
        externalMessageId: `wamid.${Math.random().toString(36).slice(2)}`,
        decision: 'approved',
        durationDays: 2,
        status: 'UNKNOWN',
        attempts: 1,
        nextAttemptAt: new Date(NOW.getTime() - 1000),
        ...overrides,
      }),
    );
  }

  it('mengirim ulang command UNKNOWN dengan commandId yang sama', async () => {
    const command = await seedCommand();

    const stats = await service.runOnce(NOW);

    expect(retryUnknown).toHaveBeenCalledTimes(1);
    expect(retryUnknown).toHaveBeenCalledWith(command.commandId);
    expect(stats).toMatchObject({ scanned: 1, retried: 1, resolved: 1 });
  });

  it('memproses command lama yang belum punya jadwal retry', async () => {
    await seedCommand({ nextAttemptAt: null });

    const stats = await service.runOnce(NOW);

    expect(retryUnknown).toHaveBeenCalledTimes(1);
    expect(stats.retried).toBe(1);
  });

  it('melewati command yang lease-nya belum habis (restart aman)', async () => {
    await seedCommand({ nextAttemptAt: new Date(NOW.getTime() + 60_000) });

    const stats = await service.runOnce(NOW);

    expect(retryUnknown).not.toHaveBeenCalled();
    expect(stats.scanned).toBe(0);
  });

  it('memarkir command untuk pemeriksaan manual saat batas percobaan tercapai', async () => {
    const command = await seedCommand({ attempts: 5 });

    const stats = await service.runOnce(NOW);

    const after = await commands.findOneByOrFail({ id: command.id });
    expect(retryUnknown).not.toHaveBeenCalled();
    expect(after.status).toBe('FAILED');
    expect(after.nextAttemptAt).toBeNull();
    expect(after.lastError).toMatch(/Batas percobaan/);
    expect(stats.exhausted).toBe(1);
  });

  it('memakai batas percobaan dari konfigurasi, bukan nilai tetap', async () => {
    settings['connect.approval.retry.maxAttempts'] = 2;
    await seedCommand({ attempts: 2 });

    const stats = await service.runOnce(NOW);

    expect(retryUnknown).not.toHaveBeenCalled();
    expect(stats.exhausted).toBe(1);
  });

  it('mengembalikan command ke antrean bila pengiriman melempar', async () => {
    const command = await seedCommand();
    retryUnknown.mockRejectedValue(new Error('socket hang up'));

    const stats = await service.runOnce(NOW);

    const after = await commands.findOneByOrFail({ id: command.id });
    expect(after.status).toBe('UNKNOWN');
    expect(after.lastError).toMatch(/socket hang up/);
    expect(after.nextAttemptAt?.getTime()).toBeGreaterThan(NOW.getTime());
    expect(stats.retried).toBe(1);
    expect(stats.resolved).toBe(0);
  });

  it('tidak mengklaim baris yang sama dua kali saat dua pass berjalan bersamaan', async () => {
    await seedCommand();

    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>(resolve => {
      release = resolve;
    });
    const claimed = new Promise<void>(resolve => {
      started = resolve;
    });
    retryUnknown.mockImplementation(async () => {
      started();
      await blocked;

      return 'applied';
    });

    const first = service.runOnce(NOW);
    // Tunggu sampai pass pertama benar-benar mengklaim baris (retryUnknown baru dipanggil setelah klaim).
    await claimed;
    const second = await service.runOnce(NOW);
    release();
    await first;

    expect(retryUnknown).toHaveBeenCalledTimes(1);
    expect(second.retried).toBe(0);
  });

  it('menghitung command yang ditandai FAILED oleh processor sebagai habis', async () => {
    const command = await seedCommand();
    retryUnknown.mockImplementation(async () => {
      await commands.update({ id: command.id }, { status: 'FAILED', nextAttemptAt: null });

      return 'core_unavailable';
    });

    const stats = await service.runOnce(NOW);

    expect(stats.exhausted).toBe(1);
    expect(stats.resolved).toBe(0);
  });

  it('tidak memproses command yang sudah final', async () => {
    await seedCommand({ status: 'APPLIED' });

    const stats = await service.runOnce(NOW);

    expect(retryUnknown).not.toHaveBeenCalled();
    expect(stats.scanned).toBe(0);
  });

  // Command dibuat PENDING sebelum dikirim. Bila proses berhenti di antara keduanya, baris itu
  // harus dipulihkan setelah lease-nya habis — bukan dibiarkan menggantung selamanya.
  it('memulihkan command PENDING yang ditinggal proses mati', async () => {
    const command = await seedCommand({
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: new Date(NOW.getTime() - 1000),
    });

    const stats = await service.runOnce(NOW);

    expect(retryUnknown).toHaveBeenCalledWith(command.commandId);
    expect(stats).toMatchObject({ scanned: 1, retried: 1, resolved: 1 });
  });

  it('tidak menyentuh command PENDING yang lease-nya masih dipegang pengirim', async () => {
    await seedCommand({
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: new Date(NOW.getTime() + 30_000),
    });

    const stats = await service.runOnce(NOW);

    expect(retryUnknown).not.toHaveBeenCalled();
    expect(stats.scanned).toBe(0);
  });

  // Balapan nyata: pass ini membaca baris yang sudah mencapai batas, lalu worker lain
  // menyelesaikannya sebelum sempat diparkir. Status final tidak boleh ditimpa FAILED.
  it('tidak menimpa status final yang ditetapkan proses lain saat batas tercapai', async () => {
    const command = await seedCommand({ attempts: 5 });

    const find = commands.find.bind(commands);
    jest.spyOn(commands, 'find').mockImplementationOnce(async (...args: Parameters<typeof find>) => {
      const rows = await find(...args);
      await commands.update({ id: command.id }, { status: 'APPLIED', nextAttemptAt: null });

      return rows;
    });

    const stats = await service.runOnce(NOW);

    expect((await commands.findOneByOrFail({ id: command.id })).status).toBe('APPLIED');
    expect(stats.exhausted).toBe(0);
    expect(stats.skipped).toBe(1);
    expect(retryUnknown).not.toHaveBeenCalled();
  });
});
