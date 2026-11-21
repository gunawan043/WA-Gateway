import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

/**
 * One dashboard sign-in.
 *
 * The raw token (`owa_s1_<64 hex>`) is returned to the browser once and stored here only as a
 * SHA-256/HMAC hash, the same treatment `api_keys.keyHash` gets. The row is revocable and expires,
 * which is what makes "log out" and "reset that user's password" actually cut a live session off.
 *
 * Lives on the `main` connection (always SQLite), next to `users`.
 */
@Entity('user_sessions')
@Index('UQ_user_sessions_tokenHash', ['tokenHash'], { unique: true })
@Index('IDX_user_sessions_userId', ['userId'])
export class UserSession {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  userId!: string;

  @Column({ type: 'varchar', length: 64 })
  tokenHash!: string;

  @Column({ type: 'datetime' })
  expiresAt!: Date;

  @Column({ type: 'datetime', nullable: true })
  revokedAt!: Date | null;

  @Column({ type: 'datetime', nullable: true })
  lastSeenAt!: Date | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  userAgent!: string | null;

  @Column({ type: 'varchar', length: 45, nullable: true })
  ipAddress!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
