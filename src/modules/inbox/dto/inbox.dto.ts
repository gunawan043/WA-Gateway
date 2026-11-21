import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { ToStrictString } from '../../../common/utils/strict-boolean';
import type { ChatKind } from '../../../engine/identity/wa-id';
import type { MessageType } from '../../../engine/interfaces/whatsapp-engine.interface';
import type { InboxConversationStatus } from '../entities/inbox-conversation.entity';

export const INBOX_STATUSES: InboxConversationStatus[] = ['open', 'pending', 'resolved'];
const CHAT_KINDS: ChatKind[] = ['individual', 'group', 'channel', 'status', 'broadcast', 'unknown'];

export class UpdateInboxConversationDto {
  @ApiPropertyOptional({ enum: INBOX_STATUSES, description: 'New conversation status.' })
  @IsOptional()
  @ToStrictString()
  @IsIn(INBOX_STATUSES)
  status?: InboxConversationStatus;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'API key id of the agent to assign. `null` releases the conversation.',
  })
  @IsOptional()
  @IsUUID()
  assigneeKeyId?: string | null;
}

export class AddInboxNoteDto {
  @ApiProperty({ description: 'Note body (plain text, internal only).', maxLength: 5000 })
  @ToStrictString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  body!: string;
}

/** One chat as the inbox shows it: the engine's summary plus the inbox state. */
export class InboxConversationDto {
  @ApiProperty({ example: '628111@c.us' })
  chatId!: string;

  @ApiProperty({ example: 'Alice' })
  name!: string;

  @ApiProperty({ description: 'Retained for back-compat; true for @g.us chats.' })
  isGroup!: boolean;

  @ApiProperty({ enum: CHAT_KINDS })
  kind!: ChatKind;

  @ApiProperty()
  unreadCount!: number;

  @ApiProperty({ description: 'Unix seconds of the last activity.' })
  timestamp!: number;

  @ApiPropertyOptional()
  lastMessage?: string;

  @ApiPropertyOptional()
  lastMessageType?: MessageType;

  @ApiProperty()
  archived!: boolean;

  @ApiProperty()
  pinned!: boolean;

  @ApiProperty({ enum: INBOX_STATUSES })
  status!: InboxConversationStatus;

  @ApiPropertyOptional({ type: String, nullable: true })
  assigneeKeyId!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  assigneeName!: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'ISO instant the conversation was resolved.' })
  resolvedAt!: string | null;
}

export class InboxNoteDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  authorKeyId!: string;

  @ApiProperty()
  authorName!: string;

  @ApiProperty()
  body!: string;

  @ApiProperty()
  createdAt!: string;
}

export class InboxConversationDetailDto extends InboxConversationDto {
  @ApiProperty({ type: [InboxNoteDto] })
  notes!: InboxNoteDto[];
}

export class InboxSummaryDto {
  @ApiProperty()
  total!: number;

  @ApiProperty()
  open!: number;

  @ApiProperty()
  pending!: number;

  @ApiProperty()
  resolved!: number;

  @ApiProperty({ description: 'Conversations with no assignee.' })
  unassigned!: number;

  @ApiProperty({ description: 'Conversations assigned to the calling key.' })
  mine!: number;
}
