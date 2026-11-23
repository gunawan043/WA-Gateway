import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Division } from './division.entity';

/**
 * Membership of an API key in a division.
 *
 * `apiKeyId` points at `api_keys.id` on the MAIN connection and deliberately carries NO foreign
 * key: the two tables live in different databases, and a key can be revoked while its division
 * membership remains. `agentName` is a snapshot taken at membership time, the same convention
 * `inbox_conversations.assigneeName` follows, so the list still reads correctly after a rename.
 *
 * `createdAt` orders the round-robin tiebreak: the least busy agent wins, and the longest-standing
 * member wins a tie.
 */
@Entity('division_agents')
@Index('UQ_division_agents_division_key', ['divisionId', 'apiKeyId'], { unique: true })
export class DivisionAgent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  divisionId!: string;

  @ManyToOne(() => Division, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'divisionId' })
  division!: Division;

  @Column({ type: 'varchar', length: 36 })
  apiKeyId!: string;

  @Column({ type: 'varchar', length: 100 })
  agentName!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
