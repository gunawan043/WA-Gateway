import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { paginate } from '../../common/utils/paginate';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { ChatScopeService } from '../auth/chat-scope.service';
import { ChatScoped, CurrentApiKey, RequireRole } from '../auth/decorators/auth.decorators';
import {
  AddInboxNoteDto,
  INBOX_STATUSES,
  InboxConversationDetailDto,
  InboxConversationDto,
  InboxNoteDto,
  InboxSummaryDto,
  UpdateInboxConversationDto,
} from './dto/inbox.dto';
import type { InboxConversationStatus } from './entities/inbox-conversation.entity';
import { InboxService } from './inbox.service';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

@ApiTags('inbox')
@Controller('sessions/:sessionId/inbox')
export class InboxController {
  constructor(
    private readonly inbox: InboxService,
    private readonly chatScope: ChatScopeService,
  ) {}

  @Get('conversations')
  @RequireRole(ApiKeyRole.VIEWER)
  @ChatScoped('filtered')
  @ApiOperation({ summary: 'List the session’s conversations with inbox state' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiQuery({ name: 'status', required: false, enum: INBOX_STATUSES })
  @ApiQuery({
    name: 'assignee',
    required: false,
    description: '`me`, `unassigned`, or an API key id. Omit for every conversation.',
  })
  @ApiQuery({
    name: 'division',
    required: false,
    description: '`unassigned`, or a division id. Omit for every conversation.',
  })
  @ApiQuery({ name: 'q', required: false, description: 'Case-insensitive search on name, chat id or last message.' })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: 'integer',
    description: `1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}`,
  })
  @ApiQuery({ name: 'offset', required: false, type: 'integer' })
  @ApiResponse({ status: 200, type: [InboxConversationDto] })
  async list(
    @Param('sessionId') sessionId: string,
    @CurrentApiKey() apiKey: ApiKey | undefined,
    @Query('status') status?: string,
    @Query('assignee') assignee?: string,
    @Query('division') division?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<InboxConversationDto[]> {
    if (status && !INBOX_STATUSES.includes(status as InboxConversationStatus)) {
      throw new BadRequestException(`status must be one of ${INBOX_STATUSES.join(', ')}`);
    }

    const all = await this.inbox.listAll(
      sessionId,
      { status: status as InboxConversationStatus | undefined, assignee, division, q },
      apiKey?.id,
    );
    // Filter BEFORE paging: filtering the page would show a short window while an allowed chat sat
    // just past it (same reasoning as GET /sessions/:id/chats).
    const visible = await this.chatScope.filter(apiKey, all, conversation => conversation.chatId);
    return paginate(visible, this.parseLimit(limit), this.parseOffset(offset));
  }

  @Get('summary')
  @RequireRole(ApiKeyRole.VIEWER)
  @ChatScoped('filtered')
  @ApiOperation({ summary: 'Conversation counts for the inbox header' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({ status: 200, type: InboxSummaryDto })
  async summary(@Param('sessionId') sessionId: string, @CurrentApiKey() apiKey?: ApiKey): Promise<InboxSummaryDto> {
    const all = await this.inbox.listAll(sessionId, {}, apiKey?.id);
    const visible = await this.chatScope.filter(apiKey, all, conversation => conversation.chatId);
    return this.inbox.summarize(visible, apiKey?.id);
  }

  @Get('conversations/:chatId')
  @RequireRole(ApiKeyRole.VIEWER)
  @ChatScoped('fenced')
  @ApiOperation({ summary: 'One conversation with its internal notes' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'chatId', description: 'Chat id (JID or bare phone)' })
  @ApiResponse({ status: 200, type: InboxConversationDetailDto })
  @ApiResponse({ status: 404, description: 'No such chat in this session.' })
  async get(
    @Param('sessionId') sessionId: string,
    @Param('chatId') chatId: string,
  ): Promise<InboxConversationDetailDto> {
    return this.inbox.get(sessionId, chatId);
  }

  @Patch('conversations/:chatId')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ChatScoped('fenced')
  @ApiOperation({ summary: 'Assign a conversation or change its status' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'chatId', description: 'Chat id (JID or bare phone)' })
  @ApiResponse({ status: 200, type: InboxConversationDetailDto })
  @ApiResponse({ status: 400, description: 'Empty update, or assigneeKeyId is not an active API key.' })
  @ApiResponse({ status: 404, description: 'No such chat in this session.' })
  async update(
    @Param('sessionId') sessionId: string,
    @Param('chatId') chatId: string,
    @Body() dto: UpdateInboxConversationDto,
    @CurrentApiKey() apiKey: ApiKey | undefined,
  ): Promise<InboxConversationDetailDto> {
    if (dto.status === undefined && dto.assigneeKeyId === undefined && dto.divisionId === undefined) {
      throw new BadRequestException('Provide status, assigneeKeyId and/or divisionId');
    }
    return this.inbox.update(sessionId, chatId, dto, apiKey!);
  }

  @Post('conversations/:chatId/notes')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ChatScoped('fenced')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add an internal note' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'chatId', description: 'Chat id (JID or bare phone)' })
  @ApiResponse({ status: 201, type: InboxNoteDto })
  @ApiResponse({ status: 404, description: 'No such chat in this session.' })
  async addNote(
    @Param('sessionId') sessionId: string,
    @Param('chatId') chatId: string,
    @Body() dto: AddInboxNoteDto,
    @CurrentApiKey() apiKey: ApiKey | undefined,
  ): Promise<InboxNoteDto> {
    return this.inbox.addNote(sessionId, chatId, dto.body, apiKey!);
  }

  @Delete('conversations/:chatId/notes/:noteId')
  @RequireRole(ApiKeyRole.ADMIN)
  @ChatScoped('fenced')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an internal note' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'chatId', description: 'Chat id (JID or bare phone)' })
  @ApiParam({ name: 'noteId', description: 'Note ID' })
  @ApiResponse({ status: 204, description: 'Note deleted.' })
  @ApiResponse({ status: 404, description: 'No such note on this conversation.' })
  async deleteNote(
    @Param('sessionId') sessionId: string,
    @Param('chatId') chatId: string,
    @Param('noteId') noteId: string,
    @CurrentApiKey() apiKey: ApiKey | undefined,
  ): Promise<void> {
    await this.inbox.deleteNote(sessionId, chatId, noteId, apiKey!);
  }

  private parseLimit(limit?: string): number {
    const parsed = limit ? Number.parseInt(limit, 10) : DEFAULT_LIMIT;
    if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_LIMIT;
    return Math.min(parsed, MAX_LIMIT);
  }

  private parseOffset(offset?: string): number {
    const parsed = offset ? Number.parseInt(offset, 10) : 0;
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
  }
}
