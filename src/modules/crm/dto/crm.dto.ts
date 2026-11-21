import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { ToStrictNumber, ToStrictString } from '../../../common/utils/strict-boolean';
import { CHAT_JID_MESSAGE, CHAT_JID_PATTERN } from '../../message/dto/send-message.dto';
import type { CrmActivityKind } from '../entities/crm-deal-activity.entity';
import type { CrmDealStatus } from '../entities/crm-deal.entity';
import type { CrmStageKind } from '../entities/crm-stage.entity';

export const CRM_STATUSES: CrmDealStatus[] = ['open', 'won', 'lost'];
export const CRM_STAGE_KINDS: CrmStageKind[] = ['open', 'won', 'lost'];

export class CreateCrmDealDto {
  @ApiProperty({ maxLength: 200 })
  @ToStrictString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({ description: 'Stage to place the deal in. Defaults to the first stage.' })
  @IsOptional()
  @IsUUID()
  stageId?: string;

  @ApiPropertyOptional({ description: 'Session the deal came from (provenance only).' })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxLength(100)
  sessionId?: string;

  @ApiPropertyOptional({ description: 'Chat the deal came from (provenance only).' })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @Matches(CHAT_JID_PATTERN, { message: CHAT_JID_MESSAGE })
  @MaxLength(100)
  chatId?: string;

  @ApiPropertyOptional({
    type: 'integer',
    nullable: true,
    description: 'Whole units of `currency`; omit when unknown.',
    minimum: 0,
  })
  @IsOptional()
  @ToStrictNumber()
  @IsInt()
  @Min(0)
  value?: number | null;

  @ApiPropertyOptional({ description: 'ISO 4217 code.', maxLength: 3, default: 'IDR' })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxLength(3)
  currency?: string;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'API key id of the responsible agent.' })
  @IsOptional()
  @IsUUID()
  assigneeKeyId?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'ISO date the deal is expected to close.' })
  @IsOptional()
  @IsDateString()
  expectedCloseAt?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 5000 })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxLength(5000)
  notes?: string | null;
}

export class UpdateCrmDealDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ description: 'Move the deal to another stage.' })
  @IsOptional()
  @IsUUID()
  stageId?: string;

  @ApiPropertyOptional({ type: 'integer', nullable: true, minimum: 0 })
  @IsOptional()
  @ToStrictNumber()
  @IsInt()
  @Min(0)
  value?: number | null;

  @ApiPropertyOptional({ maxLength: 3 })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxLength(3)
  currency?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsUUID()
  assigneeKeyId?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsDateString()
  expectedCloseAt?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 5000 })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxLength(5000)
  notes?: string | null;
}

export class AddCrmActivityDto {
  @ApiProperty({ description: 'Note to append to the deal history.', maxLength: 5000 })
  @ToStrictString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  body!: string;
}

export class UpdateCrmStageDto {
  @ApiPropertyOptional({ maxLength: 60 })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name?: string;

  @ApiPropertyOptional({ type: 'integer', minimum: 0 })
  @IsOptional()
  @ToStrictNumber()
  @IsInt()
  @Min(0)
  position?: number;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 20 })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxLength(20)
  color?: string | null;
}

export class CrmStageDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: CRM_STAGE_KINDS, description: 'Whether deals here are open, won or lost.' })
  kind!: CrmStageKind;

  @ApiProperty()
  position!: number;

  @ApiPropertyOptional({ type: String, nullable: true })
  color!: string | null;
}

export class CrmDealDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  stageId!: string;

  @ApiProperty()
  title!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  sessionId!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  chatId!: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  value!: number | null;

  @ApiProperty()
  currency!: string;

  @ApiProperty({ enum: CRM_STATUSES })
  status!: CrmDealStatus;

  @ApiPropertyOptional({ type: String, nullable: true })
  assigneeKeyId!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  assigneeName!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  expectedCloseAt!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  closedAt!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  notes!: string | null;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;
}

export class CrmActivityDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: ['created', 'stage_change', 'assignment', 'note', 'update'] })
  kind!: CrmActivityKind;

  @ApiPropertyOptional({ type: String, nullable: true })
  body!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  fromStageId!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  toStageId!: string | null;

  @ApiProperty()
  authorKeyId!: string;

  @ApiProperty()
  authorName!: string;

  @ApiProperty()
  createdAt!: string;
}

export class CrmDealDetailDto extends CrmDealDto {
  @ApiProperty({ type: [CrmActivityDto] })
  activities!: CrmActivityDto[];
}

export class CrmBoardColumnDto {
  @ApiProperty({ type: CrmStageDto })
  stage!: CrmStageDto;

  @ApiProperty({ type: [CrmDealDto] })
  deals!: CrmDealDto[];
}

export class CrmBoardDto {
  @ApiProperty({ type: [CrmBoardColumnDto] })
  columns!: CrmBoardColumnDto[];

  @ApiProperty()
  open!: number;

  @ApiProperty()
  won!: number;

  @ApiProperty()
  lost!: number;

  @ApiProperty({ description: 'Sum of open deal values, in mixed currencies (informational only).' })
  openValue!: number;
}
