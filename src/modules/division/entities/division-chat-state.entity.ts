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
import { dateColumnType, jsonColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';
import { Session } from '../../session/entities/session.entity';
import { Division } from './division.entity';

/** `awaiting` = the customer has been shown the menu and has not chosen; `routed` = chosen. */
export type DivisionChatStatus = 'awaiting' | 'routed';

/**
 * Routing state for one chat: whether it is waiting for a choice and which division it reached.
 *
 * A chat with no row has never been routed and is treated as `awaiting` with no prompt yet, so the
 * first inbound message writes this row exactly once. `menuDivisionIds` records the divisions the
 * customer was actually shown: a numeric reply resolves against that list, not against the current
 * one, so adding a division between the prompt and the reply cannot silently misroute the answer.
 *
 * `divisionId` carries a real FK with SET NULL (unlike the inbox tag): deleting a division must not
 * delete the chat state, it only makes the next message re-prompt.
 */
@Entity('division_chat_states')
@Index('UQ_division_chat_states_session_chat', ['sessionId', 'chatId'], { unique: true })
export class DivisionChatState {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // No `length`: the column is also the join column of the `Session` relation below, and
  // TypeORM derives a relation-backed FK's type from the referenced primary key. Declaring a
  // length there makes the metadata invalid on PostgreSQL ("does not support length
  // property"). `varchar` without a limit is what webhooks/templates already do.
  @Column({ type: 'varchar' })
  sessionId!: string;

  @ManyToOne(() => Session, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sessionId' })
  session!: Session;

  @Column({ type: 'varchar', length: 100 })
  chatId!: string;

  @Column({ type: 'varchar', length: 16, default: 'awaiting' })
  status!: DivisionChatStatus;

  @Column({ type: 'varchar', nullable: true })
  divisionId!: string | null;

  @ManyToOne(() => Division, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'divisionId' })
  division!: Division | null;

  // The ids the customer saw, in menu order.
  @Column({ type: jsonColumnType(), nullable: true })
  menuDivisionIds!: string[] | null;

  // When the menu was last sent. Also the claim a concurrent message tests before sending another.
  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  promptedAt!: Date | null;

  // The invalid-reply hint is sent at most once per prompt, so a confused customer is not spammed.
  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  invalidReplyAt!: Date | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  routedAt!: Date | null;

  // Throttled to one write a minute: the idle re-prompt needs hour precision, not message precision.
  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  lastInboundAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
