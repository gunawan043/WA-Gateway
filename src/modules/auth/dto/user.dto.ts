import { IsBoolean, IsEmail, IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ToStrictBoolean, ToStrictString } from '../../../common/utils/strict-boolean';
import { MaxCodePoints } from '../../../common/validation/max-code-points';
import { ApiKeyRole } from '../entities/api-key.entity';
import { User } from '../entities/user.entity';
import { AssignmentListDto, AssignmentResponseDto } from './assignment.dto';

/** Shortest password the gateway will store. Long enough to matter, short enough for a phone. */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 200;

export class LoginDto {
  @ApiProperty({ description: 'Email address of the dashboard account', example: 'admin@example.com' })
  @ToStrictString()
  @IsEmail()
  @MaxCodePoints(190)
  email!: string;

  @ApiProperty({ description: 'Account password', example: 'a-long-passphrase' })
  @ToStrictString()
  @IsString()
  @MinLength(1)
  @MaxCodePoints(MAX_PASSWORD_LENGTH)
  password!: string;
}

/**
 * A new dashboard account. `assignments` is REQUIRED (docs/35 §35.4.1): a new credential never gets
 * global access implicitly, so the caller must state the role and the scope it is granted. The
 * legacy `role` stays accepted and only decides `api_keys.role`; when omitted it is derived from the
 * grants so the last-admin rule and the old UI keep a meaningful value.
 */
export class CreateUserDto extends AssignmentListDto {
  @ApiProperty({ description: 'Email address, stored lowercased; must be unique', example: 'agent@example.com' })
  @ToStrictString()
  @IsEmail()
  @MaxCodePoints(190)
  email!: string;

  @ApiProperty({ description: 'Display name, also used for the linked API key', example: 'Siti' })
  @ToStrictString()
  @IsString()
  @MinLength(2)
  @MaxCodePoints(100)
  name!: string;

  @ApiPropertyOptional({
    description:
      'Legacy role of the account and its linked key. Optional: derived from `assignments` when omitted. ' +
      'It no longer decides what the account may do once it has assignments.',
    enum: ApiKeyRole,
  })
  @IsOptional()
  @IsEnum(ApiKeyRole)
  role?: ApiKeyRole;

  @ApiProperty({
    description: `Initial password, at least ${MIN_PASSWORD_LENGTH} characters`,
    example: 'a-long-passphrase',
    minLength: MIN_PASSWORD_LENGTH,
  })
  @ToStrictString()
  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH)
  @MaxCodePoints(MAX_PASSWORD_LENGTH)
  password!: string;

  @ApiPropertyOptional({
    description:
      'ALIM Core `core_user_id` this account signs in as through the WhatsApp Connect SSO handoff. ' +
      'Optional; an unmapped account can still sign in with its password.',
    example: '9f1c2a44-3c55-4c1e-9c1f-2b7d8e6a5f03',
  })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxCodePoints(64)
  coreUserId?: string | null;
}

export class UpdateUserDto {
  @ApiPropertyOptional({ description: 'Display name', example: 'Siti Rahma' })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MinLength(2)
  @MaxCodePoints(100)
  name?: string;

  @ApiPropertyOptional({ description: 'Role, mirrored onto the linked API key', enum: ApiKeyRole })
  @IsOptional()
  @IsEnum(ApiKeyRole)
  role?: ApiKeyRole;

  @ApiPropertyOptional({
    description: 'Set false to disable the account immediately; every live session is revoked',
  })
  @IsOptional()
  @ToStrictBoolean()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    description:
      'ALIM Core `core_user_id` mapped to this account for the SSO handoff. Send null (or an empty ' +
      'string) to remove the mapping; the account then cannot be reached through SSO.',
    nullable: true,
    type: String,
  })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxCodePoints(64)
  coreUserId?: string | null;
}

export class ResetPasswordDto {
  @ApiProperty({
    description: `New password, at least ${MIN_PASSWORD_LENGTH} characters. Every live session of the account is revoked.`,
    example: 'another-long-passphrase',
    minLength: MIN_PASSWORD_LENGTH,
  })
  @ToStrictString()
  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH)
  @MaxCodePoints(MAX_PASSWORD_LENGTH)
  password!: string;
}

export class ChangePasswordDto {
  @ApiProperty({ description: 'The password in use now', example: 'a-long-passphrase' })
  @ToStrictString()
  @IsString()
  @MinLength(1)
  @MaxCodePoints(MAX_PASSWORD_LENGTH)
  currentPassword!: string;

  @ApiProperty({
    description: `New password, at least ${MIN_PASSWORD_LENGTH} characters. Other sessions of the account are revoked.`,
    example: 'another-long-passphrase',
    minLength: MIN_PASSWORD_LENGTH,
  })
  @ToStrictString()
  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH)
  @MaxCodePoints(MAX_PASSWORD_LENGTH)
  newPassword!: string;
}

export class UserResponseDto {
  @ApiProperty({ description: 'User id' })
  id!: string;

  @ApiProperty({ description: 'Email address (lowercased)' })
  email!: string;

  @ApiProperty({ description: 'Display name' })
  name!: string;

  @ApiProperty({ description: 'Role', enum: ApiKeyRole })
  role!: ApiKeyRole;

  @ApiProperty({ description: 'Whether the account may sign in' })
  isActive!: boolean;

  @ApiProperty({ description: 'The linked API key id (its plaintext is never issued)' })
  apiKeyId!: string;

  @ApiPropertyOptional({
    description: 'ALIM Core `core_user_id` mapped to this account, or null when unmapped',
    nullable: true,
    type: String,
  })
  coreUserId?: string | null;

  @ApiProperty({ description: 'Last successful sign-in', nullable: true, type: String, format: 'date-time' })
  lastLoginAt?: string | null;

  @ApiProperty({ description: 'Creation time', type: String, format: 'date-time' })
  createdAt!: string;

  @ApiPropertyOptional({
    description: 'Roles the account’s linked key holds (Fase 1, additive).',
    type: [String],
  })
  roles?: string[];

  @ApiPropertyOptional({
    description: 'Permissions the account’s linked key currently holds (Fase 1, additive).',
    type: [String],
  })
  permissions?: string[];

  @ApiPropertyOptional({
    description: 'Role assignments of the account’s linked key (Fase 1, additive).',
    type: [AssignmentResponseDto],
  })
  assignments?: AssignmentResponseDto[];
}

/**
 * The only shape a user leaves the server in. The password hash, the session token hash and the
 * linked key's hash never reach a response — there is no `...user` spread anywhere for that reason.
 */
export function toUserResponse(user: User): UserResponseDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    isActive: user.isActive,
    apiKeyId: user.apiKeyId,
    coreUserId: user.coreUserId ?? null,
    lastLoginAt: user.lastLoginAt ? new Date(user.lastLoginAt).toISOString() : null,
    createdAt: new Date(user.createdAt).toISOString(),
  };
}
