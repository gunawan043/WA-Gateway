/* istanbul ignore file -- PG-gated: only runs under DATABASE_TYPE=postgres (test-postgres CI job);
   skipped in the default test job, so its lines would be unread and skew the global coverage gate. */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource, DataSourceOptions, Repository } from 'typeorm';
import { ApprovalRetryService } from './approval-retry.service';
import { ApprovalCommand } from './entities/approval-command.entity';
import type { ApprovalProcessorService } from './approval-processor.service';
import { CreateApprovalWorkflow1792400000000 } from '../../database/migrations/1792400000000-CreateApprovalWorkflow';
import { AddApprovalCommandRetry1792500000000 } from '../../database/migrations/1792500000000-AddApprovalCommandRetry';
import { AddApprovalLookupIndexes1792600000000 } from '../../database/migrations/1792600000000-AddApprovalLookupIndexes';

/**
 * Perilaku retry worker pada PostgreSQL — dialect yang dipakai deployment.
 *
 * Yang diuji hanya ada di server: `UPDATE ... WHERE` bersyarat beserta `affected` rows, klaim
 * baris oleh dua worker bersamaan, dan lease `nextAttemptAt` sebagai pengganti lock. SQLite
 * menjalankan test yang sama di `approval-retry.service.spec.ts`, tetapi ia tidak membuktikan
 * perilaku dua koneksi terhadap satu baris.
 *
 * Database sendiri (`openwa_approval_retry_probe`), bukan database yang dipakai suite PG lain:
 * kedua migration dijalankan dari nol di sini, lalu di-revert, sehingga `down()` ikut terbukti
 * dan database bersama tidak tersentuh.
 */
const POSTGRES_ENABLED = process.env.DATABASE_TYPE === 'postgres';

/** Dinamai menurut suite-nya supaya proses yang mati meninggalkan database yang jelas, bukan misteri. */
const SCRATCH_DB = 'openwa_approval_retry_probe';

const connection = (database: string): DataSourceOptions => ({
  type: 'postgres',
  host: process.env.DATABASE_HOST || 'localhost',
  port: Number(process.env.DATABASE_PORT || 5432),
  username: process.env.DATABASE_USERNAME || 'openwa',
  password: process.env.DATABASE_PASSWORD || 'openwa',
  database,
  // Managed Postgres (Supabase/Render/Railway) menuntut TLS; pakai switch yang sama dengan aplikasi.
  ...(process.env.DATABASE_SSL === 'true'
    ? { ssl: { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' } }
    : {}),
});

interface IdRow {
  id: string;
}

interface RegclassRow {
  table: string | null;
}

(POSTGRES_ENABLED ? describe : describe.skip)('Approval retry worker on PostgreSQL', () => {
  let admin: DataSource;
  let scratch: DataSource;
  let commands: Repository<ApprovalCommand>;
  let retryUnknown: jest.Mock;
  let service: ApprovalRetryService;
  let settings: Record<string, number>;

  const NOW = new Date('2026-11-22T02:00:00.000Z');

  // Hook diberi waktu lebih panjang: membuat database dan menjalankan DDL di server jarak jauh
  // memakan puluhan detik, jauh di atas default 5 dtk yang ditujukan untuk unit test lokal.
  beforeAll(async () => {
    admin = new DataSource(connection(process.env.DATABASE_NAME || 'openwa'));
    await admin.initialize();
    // CREATE/DROP DATABASE tidak boleh di dalam transaksi, jadi dijalankan pada koneksi admin.
    await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${SCRATCH_DB}"`);

    scratch = new DataSource({
      ...connection(SCRATCH_DB),
      entities: [ApprovalCommand],
      migrations: [
        CreateApprovalWorkflow1792400000000,
        AddApprovalCommandRetry1792500000000,
        AddApprovalLookupIndexes1792600000000,
      ],
      synchronize: false,
    });
    await scratch.initialize();
    await scratch.runMigrations();
  }, 180_000);

  afterAll(async () => {
    if (scratch?.isInitialized) {
      // Validasi `down()` sebelum database dibuang: ketiga migration harus bisa dicabut bersih.
      await scratch.undoLastMigration();
      await scratch.undoLastMigration();
      await scratch.undoLastMigration();
      const [left] = await scratch.query<RegclassRow[]>(`SELECT to_regclass('public.approval_commands') AS "table"`);

      if (left.table !== null) throw new Error('down() tidak menghapus approval_commands');

      await scratch.destroy();
    }

    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
      await admin.destroy();
    }
  }, 180_000);

  beforeEach(async () => {
    commands = scratch.getRepository(ApprovalCommand);
    await commands.query('DELETE FROM approval_commands');
    retryUnknown = jest.fn().mockResolvedValue('applied');
    settings = {
      'connect.approval.retry.intervalMs': 60_000,
      'connect.approval.retry.batchSize': 20,
      'connect.approval.retry.maxAttempts': 5,
      'connect.approval.retry.baseDelayMs': 30_000,
      'connect.approval.retry.maxDelayMs': 900_000,
      'connect.approval.retry.leaseMs': 60_000,
    };
    service = new ApprovalRetryService(
      commands,
      { retryUnknown } as unknown as ApprovalProcessorService,
      {
        get: (key: string, fallback?: number) => settings[key] ?? fallback,
      } as never,
    );
  });

  async function seed(overrides: Partial<ApprovalCommand> = {}): Promise<ApprovalCommand> {
    return commands.save(
      commands.create({
        commandId: `cmd-${randomUUID()}`,
        approvalRequestId: randomUUID(),
        externalMessageId: `wamid.${randomUUID()}`,
        decision: 'approved',
        durationDays: 2,
        status: 'UNKNOWN',
        attempts: 1,
        nextAttemptAt: new Date(NOW.getTime() - 1000),
        ...overrides,
      }),
    );
  }

  it('mengisi id ketiga tabel lewat DEFAULT gen_random_uuid()', async () => {
    const [identity] = await scratch.query<IdRow[]>(
      `INSERT INTO whatsapp_identities ("externalIdentity", "corePersonId") VALUES ($1, $2) RETURNING id`,
      ['628111222333', randomUUID()],
    );
    const [request] = await scratch.query<IdRow[]>(
      `INSERT INTO approval_requests ("coreRequestId", reference, "studentName", "permitType") VALUES ($1, $2, $3, $4) RETURNING id`,
      [randomUUID(), 'IZN-2026-00999', 'Ahmad', 'pulang'],
    );
    const [command] = await scratch.query<IdRow[]>(
      `INSERT INTO approval_commands ("commandId", "approvalRequestId", "externalMessageId", decision) VALUES ($1, $2, $3, $4) RETURNING id`,
      [randomUUID(), request.id, `wamid.${randomUUID()}`, 'approved'],
    );

    for (const row of [identity, request, command]) {
      expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    }
  });

  /**
   * Semantik waktu harus disengaja, bukan kebetulan.
   *
   * Kolom waktu approval adalah `timestamp` (tanpa zona). Driver menuliskan `Date` memakai waktu
   * lokal proses dan PostgreSQL mengabaikan offset pada kolom `timestamp`, sedangkan `DEFAULT
   * (NOW())` — `timestamptz` yang di-cast — memakai zona sesi. Dua sumber jam ini hanya konsisten
   * bila proses dan sesi memakai zona yang sama. Test ini mengunci tipe kolomnya supaya perubahan
   * ke `timestamptz` (yang menghapus ketergantungan itu) harus disengaja dan disertai migration.
   */
  it('menyimpan waktu approval sebagai timestamp tanpa zona', async () => {
    const rows = await scratch.query<{ table_name: string; column_name: string; data_type: string }[]>(
      `SELECT table_name, column_name, data_type
         FROM information_schema.columns
        WHERE table_name IN ('whatsapp_identities', 'approval_requests', 'approval_commands')
          AND data_type LIKE 'timestamp%'
        ORDER BY table_name, column_name`,
    );

    expect(rows.length).toBeGreaterThan(10);
    expect([...new Set(rows.map(row => row.data_type))]).toEqual(['timestamp without time zone']);
  });

  it('mengirim ulang command UNKNOWN dengan commandId yang sama', async () => {
    const command = await seed();

    const stats = await service.runOnce(NOW);

    expect(retryUnknown).toHaveBeenCalledWith(command.commandId);
    expect(stats).toMatchObject({ scanned: 1, retried: 1, resolved: 1 });
  });

  it('memulihkan command PENDING yang ditinggal proses mati setelah lease habis', async () => {
    const command = await seed({ status: 'PENDING', attempts: 0 });

    const stats = await service.runOnce(NOW);

    expect(retryUnknown).toHaveBeenCalledWith(command.commandId);
    expect(stats.retried).toBe(1);
  });

  it('tidak menyentuh command yang lease-nya masih berjalan', async () => {
    await seed({ nextAttemptAt: new Date(NOW.getTime() + 60_000) });

    expect((await service.runOnce(NOW)).scanned).toBe(0);
    expect(retryUnknown).not.toHaveBeenCalled();
  });

  // Batas waktu eksplisit: pass pertama sengaja ditahan sampai pass kedua selesai, dan
  // round-trip ke server jarak jauh tidak muat dalam 5 dtk default.
  it('hanya satu pass yang mengklaim baris saat dua worker berjalan bersamaan', async () => {
    await seed();

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
    await claimed;
    const second = await service.runOnce(NOW);
    release();
    await first;

    expect(retryUnknown).toHaveBeenCalledTimes(1);
    expect(second.retried).toBe(0);
  }, 60_000);

  it('tidak menimpa status final saat batas percobaan tercapai', async () => {
    const command = await seed({ attempts: 5 });

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
  });

  it('memarkir command yang benar-benar habis untuk pemeriksaan manual', async () => {
    const command = await seed({ attempts: 5 });

    const stats = await service.runOnce(NOW);

    const after = await commands.findOneByOrFail({ id: command.id });
    expect(after.status).toBe('FAILED');
    expect(after.nextAttemptAt).toBeNull();
    expect(after.lastError).toMatch(/Batas percobaan/);
    expect(stats.exhausted).toBe(1);
  });

  it('membuat indeks pencarian dan tetap idempoten bila dijalankan ulang', async () => {
    const indexes: Array<{ indexname: string }> = await scratch.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'approval_requests'`,
    );
    const names = indexes.map(row => row.indexname);

    expect(names).toEqual(
      expect.arrayContaining(['IDX_approval_requests_notification', 'IDX_approval_requests_target_created']),
    );

    // Restore parsial: objek ada tetapi entri ledger hilang. `up()` harus melewati, bukan gagal.
    const runner = scratch.createQueryRunner();
    try {
      await expect(new AddApprovalLookupIndexes1792600000000().up(runner)).resolves.toBeUndefined();
      await expect(new AddApprovalCommandRetry1792500000000().up(runner)).resolves.toBeUndefined();
    } finally {
      await runner.release();
    }
  });
});
