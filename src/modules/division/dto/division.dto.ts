import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { ToStrictArray, ToStrictBoolean, ToStrictNumber, ToStrictString } from '../../../common/utils/strict-boolean';
import { MaxCodePoints } from '../../../common/validation/max-code-points';
import { NoNulCharacter } from '../../../common/validation/no-nul-character';

/** A menu longer than this stops being readable on a phone; the router refuses to send more. */
export const MAX_DIVISIONS_PER_SESSION = 20;
export const MAX_KEYWORDS_PER_DIVISION = 20;
export const MAX_DIVISION_AGENTS = 50;
export const KEYWORD_MAX_LENGTH = 40;
export const DIVISION_TEXT_MAX_LENGTH = 2_000;
/** One month, so a long holiday does not silently disable the idle re-prompt. */
export const IDLE_HOURS_MAX = 720;

const KEYWORDS_DESCRIPTION =
  'Words or short phrases a customer may type instead of the menu number, matched as whole words ' +
  'against the message (case and punctuation are ignored). Example: ["smp", "smp putra"]. A keyword ' +
  'that is only digits is refused: it would collide with the menu numbering.';

export class CreateDivisionDto {
  @ApiProperty({ description: 'Division name, also the default menu label', example: 'CS SMP Putra', maxLength: 100 })
  @ToStrictString()
  @IsString()
  @IsNotEmpty()
  @MaxCodePoints(100)
  @NoNulCharacter()
  name!: string;

  @ApiPropertyOptional({ description: KEYWORDS_DESCRIPTION, type: [String] })
  @IsOptional()
  @ToStrictArray()
  @IsArray()
  @ArrayMaxSize(MAX_KEYWORDS_PER_DIVISION)
  @IsString({ each: true })
  @ArrayUnique()
  @MaxLength(KEYWORD_MAX_LENGTH, { each: true })
  keywords?: string[];

  @ApiPropertyOptional({ description: 'Menu line shown instead of the name', maxLength: 100, nullable: true })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxCodePoints(100)
  @NoNulCharacter()
  menuLabel?: string | null;

  @ApiPropertyOptional({
    description: 'Message sent once the customer selects this division. Omit for the built-in default.',
    maxLength: DIVISION_TEXT_MAX_LENGTH,
    nullable: true,
  })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxLength(DIVISION_TEXT_MAX_LENGTH)
  @NoNulCharacter()
  welcomeText?: string | null;

  @ApiPropertyOptional({
    description: 'Menu position; ties fall back to the name',
    default: 0,
    minimum: 0,
    maximum: 1000,
    type: 'integer',
  })
  @IsOptional()
  @ToStrictNumber()
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder?: number;

  @ApiPropertyOptional({ description: 'Whether the division appears in the menu and matches keywords', default: true })
  @IsOptional()
  @ToStrictBoolean()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    description: 'Active API keys that answer for this division. Replaces the whole set on update.',
    type: [String],
  })
  @IsOptional()
  @ToStrictArray()
  @IsArray()
  @ArrayMaxSize(MAX_DIVISION_AGENTS)
  @IsString({ each: true })
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  agentKeyIds?: string[];
}

export class UpdateDivisionDto {
  @ApiPropertyOptional({ description: 'Division name', maxLength: 100 })
  // Not @IsOptional on the NOT NULL columns: that also skips null, which reaches save() as a 500.
  @ValidateIf((o: UpdateDivisionDto) => o.name !== undefined)
  @ToStrictString()
  @IsString()
  @IsNotEmpty()
  @MaxCodePoints(100)
  @NoNulCharacter()
  name?: string;

  @ApiPropertyOptional({ description: KEYWORDS_DESCRIPTION, type: [String] })
  @ValidateIf((o: UpdateDivisionDto) => o.keywords !== undefined)
  @ToStrictArray()
  @IsArray()
  @ArrayMaxSize(MAX_KEYWORDS_PER_DIVISION)
  @IsString({ each: true })
  @ArrayUnique()
  @MaxLength(KEYWORD_MAX_LENGTH, { each: true })
  keywords?: string[];

  @ApiPropertyOptional({ description: 'Menu line shown instead of the name', maxLength: 100, nullable: true })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxCodePoints(100)
  @NoNulCharacter()
  menuLabel?: string | null;

  @ApiPropertyOptional({
    description: 'Message sent once the customer selects this division. Null restores the default.',
    maxLength: DIVISION_TEXT_MAX_LENGTH,
    nullable: true,
  })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxLength(DIVISION_TEXT_MAX_LENGTH)
  @NoNulCharacter()
  welcomeText?: string | null;

  @ApiPropertyOptional({
    description: 'Menu position; ties fall back to the name',
    minimum: 0,
    maximum: 1000,
    type: 'integer',
  })
  @ValidateIf((o: UpdateDivisionDto) => o.sortOrder !== undefined)
  @ToStrictNumber()
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder?: number;

  @ApiPropertyOptional({ description: 'Whether the division appears in the menu and matches keywords' })
  @ValidateIf((o: UpdateDivisionDto) => o.isActive !== undefined)
  @ToStrictBoolean()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ description: 'Active API keys that answer for this division', type: [String] })
  @ValidateIf((o: UpdateDivisionDto) => o.agentKeyIds !== undefined)
  @ToStrictArray()
  @IsArray()
  @ArrayMaxSize(MAX_DIVISION_AGENTS)
  @IsString({ each: true })
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  agentKeyIds?: string[];
}

export class UpdateDivisionSettingsDto {
  @ApiPropertyOptional({ description: 'Turn routing on or off for this session', default: true })
  @IsOptional()
  @ToStrictBoolean()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    description: 'Line above the numbered list. Null uses the built-in default.',
    maxLength: DIVISION_TEXT_MAX_LENGTH,
    nullable: true,
  })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxLength(DIVISION_TEXT_MAX_LENGTH)
  @NoNulCharacter()
  menuHeader?: string | null;

  @ApiPropertyOptional({
    description: 'Sent when a reply matches no division and no menu number. Null uses the built-in default.',
    maxLength: DIVISION_TEXT_MAX_LENGTH,
    nullable: true,
  })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxLength(DIVISION_TEXT_MAX_LENGTH)
  @NoNulCharacter()
  invalidReply?: string | null;

  @ApiPropertyOptional({
    description: 'Hours of customer silence after which a routed chat is shown the menu again. 0 disables it.',
    default: 24,
    minimum: 0,
    maximum: IDLE_HOURS_MAX,
    type: 'integer',
  })
  @IsOptional()
  @ToStrictNumber()
  @IsInt()
  @Min(0)
  @Max(IDLE_HOURS_MAX)
  idleHours?: number;
}

export class DivisionAgentDto {
  @ApiProperty()
  apiKeyId!: string;

  @ApiProperty()
  name!: string;
}

export class DivisionDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  sessionId!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ type: [String] })
  keywords!: string[];

  @ApiPropertyOptional({ nullable: true })
  menuLabel!: string | null;

  @ApiPropertyOptional({ nullable: true })
  welcomeText!: string | null;

  @ApiProperty({ type: 'integer' })
  sortOrder!: number;

  @ApiProperty()
  isActive!: boolean;

  @ApiProperty({ type: [DivisionAgentDto] })
  agents!: DivisionAgentDto[];

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

export class DivisionSettingsDto {
  @ApiProperty()
  sessionId!: string;

  @ApiProperty()
  enabled!: boolean;

  @ApiPropertyOptional({ nullable: true })
  menuHeader!: string | null;

  @ApiPropertyOptional({ nullable: true })
  invalidReply!: string | null;

  @ApiProperty({ type: 'integer' })
  idleHours!: number;
}
