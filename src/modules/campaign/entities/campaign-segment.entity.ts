import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { jsonColumnType } from '../../../common/utils/column-types';

/**
 * A saved, reusable recipient list for one session.
 *
 * Segments store explicit chat ids rather than a query: WhatsApp offers no server-side audience
 * language, and a stored list makes a campaign's audience reproducible even after chats change. The
 * runner still re-resolves the ids against the session's live chat list at start time, so a segment
 * that names a chat the account has since lost is skipped rather than attempted.
 */
@Entity('campaign_segments')
@Index('IDX_campaign_segments_session', ['sessionId'])
export class CampaignSegment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 100 })
  sessionId!: string;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  @Column({ type: jsonColumnType() })
  chatIds!: string[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
