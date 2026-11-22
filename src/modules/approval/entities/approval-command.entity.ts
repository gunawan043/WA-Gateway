import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { dateColumnType, jsonColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';

/**
 * Buku besar command yang dikirim ke Core.
 *
 * `commandId` dan `externalMessageId` unik: satu pesan WhatsApp tidak pernah
 * menghasilkan dua command, dan pengiriman ulang memakai `commandId` yang sama
 * sehingga Core dapat menjawabnya sebagai duplikat, bukan keputusan baru.
 */
export type ApprovalCommandStatus = 'PENDING' | 'SENT' | 'APPLIED' | 'DUPLICATE' | 'REJECTED' | 'FAILED' | 'UNKNOWN';

/**
 * Lima nilai `decision` pada kontrak final Core. Hanya `approved` dan `rejected` yang boleh
 * berasal dari balasan WhatsApp; tiga sisanya milik proses internal yang berwenang.
 */
export type ApprovalDecision = 'approved' | 'rejected' | 'needs_clarification' | 'expired' | 'cancelled';

@Entity('approval_commands')
@Index('UQ_approval_commands_command', ['commandId'], { unique: true })
@Index('UQ_approval_commands_external_message', ['externalMessageId'], { unique: true })
@Index('IDX_approval_commands_request', ['approvalRequestId', 'createdAt'])
@Index('IDX_approval_commands_retry', ['status', 'nextAttemptAt'])
export class ApprovalCommand {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 100 })
  commandId!: string;

  @Column({ type: 'varchar', length: 36 })
  approvalRequestId!: string;

  @Column({ type: 'varchar', length: 191 })
  externalMessageId!: string;

  @Column({ type: 'varchar', length: 16 })
  decision!: ApprovalDecision;

  @Column({ type: 'int', nullable: true })
  durationDays!: number | null;

  @Column({ type: 'varchar', length: 16, default: 'PENDING' })
  status!: ApprovalCommandStatus;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'int', nullable: true })
  coreResponseCode!: number | null;

  @Column({ type: jsonColumnType(), nullable: true })
  coreResponseBody!: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  errorCode!: string | null;

  /** Pesan kegagalan terakhir; dipakai pemeriksaan manual saat retry habis. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  lastError!: string | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  lastAttemptAt!: Date | null;

  /** Retry berikutnya tidak boleh lebih awal dari waktu ini; juga berfungsi sebagai lease. */
  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  nextAttemptAt!: Date | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  sentAt!: Date | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  resolvedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
