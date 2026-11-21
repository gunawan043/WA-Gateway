import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { dateColumnType, jsonColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';

export type CampaignStatus = 'draft' | 'scheduled' | 'running' | 'completed' | 'cancelled' | 'failed';
export type CampaignAudienceKind = 'manual' | 'segment' | 'all' | 'label';
export type CampaignMessageType = 'text' | 'image' | 'video' | 'audio' | 'document';

/** One media reference, the same shape a bulk message item carries. */
export interface CampaignMedia {
  url?: string;
  base64?: string;
  mimetype?: string;
  filename?: string;
  ptt?: boolean;
}

/**
 * The bulk content shape (`text`, `image`, `video`, `audio`, `document`, `caption`) without the
 * recipient. Storing it in this exact form means the runner can hand it straight to
 * `BulkMessageService.createBatch` — no translation layer that could drift from the send contract.
 */
export interface CampaignContentBody {
  text?: string;
  caption?: string;
  image?: CampaignMedia;
  video?: CampaignMedia;
  audio?: CampaignMedia;
  document?: CampaignMedia;
}

export interface CampaignContent {
  type: CampaignMessageType;
  content: CampaignContentBody;
}

export interface CampaignOptions {
  delayBetweenMessages: number;
  randomizeDelay: boolean;
  stopOnError: boolean;
}

/**
 * How the recipient list is produced. `manual` and `segment` carry their chats in the database;
 * `all` is resolved from the session's engine chat list at start time; `label` asks the engine for
 * the chats carrying a WhatsApp label (whatsapp-web.js only).
 */
export interface CampaignAudience {
  kind: CampaignAudienceKind;
  chatIds?: string[];
  segmentId?: string;
  labelId?: string;
}

export interface CampaignProgress {
  total: number;
  sent: number;
  failed: number;
  skipped: number;
}

/**
 * A broadcast to a resolved audience.
 *
 * `sessionId` carries NO foreign key: a campaign is a record of a send, and deleting the session
 * must not erase the history of what was sent (the same rule the CRM deals follow). A campaign for
 * a deleted session can never run again, which is the correct outcome.
 *
 * `progress` is a denormalized counter set from the recipient rows after every chunk, so a list
 * read never has to aggregate the (potentially large) recipient table.
 */
@Entity('campaigns')
@Index('IDX_campaigns_session_created', ['sessionId', 'createdAt'])
@Index('IDX_campaigns_session_status', ['sessionId', 'status'])
export class Campaign {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 100 })
  sessionId!: string;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  @Column({ type: 'varchar', length: 16, default: 'draft' })
  status!: CampaignStatus;

  @Column({ type: jsonColumnType() })
  content!: CampaignContent;

  @Column({ type: jsonColumnType() })
  options!: CampaignOptions;

  @Column({ type: jsonColumnType() })
  audience!: CampaignAudience;

  @Column({ type: jsonColumnType() })
  progress!: CampaignProgress;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  scheduledAt!: Date | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  startedAt!: Date | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  completedAt!: Date | null;

  @Column({ type: 'varchar', length: 36, nullable: true })
  createdByKeyId!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  createdByName!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
