import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { dateColumnType, jsonColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';

/**
 * Status internal Connect untuk satu permohonan izin.
 *
 * Status izin yang sah tetap milik Core (`coreStatus`). Nilai di sini hanya
 * menggambarkan posisi alur WhatsApp dan tidak pernah menjadi keputusan final.
 */
export type ApprovalRequestStatus =
  'PENDING_APPROVAL' | 'PROCESSING' | 'APPROVED' | 'REJECTED' | 'NEEDS_CLARIFICATION' | 'EXPIRED' | 'CANCELLED';

@Entity('approval_requests')
@Index('UQ_approval_requests_core_request', ['coreRequestId'], { unique: true })
@Index('UQ_approval_requests_reference', ['reference'], { unique: true })
@Index('IDX_approval_requests_status', ['status'])
@Index('IDX_approval_requests_target_status', ['targetCorePersonId', 'status'])
export class ApprovalRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** UUID `dormitory_permits.id` di Core. */
  @Column({ type: 'varchar', length: 36 })
  coreRequestId!: string;

  /** Referensi manusiawi yang dikutip di pesan WhatsApp, mis. `IZN-2026-00125`. */
  @Column({ type: 'varchar', length: 64 })
  reference!: string;

  @Column({ type: 'varchar', length: 191 })
  studentName!: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  studentClass!: string | null;

  @Column({ type: 'varchar', length: 36, nullable: true })
  dormitoryCoreId!: string | null;

  @Column({ type: 'varchar', length: 191, nullable: true })
  dormitoryName!: string | null;

  @Column({ type: 'varchar', length: 64 })
  permitType!: string;

  @Column({ type: 'int', nullable: true })
  requestedDurationDays!: number | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  departureAt!: Date | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  expectedReturnAt!: Date | null;

  @Column({ type: 'varchar', length: 32, default: 'PENDING_APPROVAL' })
  status!: ApprovalRequestStatus;

  /** Status izin versi Core pada sinkronisasi terakhir. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  coreStatus!: string | null;

  /** UUID user Core yang dituju (Kepala Asrama berwenang). */
  @Column({ type: 'varchar', length: 36, nullable: true })
  targetCorePersonId!: string | null;

  /** Nomor WhatsApp tujuan setelah normalisasi. */
  @Column({ type: 'varchar', length: 191, nullable: true })
  targetIdentity!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  sessionId!: string | null;

  /** WhatsApp message id notifikasi; dipakai untuk mencocokkan balasan (reply-to). */
  @Column({ type: 'varchar', length: 191, nullable: true })
  notificationMessageId!: string | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  notificationSentAt!: Date | null;

  @Column({ type: 'int', default: 0 })
  clarificationCount!: number;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  decidedAt!: Date | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  decisionSource!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  lastCommandId!: string | null;

  @Column({ type: jsonColumnType(), nullable: true })
  metadata!: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
