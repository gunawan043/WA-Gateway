import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { dateColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';

/**
 * Pemetaan identitas WhatsApp ke personel Core yang sudah diverifikasi.
 *
 * Connect hanya boleh mengaitkan balasan ke identitas GTK lewat baris yang
 * `isVerified` dan `isActive`. Nomor yang belum terpetakan tidak pernah
 * dianggap sebagai approver.
 */
@Entity('whatsapp_identities')
@Index('UQ_whatsapp_identities_external', ['externalIdentity'], { unique: true })
@Index('IDX_whatsapp_identities_core_person', ['corePersonId'])
export class WhatsAppIdentity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Nomor ternormalisasi (digit E.164), mis. `6281234567890`. */
  @Column({ type: 'varchar', length: 191 })
  externalIdentity!: string;

  /** UUID user Core (satu-satunya identitas yang dipercaya Core). */
  @Column({ type: 'varchar', length: 36 })
  corePersonId!: string;

  @Column({ type: 'varchar', length: 191, nullable: true })
  displayName!: string | null;

  @Column({ type: 'boolean', default: false })
  isVerified!: boolean;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  verifiedAt!: Date | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  lastSeenAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
