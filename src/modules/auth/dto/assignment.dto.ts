import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsOptional, IsString, ValidateNested } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ToStrictString } from '../../../common/utils/strict-boolean';
import { MaxCodePoints } from '../../../common/validation/max-code-points';
import { RoleAssignment } from '../entities/role-assignment.entity';
import { ROLE_NAMES, SCOPE_TYPES } from '../permissions';

/** A key never needs more grants than this to express a real job; the cap bounds one request. */
export const MAX_ASSIGNMENTS = 20;

/**
 * One grant as the API accepts it.
 *
 * `scopeType` is validated in the service rather than by `@IsIn` so `unit` can be refused with the
 * message the design requires ("reserved for Fase 4") instead of a generic enum error (35.5.6).
 */
export class AssignmentInputDto {
  @ApiProperty({
    description: 'Role granted by this assignment',
    enum: ROLE_NAMES,
    example: 'agent',
  })
  @ToStrictString()
  @IsString()
  @IsIn(ROLE_NAMES)
  role!: string;

  @ApiProperty({
    description:
      'Scope of the grant: `global`, `session`, `team` or `object`. `unit` is reserved for Fase 4 and is refused.',
    enum: SCOPE_TYPES,
    example: 'team',
  })
  @ToStrictString()
  @IsString()
  @MaxCodePoints(16)
  scopeType!: string;

  @ApiPropertyOptional({
    description: 'Session id, division id or chat id the grant is bounded to. Omit (or send empty) for `global`.',
    example: '0a941dac-a965-45e7-b318-74ae8be134f0',
  })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxCodePoints(64)
  scopeId?: string;

  @ApiPropertyOptional({
    description: 'Start of the validity window (ISO 8601). Omit for "effective immediately".',
    example: '2026-11-21T00:00:00Z',
  })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxCodePoints(40)
  validFrom?: string;

  @ApiPropertyOptional({
    description: 'End of the validity window (ISO 8601). Omit for "no expiry".',
    example: '2027-12-31T23:59:59Z',
  })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxCodePoints(40)
  validTo?: string;
}

export class CreateAssignmentDto extends AssignmentInputDto {
  @ApiProperty({ description: 'Id of the API key (or the account’s linked key) receiving the grant' })
  @ToStrictString()
  @IsString()
  @MaxCodePoints(36)
  apiKeyId!: string;
}

export class UpdateAssignmentDto {
  @ApiPropertyOptional({ enum: ROLE_NAMES })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @IsIn(ROLE_NAMES)
  role?: string;

  @ApiPropertyOptional({ enum: SCOPE_TYPES })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxCodePoints(16)
  scopeType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxCodePoints(64)
  scopeId?: string;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'Start of the validity window (ISO 8601)' })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxCodePoints(40)
  validFrom?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'End of the validity window (ISO 8601)' })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxCodePoints(40)
  validTo?: string | null;
}

/** A non-empty list of grants, validated as a unit — the shape `POST /auth/users` requires. */
export class AssignmentListDto {
  @ApiProperty({
    description: 'Grants the new account receives. At least one; a new account never gets global access implicitly.',
    type: [AssignmentInputDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ASSIGNMENTS)
  @ValidateNested({ each: true })
  @Type(() => AssignmentInputDto)
  assignments!: AssignmentInputDto[];
}

export class AssignmentResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() apiKeyId!: string;
  @ApiPropertyOptional({ nullable: true }) userId?: string | null;
  @ApiProperty({ enum: ROLE_NAMES }) role!: string;
  @ApiProperty({ enum: SCOPE_TYPES }) scopeType!: string;
  @ApiProperty() scopeId!: string;
  @ApiProperty({ description: '`local` for a grant made here; `alim` is reserved for the Fase 4 sync' })
  source!: string;
  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' }) validFrom?: string | null;
  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' }) validTo?: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}

export function toAssignmentResponse(row: RoleAssignment): AssignmentResponseDto {
  return {
    id: row.id,
    apiKeyId: row.apiKeyId,
    userId: row.userId,
    role: row.role,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    source: row.source,
    validFrom: row.validFrom ? new Date(row.validFrom).toISOString() : null,
    validTo: row.validTo ? new Date(row.validTo).toISOString() : null,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}
