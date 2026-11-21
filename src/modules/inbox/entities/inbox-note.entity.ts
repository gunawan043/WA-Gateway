import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * An internal note on a conversation. Notes are append-only: they record what an agent knew at a
 * point in time, so editing one would rewrite history. Only an admin may delete a note.
 */
@Entity('inbox_notes')
@Index('IDX_inbox_notes_conversationId', ['conversationId'])
export class InboxNote {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  conversationId!: string;

  @Column({ type: 'varchar', length: 36 })
  authorKeyId!: string;

  @Column({ type: 'varchar', length: 100 })
  authorName!: string;

  @Column({ type: 'text' })
  body!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
