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
import { Session } from '../../session/entities/session.entity';

export type InboxConversationStatus = 'open' | 'pending' | 'resolved';

/**
 * Per-(session, chat) inbox state: who owns the conversation and where it stands.
 *
 * A chat with no row here is implicitly `open` and unassigned — the chat list itself lives in the
 * engine, not in a table, so the inbox stores only the fields the engine cannot. That keeps reads
 * free of writes and survives a restart with no reconciliation pass.
 *
 * `assigneeKeyId` points at `api_keys.id` on the MAIN connection. It is deliberately not a foreign
 * key: the two tables live in different databases (and different engines), and an API key can be
 * deleted while its conversations remain. `assigneeName` is a snapshot of the key's name at
 * assignment time so the list still reads correctly after a rename or revocation.
 */
@Entity('inbox_conversations')
@Index('UQ_inbox_conversations_session_chat', ['sessionId', 'chatId'], { unique: true })
@Index('IDX_inbox_conversations_session_status', ['sessionId', 'status'])
@Index('IDX_inbox_conversations_session_assignee', ['sessionId', 'assigneeKeyId'])
@Index('IDX_inbox_conversations_session_division', ['sessionId', 'divisionId'])
@Index('IDX_inbox_conversations_sla_due', ['slaDueAt'])
@Index('IDX_inbox_conversations_session_first_inbound', ['sessionId', 'firstInboundAt'])
export class InboxConversation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 100 })
  sessionId!: string;

  // CASCADE: an inbox row has no meaning after its session is gone. The relation exists so TypeORM
  // metadata (and the backup parity gate) sees the same FK the migration creates.
  @ManyToOne(() => Session, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sessionId' })
  session!: Session;

  @Column({ type: 'varchar', length: 100 })
  chatId!: string;

  @Column({ type: 'varchar', length: 16, default: 'open' })
  status!: InboxConversationStatus;

  @Column({ type: 'varchar', length: 36, nullable: true })
  assigneeKeyId!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  assigneeName!: string | null;

  // The division this conversation was routed to, with the same no-FK/snapshot convention as the
  // assignee: `divisions` lives on this connection, but a division can be deleted while its chats
  // remain, and the tag must stay readable after that.
  @Column({ type: 'varchar', length: 36, nullable: true })
  divisionId!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  divisionName!: string | null;

  // ---- first-response SLA -------------------------------------------------------------------
  //
  // The clock is stored, not derived: `slaDueAt` is fixed when a customer message starts a window,
  // so editing the division's target later cannot move a deadline that already passed or rescue one
  // that did not. `slaMinutes` is the target snapshot for the same reason — it is what the window was
  // measured against, not what the division says today.
  //
  // A window opens on an inbound message while nobody has answered, restarts on a newer inbound
  // while it is still open, and stops on the first human outbound reply. `slaBreachedAt` is written
  // once by the sweeper and never cleared, so a late answer still leaves the breach on the record.

  // First inbound message ever seen for this chat (reports: time to first response).
  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  firstInboundAt!: Date | null;

  // First human reply after the current window opened.
  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  firstResponseAt!: Date | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  slaStartedAt!: Date | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  slaDueAt!: Date | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  slaBreachedAt!: Date | null;

  @Column({ type: 'int', nullable: true })
  slaMinutes!: number | null;

  // Set when the status becomes `resolved`; the list uses it to decide whether newer inbound
  // activity should reopen the conversation.
  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  resolvedAt!: Date | null;

  // Epoch instant of the newest inbound message seen by the gateway for this chat. Updated by the
  // reconciler, never by a read path.
  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  lastInboundAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
