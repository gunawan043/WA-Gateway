import { MigrationInterface, QueryRunner, TableIndex } from 'typeorm';

/**
 * Indeks pencarian yang dipakai setiap balasan WhatsApp (aditif).
 *
 * Reply resolver membaca `approval_requests` lewat dua jalur yang sebelumnya tidak berindeks:
 *
 *  - `notificationMessageId` + `targetIdentity` — balasan langsung (reply-to) ke pesan notifikasi.
 *    Ini jalur terkuat dan paling sering dipakai; tanpa indeks setiap balasan memindai seluruh
 *    tabel. Kedua kolom ada di indeks karena resolver memfilter keduanya.
 *  - `targetIdentity` + `createdAt` — jalan pintas "tepat satu permohonan terbuka". Yang ada hanya
 *    indeks pada `targetCorePersonId`, bukan nomor WhatsApp. `createdAt` ikut di indeks supaya
 *    `ORDER BY createdAt DESC LIMIT 5` membaca urutan yang sudah tersedia, bukan menyortir seluruh
 *    baris milik satu pengirim; `status` tinggal menjadi filter sisa.
 *
 * Bentuk kolom dipilih dari pengukuran, bukan dugaan: `scripts/approval-lookup-bench.ts` menunjukkan
 * `(targetIdentity, status)` masih menyisakan `USE TEMP B-TREE FOR ORDER BY`, sedangkan
 * `(targetIdentity, createdAt)` menghapusnya. Keduanya murni menambah indeks baca — tidak ada kolom,
 * baris, atau perilaku yang berubah. `down()` hanya menjatuhkan indeks yang memang ada.
 */
export class AddApprovalLookupIndexes1792600000000 implements MigrationInterface {
  name = 'AddApprovalLookupIndexes1792600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('approval_requests'))) {
      return;
    }

    const indexes: TableIndex[] = [
      new TableIndex({
        name: 'IDX_approval_requests_notification',
        columnNames: ['notificationMessageId', 'targetIdentity'],
      }),
      new TableIndex({
        name: 'IDX_approval_requests_target_created',
        columnNames: ['targetIdentity', 'createdAt'],
      }),
    ];

    for (const index of indexes) {
      // Dibaca ulang tiap putaran: `getTable` mengembalikan snapshot, dan indeks pertama sudah
      // mengubah tabel sebelum indeks kedua diperiksa.
      const table = await queryRunner.getTable('approval_requests');

      if (!table?.indices.some(existing => existing.name === index.name)) {
        await queryRunner.createIndex('approval_requests', index);
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('approval_requests'))) {
      return;
    }

    const table = await queryRunner.getTable('approval_requests');

    for (const name of ['IDX_approval_requests_target_created', 'IDX_approval_requests_notification']) {
      const index = table?.indices.find(candidate => candidate.name === name);

      if (index) {
        await queryRunner.dropIndex('approval_requests', index);
      }
    }
  }
}
