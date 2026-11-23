import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * Kolom retry untuk `approval_commands` (aditif).
 *
 * Command yang hasilnya belum diketahui Core disimpan sebagai `UNKNOWN`; worker retry memakai
 * `nextAttemptAt` sebagai jadwal sekaligus lease, sehingga dua proses tidak memproses baris yang
 * sama dan proses yang mati di tengah jalan tetap dicoba lagi setelah lease habis.
 */
export class AddApprovalCommandRetry1792500000000 implements MigrationInterface {
  name = 'AddApprovalCommandRetry1792500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('approval_commands'))) {
      return;
    }

    const isPostgres = queryRunner.dataSource.options.type === 'postgres';
    const stamp = isPostgres ? 'timestamp' : 'datetime';

    const columns: TableColumn[] = [
      new TableColumn({ name: 'lastError', type: 'varchar', length: '500', isNullable: true }),
      new TableColumn({ name: 'lastAttemptAt', type: stamp, isNullable: true }),
      new TableColumn({ name: 'nextAttemptAt', type: stamp, isNullable: true }),
    ];

    for (const column of columns) {
      if (!(await queryRunner.hasColumn('approval_commands', column.name))) {
        await queryRunner.addColumn('approval_commands', column);
      }
    }

    // Guard ini bukan hiasan: tanpa itu, `up()` gagal dengan "index already exists" bila indeks
    // dibuat di luar ledger (restore parsial, atau migrasi yang dijalankan manual setelah kolom
    // ditambahkan). Menambahkan guard ke migrasi yang sudah tercatat aman karena TypeORM menyimpan
    // nama dan timestamp migrasi, bukan checksum isinya: database yang sudah menjalankan migrasi ini
    // tidak akan menjalankannya lagi, sedangkan database baru mendapat `up()` yang idempoten.
    const table = await queryRunner.getTable('approval_commands');
    const hasRetryIndex = table?.indices.some(index => index.name === 'IDX_approval_commands_retry') ?? false;

    if (!hasRetryIndex) {
      await queryRunner.createIndex(
        'approval_commands',
        new TableIndex({ name: 'IDX_approval_commands_retry', columnNames: ['status', 'nextAttemptAt'] }),
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('approval_commands'))) {
      return;
    }

    const table = await queryRunner.getTable('approval_commands');
    const index = table?.indices.find(candidate => candidate.name === 'IDX_approval_commands_retry');

    if (index) {
      await queryRunner.dropIndex('approval_commands', index);
    }

    for (const name of ['nextAttemptAt', 'lastAttemptAt', 'lastError']) {
      if (await queryRunner.hasColumn('approval_commands', name)) {
        await queryRunner.dropColumn('approval_commands', name);
      }
    }
  }
}
