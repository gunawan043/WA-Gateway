import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';
import { ApiKeyRole } from './api-key.entity';

/**
 * A human account for the dashboard.
 *
 * Every user owns exactly one `api_keys` row (`apiKeyId`). A password login resolves to that key, so
 * the whole gateway keeps working off `request.apiKey`: the role hierarchy, the chat fence, audit
 * attribution, inbox assignment and the WebSocket per-key socket cap all read a key, not a user.
 * The key is never handed out — its plaintext is generated and dropped when the user is created — so
 * the only way to use it is through this account or through a separately minted API key.
 *
 * Lives on the `main` connection (always SQLite), next to `api_keys` and `audit_logs`.
 */
@Entity('users')
@Index('UQ_users_email', ['email'], { unique: true })
@Index('UQ_users_apiKeyId', ['apiKeyId'], { unique: true })
// The external identity used by the ALIM Core SSO handoff. Nullable because most accounts are local
// only; unique because one Core person must never resolve to two Connect accounts. Never used as
// an authorization source: the account's own role/assignments decide what it may do.
@Index('UQ_users_coreUserId', ['coreUserId'], { unique: true })
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // Stored lowercased and trimmed by UsersService, so the unique index is a real identity check.
  @Column({ type: 'varchar', length: 190 })
  email!: string;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  /**
   * `core_user_id` from ALIM Core. The ONLY field the SSO handoff maps on; name and email are
   * descriptive and are never used to find an account (Core can change them, and two people can
   * share a name). Empty means "not mapped", and an unmapped Core user is refused — never
   * auto-provisioned.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  coreUserId!: string | null;

  // scrypt, encoded `scrypt$N$r$p$saltB64$hashB64` (see password-hash.ts). Never leaves the server.
  @Column({ type: 'varchar', length: 255 })
  passwordHash!: string;

  @Column({ type: 'varchar', length: 20, default: ApiKeyRole.OPERATOR })
  role!: ApiKeyRole;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  // The linked api_keys row. Mirrors name/role/isActive; UsersService keeps the two in step.
  @Column({ type: 'varchar', length: 36 })
  apiKeyId!: string;

  @Column({ type: 'datetime', nullable: true })
  lastLoginAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
