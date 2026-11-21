import { Column, CreateDateColumn, Entity, Index, OneToMany, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { CrmDeal } from './crm-deal.entity';

export type CrmStageKind = 'open' | 'won' | 'lost';

/**
 * A column of the (single) sales pipeline. The gateway is deployed for one company, so there is no
 * pipeline table: stages ARE the pipeline, and their `position` is the display order.
 *
 * `won`/`lost` are ordinary stages; a deal's `status` is DERIVED from the stage it sits in (`kind`),
 * so the board and the status filter can never disagree. The stages are seeded by the migration with
 * fixed ids and are configuration rather than backup payload (see EXPORT_TABLE_EXCLUSIONS).
 */
@Entity('crm_stages')
@Index('IDX_crm_stages_position', ['position'])
export class CrmStage {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 60 })
  name!: string;

  @Column({ type: 'varchar', length: 8, default: 'open' })
  kind!: CrmStageKind;

  @Column({ type: 'int', default: 0 })
  position!: number;

  @Column({ type: 'varchar', length: 20, nullable: true })
  color!: string | null;

  @OneToMany(() => CrmDeal, deal => deal.stage)
  deals!: CrmDeal[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
