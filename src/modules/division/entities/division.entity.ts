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
import { jsonColumnType } from '../../../common/utils/column-types';
import { Session } from '../../session/entities/session.entity';

/**
 * One department behind the shared number (e.g. "CS SMP Putra").
 *
 * The row is what the customer is routed to: `name` labels the conversation, `keywords` are the
 * free-text shortcuts a customer may type instead of a menu number, and `sortOrder` fixes both the
 * menu numbering and the tiebreak when two divisions claim the same message. `menuLabel` and
 * `welcomeText` are optional overrides — the name is used when they are absent, so a division is
 * useful the moment it is created.
 *
 * `(sessionId, name)` is unique: two divisions with the same name would make the menu and the
 * keyword match ambiguous for the operator as much as for the customer.
 */
@Entity('divisions')
@Index('UQ_divisions_session_name', ['sessionId', 'name'], { unique: true })
@Index('IDX_divisions_session_sort', ['sessionId', 'sortOrder'])
export class Division {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 100 })
  sessionId!: string;

  // CASCADE: a division has no meaning after its session is gone. The relation exists so TypeORM
  // metadata (and the backup parity gate) sees the same FK the migration creates.
  @ManyToOne(() => Session, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sessionId' })
  session!: Session;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  // Normalised on write (lowercase, punctuation collapsed) and matched as whole token sequences.
  @Column({ type: jsonColumnType(), default: '[]' })
  keywords!: string[];

  // Shown in the numbered menu instead of `name` when set.
  @Column({ type: 'varchar', length: 100, nullable: true })
  menuLabel!: string | null;

  // Sent to the customer once the division is selected. Null means the built-in default.
  @Column({ type: 'text', nullable: true })
  welcomeText!: string | null;

  @Column({ type: 'int', default: 0 })
  sortOrder!: number;

  // An inactive division is skipped by the menu and by keyword matching, and its routed chats fall
  // back to the menu on their next inbound message.
  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
