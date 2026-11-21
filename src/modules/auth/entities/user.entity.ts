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
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // Stored lowercased and trimmed by UsersService, so the unique index is a real identity check.
  @Column({ type: 'varchar', length: 190 })
  email!: string;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

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
