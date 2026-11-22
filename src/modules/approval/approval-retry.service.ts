import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThanOrEqual, Repository } from 'typeorm';
import { createLogger } from '../../common/services/logger.service';
import { recordApprovalCommand, recordApprovalRetryAttempt } from '../../common/metrics/approval-metrics';
import { DateTransformer } from '../../common/transformers/date.transformer';
import { startGuardedInterval } from '../../common/utils/guarded-interval';
import { ApprovalProcessorService } from './approval-processor.service';
import { readRetryPolicy, RETRY_EXHAUSTED_MESSAGE } from './approval-retry.policy';
import { ApprovalCommand, ApprovalCommandStatus } from './entities/approval-command.entity';

/**
 * Status yang masih boleh diproses worker.
 *
 * `PENDING` ikut di sini karena command disimpan sebelum dikirim: proses yang mati di antara
 * keduanya meninggalkan baris PENDING, dan lease (`nextAttemptAt`) memastikan worker baru
 * menyentuhnya setelah pengirim aslinya jelas tidak lagi bekerja.
 */
const RECOVERABLE: readonly ApprovalCommandStatus[] = ['PENDING', 'UNKNOWN'];

export interface ApprovalRetryStats {
  scanned: number;
  retried: number;
  skipped: number;
  resolved: number;
  exhausted: number;
}

/**
 * Retry worker untuk command yang hasilnya belum diketahui (`UNKNOWN`).
 *
 * Memakai scheduler yang sudah ada (`startGuardedInterval`), bukan queue baru: satu pass
 * berjalan pada satu waktu di proses ini, dan `nextAttemptAt` berfungsi sebagai lease
 * sehingga dua proses yang berbagi database tidak memproses baris yang sama.
 *
 * Keamanan yang dijaga:
 *  - command yang sama dikirim ulang dengan `commandId` dan `externalMessageId` yang sama;
 *  - Core menjawab `duplicate` untuk replay, dan itu diperlakukan sebagai hasil yang sah;
 *  - proses yang mati di tengah pengiriman meninggalkan lease yang habis sendiri;
 *  - setelah batas percobaan, command ditandai `FAILED` dan menunggu pemeriksaan manual.
 */
@Injectable()
export class ApprovalRetryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger(ApprovalRetryService.name);
  private stop?: () => void;

  constructor(
    @InjectRepository(ApprovalCommand, 'data')
    private readonly commands: Repository<ApprovalCommand>,
    private readonly processor: ApprovalProcessorService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const intervalMs = this.numberSetting('connect.approval.retry.intervalMs', 60_000);

    if (intervalMs <= 0) {
      this.logger.log('Retry command persetujuan dinonaktifkan (interval 0).');

      return;
    }

    this.stop = startGuardedInterval(
      () => this.runOnce(),
      intervalMs,
      error => this.logger.error(`Pass retry persetujuan gagal: ${String(error)}`),
    );
  }

  onModuleDestroy(): void {
    this.stop?.();
    this.stop = undefined;
  }

  /** Satu pass; dipanggil scheduler dan dapat dipanggil langsung oleh tes. */
  async runOnce(now: Date = new Date()): Promise<ApprovalRetryStats> {
    const policy = readRetryPolicy(this.config);
    const batchSize = this.numberSetting('connect.approval.retry.batchSize', 20);

    const due = await this.commands.find({
      where: [
        { status: In(RECOVERABLE), nextAttemptAt: LessThanOrEqual(now) },
        // `nextAttemptAt` NULL berarti command lama yang belum pernah dijadwalkan ulang.
        { status: 'UNKNOWN', nextAttemptAt: IsNull() },
      ],
      order: { nextAttemptAt: 'ASC' },
      take: Math.min(Math.max(batchSize, 1), 200),
    });

    const stats: ApprovalRetryStats = { scanned: due.length, retried: 0, skipped: 0, resolved: 0, exhausted: 0 };

    for (const command of due) {
      if (command.attempts >= policy.maxAttempts) {
        if (await this.parkForManualReview(command)) {
          stats.exhausted += 1;
        } else {
          // Proses lain sudah menyelesaikan baris ini di antara pembacaan dan penulisan.
          stats.skipped += 1;
        }

        continue;
      }

      // Klaim baris: hanya satu proses yang boleh mengirim pada jendela lease ini.
      // Parameter perbandingan harus berbentuk sama dengan isi kolom. `andWhere` tidak melewati
      // `DateTransformer` seperti `.set()`/`find`, jadi konversinya dilakukan di sini: PostgreSQL
      // menyimpan `Date` apa adanya (driver menuliskannya sebagai waktu lokal), SQLite menyimpan
      // teks ISO. Memakai `toISOString()` membuat Postgres membandingkan waktu naif dengan waktu
      // lokal — selisih zona waktu membuat klaim tidak pernah cocok dan worker diam saja.
      const claimBoundary = DateTransformer.to(now) as string | Date;

      const claimed = await this.commands
        .createQueryBuilder()
        .update(ApprovalCommand)
        .set({ nextAttemptAt: new Date(now.getTime() + policy.leaseMs) })
        .where('id = :id', { id: command.id })
        .andWhere('status IN (:...statuses)', { statuses: [...RECOVERABLE] })
        .andWhere('(nextAttemptAt IS NULL OR nextAttemptAt <= :now)', { now: claimBoundary })
        .execute();

      if (claimed.affected !== 1) {
        stats.skipped += 1;
        continue;
      }

      stats.retried += 1;
      recordApprovalRetryAttempt();

      try {
        const outcome = await this.processor.retryUnknown(command.commandId);

        if (outcome === 'applied') {
          stats.resolved += 1;
        } else if (outcome === 'core_unavailable') {
          const after = await this.commands.findOne({ where: { id: command.id } });

          if (after?.status === 'FAILED') {
            stats.exhausted += 1;
          }
        }
      } catch (error) {
        // Pengiriman gagal sebelum Core menjawab: kembalikan ke antrean dengan jeda
        // berikutnya, jangan pernah menandainya selesai.
        await this.commands
          .createQueryBuilder()
          .update(ApprovalCommand)
          .set({
            lastError: String(error).slice(0, 500),
            nextAttemptAt: new Date(now.getTime() + policy.leaseMs),
          })
          .where('id = :id', { id: command.id })
          .andWhere('status IN (:...statuses)', { statuses: [...RECOVERABLE] })
          .execute();

        this.logger.warn(`Retry command ${command.commandId} gagal: ${String(error)}`);
      }
    }

    return stats;
  }

  /**
   * Parkir command untuk pemeriksaan manual.
   *
   * Update bersyarat: hanya baris yang masih dapat diproses yang boleh menjadi `FAILED`.
   * Tanpa syarat itu, pass yang membaca baris lama dapat menimpa keputusan yang baru saja
   * ditetapkan proses lain (APPLIED/REJECTED) dan menghapus hasil yang sah.
   */
  private async parkForManualReview(command: ApprovalCommand): Promise<boolean> {
    const parked = await this.commands
      .createQueryBuilder()
      .update(ApprovalCommand)
      .set({
        status: 'FAILED',
        nextAttemptAt: null,
        lastError: command.lastError ?? RETRY_EXHAUSTED_MESSAGE,
      })
      .where('id = :id', { id: command.id })
      .andWhere('status IN (:...statuses)', { statuses: [...RECOVERABLE] })
      .execute();

    if (parked.affected === 1) {
      recordApprovalCommand('failed');
    }

    return parked.affected === 1;
  }

  private numberSetting(key: string, fallback: number): number {
    const value = this.config.get<number>(key);

    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
  }
}
