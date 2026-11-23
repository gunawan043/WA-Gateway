import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { CrmDeal } from './crm-deal.entity';

export type CrmActivityKind = 'created' | 'stage_change' | 'assignment' | 'note' | 'update';

/** An append-only entry in a deal's history: what changed, who changed it, and when. */
@Entity('crm_deal_activities')
@Index('IDX_crm_deal_activities_deal', ['dealId'])
export class CrmDealActivity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  dealId!: string;

  @ManyToOne(() => CrmDeal, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'dealId' })
  deal!: CrmDeal;

  @Column({ type: 'varchar', length: 20 })
  kind!: CrmActivityKind;

  @Column({ type: 'text', nullable: true })
  body!: string | null;

  @Column({ type: 'varchar', length: 36, nullable: true })
  fromStageId!: string | null;

  @Column({ type: 'varchar', length: 36, nullable: true })
  toStageId!: string | null;

  @Column({ type: 'varchar', length: 36 })
  authorKeyId!: string;

  @Column({ type: 'varchar', length: 100 })
  authorName!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
