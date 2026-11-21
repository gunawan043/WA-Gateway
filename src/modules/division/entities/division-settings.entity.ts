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
import { Session } from '../../session/entities/session.entity';

/** The defaults a session uses before anyone opens the routing settings. */
export const DIVISION_DEFAULT_IDLE_HOURS = 24;

/**
 * Per-session routing configuration. One row per session, created on the first PATCH — a session
 * with no row runs on the defaults, so enabling the feature needs no backfill and reads never write.
 *
 * `menuHeader` and `invalidReply` are free text because they are customer-facing and must be
 * writable in the operator's own language. Null means the built-in English default.
 */
@Entity('division_settings')
@Index('UQ_division_settings_session', ['sessionId'], { unique: true })
export class DivisionSettings {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 100 })
  sessionId!: string;

  @ManyToOne(() => Session, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sessionId' })
  session!: Session;

  // Turning this off stops the router entirely: no menu, no keyword matching, and chats already
  // routed keep their division tag and assignee.
  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @Column({ type: 'text', nullable: true })
  menuHeader!: string | null;

  @Column({ type: 'text', nullable: true })
  invalidReply!: string | null;

  // A routed conversation with no inbound message for this long gets the menu again. 0 disables the
  // idle re-prompt (resolving the conversation still re-arms it).
  @Column({ type: 'int', default: DIVISION_DEFAULT_IDLE_HOURS })
  idleHours!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
