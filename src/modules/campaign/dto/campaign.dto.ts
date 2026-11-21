import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ToStrictArray, ToStrictBoolean, ToStrictNumber, ToStrictString } from '../../../common/utils/strict-boolean';
import { BulkMessageContentDto } from '../../message/dto/bulk-message.dto';
import { CHAT_JID_MESSAGE, CHAT_JID_PATTERN } from '../../message/dto/send-message.dto';
import type { CampaignAudienceKind, CampaignMessageType, CampaignStatus } from '../entities/campaign.entity';
import type { CampaignRecipientStatus } from '../entities/campaign-recipient.entity';

export const CAMPAIGN_STATUSES: CampaignStatus[] = [
  'draft',
  'scheduled',
  'running',
  'completed',
  'cancelled',
  'failed',
];
export const CAMPAIGN_AUDIENCE_KINDS: CampaignAudienceKind[] = ['manual', 'segment', 'all', 'label'];
export const CAMPAIGN_MESSAGE_TYPES: CampaignMessageType[] = ['text', 'image', 'video', 'audio', 'document'];
export const CAMPAIGN_RECIPIENT_STATUSES: CampaignRecipientStatus[] = ['pending', 'sent', 'failed', 'skipped'];

/** An audience can never be larger than this; it keeps one campaign's recipient table bounded. */
export const CAMPAIGN_AUDIENCE_MAX = 5000;

export class CampaignContentDto {
  @ApiProperty({ enum: CAMPAIGN_MESSAGE_TYPES })
  @IsIn(CAMPAIGN_MESSAGE_TYPES)
  type!: CampaignMessageType;

  @ApiProperty({ type: BulkMessageContentDto, description: 'Same shape as one bulk message item’s content.' })
  @IsObject()
  @ValidateNested()
  @Type(() => BulkMessageContentDto)
  content!: BulkMessageContentDto;
}

export class CampaignAudienceDto {
  @ApiProperty({ enum: CAMPAIGN_AUDIENCE_KINDS })
  @IsIn(CAMPAIGN_AUDIENCE_KINDS)
  kind!: CampaignAudienceKind;

  @ApiPropertyOptional({
    type: [String],
    description: 'Required for `manual`; ignored otherwise.',
    maxItems: CAMPAIGN_AUDIENCE_MAX,
  })
  @IsOptional()
  @ToStrictArray()
  @IsArray()
  @ArrayMaxSize(CAMPAIGN_AUDIENCE_MAX)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @Matches(CHAT_JID_PATTERN, { each: true, message: CHAT_JID_MESSAGE })
  chatIds?: string[];

  @ApiPropertyOptional({ description: 'Required for `segment`; ignored otherwise.' })
  @IsOptional()
  @IsUUID()
  segmentId?: string;

  @ApiPropertyOptional({ description: 'Required for `label`; ignored otherwise.' })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxLength(100)
  labelId?: string;
}

export class CampaignOptionsDto {
  @ApiPropertyOptional({ default: 3000, minimum: 1000, maximum: 60000 })
  @IsOptional()
  @ToStrictNumber()
  @IsNumber()
  @Min(1000)
  @Max(60000)
  delayBetweenMessages?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @ToStrictBoolean()
  @IsBoolean()
  randomizeDelay?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @ToStrictBoolean()
  @IsBoolean()
  stopOnError?: boolean;
}

export class CreateCampaignDto {
  @ApiProperty({ maxLength: 120 })
  @ToStrictString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiProperty({ type: CampaignContentDto })
  @IsObject()
  @ValidateNested()
  @Type(() => CampaignContentDto)
  content!: CampaignContentDto;

  @ApiPropertyOptional({ type: CampaignAudienceDto, description: 'Defaults to `manual` with no chats.' })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => CampaignAudienceDto)
  audience?: CampaignAudienceDto;

  @ApiPropertyOptional({ type: CampaignOptionsDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => CampaignOptionsDto)
  options?: CampaignOptionsDto;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'When to start. Omit to keep the campaign a draft; `start` sends immediately.',
  })
  @IsOptional()
  @IsDateString()
  scheduledAt?: string | null;
}

export class UpdateCampaignDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ type: CampaignContentDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => CampaignContentDto)
  content?: CampaignContentDto;

  @ApiPropertyOptional({ type: CampaignAudienceDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => CampaignAudienceDto)
  audience?: CampaignAudienceDto;

  @ApiPropertyOptional({ type: CampaignOptionsDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => CampaignOptionsDto)
  options?: CampaignOptionsDto;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Schedule (or clear, with null) the start time of a draft.',
  })
  @IsOptional()
  @IsDateString()
  scheduledAt?: string | null;
}

export class CampaignPreviewDto {
  @ApiProperty({ type: CampaignAudienceDto })
  @IsObject()
  @ValidateNested()
  @Type(() => CampaignAudienceDto)
  audience!: CampaignAudienceDto;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: 100,
    default: 20,
    description: 'How many resolved chats to return as a sample.',
  })
  @IsOptional()
  @ToStrictNumber()
  @IsInt()
  @Min(1)
  @Max(100)
  sampleSize?: number;
}

export class CreateCampaignSegmentDto {
  @ApiProperty({ maxLength: 120 })
  @ToStrictString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiProperty({ type: [String], maxItems: CAMPAIGN_AUDIENCE_MAX })
  @ToStrictArray()
  @IsArray()
  @ArrayMaxSize(CAMPAIGN_AUDIENCE_MAX)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @Matches(CHAT_JID_PATTERN, { each: true, message: CHAT_JID_MESSAGE })
  chatIds!: string[];
}

export class UpdateCampaignSegmentDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ type: [String], maxItems: CAMPAIGN_AUDIENCE_MAX })
  @IsOptional()
  @ToStrictArray()
  @IsArray()
  @ArrayMaxSize(CAMPAIGN_AUDIENCE_MAX)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @Matches(CHAT_JID_PATTERN, { each: true, message: CHAT_JID_MESSAGE })
  chatIds?: string[];
}

export class CampaignRecipientDto {
  @ApiProperty()
  chatId!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  chatName!: string | null;

  @ApiProperty({ enum: CAMPAIGN_RECIPIENT_STATUSES })
  status!: CampaignRecipientStatus;

  @ApiPropertyOptional({ type: String, nullable: true })
  messageId!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  errorCode!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  errorMessage!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  sentAt!: string | null;
}

export class CampaignProgressDto {
  @ApiProperty()
  total!: number;

  @ApiProperty()
  sent!: number;

  @ApiProperty()
  failed!: number;

  @ApiProperty()
  skipped!: number;
}

export class CampaignDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  sessionId!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: CAMPAIGN_STATUSES })
  status!: CampaignStatus;

  @ApiProperty({ type: CampaignContentDto })
  content!: CampaignContentDto;

  @ApiProperty({ type: CampaignOptionsDto })
  options!: CampaignOptionsDto;

  @ApiProperty({ type: CampaignAudienceDto })
  audience!: CampaignAudienceDto;

  @ApiProperty({ type: CampaignProgressDto })
  progress!: CampaignProgressDto;

  @ApiPropertyOptional({ type: String, nullable: true })
  scheduledAt!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  startedAt!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  completedAt!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  createdByKeyId!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  createdByName!: string | null;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;
}

export class CampaignDetailDto extends CampaignDto {
  @ApiProperty({ type: [CampaignRecipientDto], description: 'The first page of recipients.' })
  recipients!: CampaignRecipientDto[];
}

export class CampaignSegmentDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ type: [String] })
  chatIds!: string[];

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;
}

export class CampaignSampleDto {
  @ApiProperty()
  chatId!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  chatName!: string | null;
}

export class CampaignPreviewResultDto {
  @ApiProperty({ description: 'How many distinct chats the audience resolves to.' })
  count!: number;

  @ApiProperty({ type: [CampaignSampleDto], description: 'A sample of the resolved chats, without statuses.' })
  sample!: CampaignSampleDto[];

  @ApiProperty({ description: 'True when the audience exceeded the cap and was truncated.' })
  truncated!: boolean;
}
