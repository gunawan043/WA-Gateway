import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { dateColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';
import { CrmStage } from './crm-stage.entity';

export type CrmDealStatus = 'open' | 'won' | 'lost';

/**
 * A sales opportunity. It may be linked to a WhatsApp chat (`sessionId` + `chatId`), but the link is
 * provenance, not ownership: `sessionId` carries NO foreign key, so deleting a session leaves the
 * deal (and its history) intact rather than cascading it away.
 *
 * `value` is a whole number in `currency` units (not minor units) and an integer column: SQLite and
 * Postgres both return it as a JS number, whereas `bigint` comes back as a string on Postgres and
 * would need a transformer at every read.
 */
@Entity('crm_deals')
@Index('IDX_crm_deals_stage_status', ['stageId', 'status'])
@Index('IDX_crm_deals_chat', ['sessionId', 'chatId'])
export class CrmDeal {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  stageId!: string;

  @ManyToOne(() => CrmStage, stage => stage.deals, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'stageId' })
  stage!: CrmStage;

  @Column({ type: 'varchar', length: 200 })
  title!: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  sessionId!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  chatId!: string | null;

  @Column({ type: 'int', nullable: true })
  value!: number | null;

  @Column({ type: 'varchar', length: 3, default: 'IDR' })
  currency!: string;

  @Column({ type: 'varchar', length: 12, default: 'open' })
  status!: CrmDealStatus;

  @Column({ type: 'varchar', length: 36, nullable: true })
  assigneeKeyId!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  assigneeName!: string | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  expectedCloseAt!: Date | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  closedAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
