import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * One role grant for one API key, optionally bounded to a scope and a validity window.
 *
 * The actor of the whole gateway is `api_keys`, so an assignment attaches to `apiKeyId`; `userId`
 * is a supplementary link for a dashboard account and is never what authorization reads
 * (35.9.2 decision 4). `scopeId` is `''` for a global grant rather than NULL: SQLite treats every
 * NULL as distinct, so a nullable column would let the unique index admit the same global grant
 * twice (35.8.1 risk 4).
 *
 * Lives on the `main` connection (always SQLite), next to `api_keys` and `users`. `scopeId` names a
 * session, division or chat from the `data` connection without a foreign key — the same pattern
 * `division_agents.apiKeyId` already uses, because the two files are independent.
 */
@Entity('role_assignments')
@Index('UQ_role_assignments_scope', ['apiKeyId', 'role', 'scopeType', 'scopeId'], { unique: true })
@Index('IDX_role_assignments_apiKeyId', ['apiKeyId'])
@Index('IDX_role_assignments_userId', ['userId'])
export class RoleAssignment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // No FK: `main` has never carried foreign keys, and a cascade would erase an assignment silently.
  @Column({ type: 'varchar', length: 36 })
  apiKeyId!: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  userId!: string | null;

  // One of ROLE_NAMES. Kept as varchar rather than an enum: SQLite enums are CHECK constraints, and
  // adding a role later would need a table rebuild.
  @Column({ type: 'varchar', length: 32 })
  role!: string;

  @Column({ type: 'varchar', length: 16 })
  scopeType!: string;

  @Column({ type: 'varchar', length: 64, default: '' })
  scopeId!: string;

  // `local` for an assignment made here; `alim` and `externalId` are reserved for the Fase 4 sync so
  // the table does not need a rebuild then.
  @Column({ type: 'varchar', length: 16, default: 'local' })
  source!: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  externalId!: string | null;

  @Column({ type: 'datetime', nullable: true })
  validFrom!: Date | null;

  @Column({ type: 'datetime', nullable: true })
  validTo!: Date | null;

  @Column({ type: 'varchar', length: 36, nullable: true })
  grantedByKeyId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
