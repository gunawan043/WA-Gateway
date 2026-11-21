import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { dateColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';
import { Campaign } from './campaign.entity';

export type CampaignRecipientStatus = 'pending' | 'sent' | 'failed' | 'skipped';

/**
 * One chat a campaign sends to, with its own outcome.
 *
 * `(campaignId, chatId)` is unique, which is what makes a restart safe: resolving the audience again
 * after a crash cannot create a second row for a chat that was already recorded, so the runner only
 * ever picks up rows that are still `pending`. It does not make the WhatsApp send itself exactly-once
 * — a crash between the engine accepting a message and this row being marked `sent` can resend it —
 * but it bounds the damage to the one chunk that was in flight.
 *
 * `batchId` is written BEFORE the bulk batch is created, so a resumed run can ask the (persisted)
 * batch for the outcomes of the recipients it had already attempted instead of sending them again.
 */
@Entity('campaign_recipients')
@Unique('UQ_campaign_recipients_campaign_chat', ['campaignId', 'chatId'])
@Index('IDX_campaign_recipients_campaign_status', ['campaignId', 'status'])
export class CampaignRecipient {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  campaignId!: string;

  @ManyToOne(() => Campaign, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'campaignId' })
  campaign!: Campaign;

  @Column({ type: 'varchar', length: 100 })
  chatId!: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  chatName!: string | null;

  @Column({ type: 'varchar', length: 12, default: 'pending' })
  status!: CampaignRecipientStatus;

  @Column({ type: 'varchar', length: 255, nullable: true })
  batchId!: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  messageId!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  errorCode!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  errorMessage!: string | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  sentAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
