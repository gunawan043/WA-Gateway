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
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { CurrentApiKey, RequireRole } from '../auth/decorators/auth.decorators';
import { CampaignRunnerService } from './campaign-runner.service';
import { CampaignService } from './campaign.service';
import {
  CAMPAIGN_RECIPIENT_STATUSES,
  CAMPAIGN_STATUSES,
  CampaignDetailDto,
  CampaignDto,
  CampaignPreviewDto,
  CampaignPreviewResultDto,
  CampaignRecipientDto,
  CampaignSegmentDto,
  CreateCampaignDto,
  CreateCampaignSegmentDto,
  UpdateCampaignDto,
  UpdateCampaignSegmentDto,
} from './dto/campaign.dto';
import type { CampaignStatus } from './entities/campaign.entity';
import type { CampaignRecipientStatus } from './entities/campaign-recipient.entity';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Broadcast campaigns for one session.
 *
 * Every route sits under `:sessionId`, so the guard's session fence applies. None is `@ChatScoped`:
 * a campaign reaches many chats at once and its audience is not one chat the guard could inspect, so
 * a chat-restricted key is refused by default-deny — the intended outcome for a blast.
 *
 * Static routes (`segments`, `preview`) are declared before `:id` because Express takes the first
 * match: otherwise a campaign id of "preview" would be read as a preview request.
 */
@ApiTags('campaigns')
@Controller('sessions/:sessionId/campaigns')
export class CampaignController {
  constructor(
    private readonly campaigns: CampaignService,
    private readonly runner: CampaignRunnerService,
  ) {}

  @Get()
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'List campaigns for a session, newest first' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiQuery({ name: 'status', required: false, enum: CAMPAIGN_STATUSES })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: 'integer',
    description: `1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}`,
  })
  @ApiQuery({ name: 'offset', required: false, type: 'integer', description: 'Default 0' })
  @ApiResponse({ status: 200, type: [CampaignDto] })
  @ApiResponse({ status: 404, description: 'No such session.' })
  async list(
    @Param('sessionId') sessionId: string,
    @Query('status') status: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
  ): Promise<CampaignDto[]> {
    return this.campaigns.list(sessionId, this.parseStatus(status), this.parseLimit(limit), this.parseOffset(offset));
  }

  @Post()
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a campaign as a draft (or scheduled, with scheduledAt)' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({ status: 201, type: CampaignDto })
  @ApiResponse({ status: 400, description: 'The content or audience is incomplete.' })
  @ApiResponse({ status: 404, description: 'No such session.' })
  async create(
    @Param('sessionId') sessionId: string,
    @Body() dto: CreateCampaignDto,
    @CurrentApiKey() apiKey: ApiKey | undefined,
  ): Promise<CampaignDto> {
    return this.campaigns.create(sessionId, dto, apiKey!);
  }

  @Get('segments')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'Saved recipient lists for a session' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({ status: 200, type: [CampaignSegmentDto] })
  async listSegments(@Param('sessionId') sessionId: string): Promise<CampaignSegmentDto[]> {
    return this.campaigns.listSegments(sessionId);
  }

  @Post('segments')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Save a reusable recipient list' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({ status: 201, type: CampaignSegmentDto })
  @ApiResponse({ status: 400, description: 'The segment has no chats.' })
  async createSegment(
    @Param('sessionId') sessionId: string,
    @Body() dto: CreateCampaignSegmentDto,
  ): Promise<CampaignSegmentDto> {
    return this.campaigns.createSegment(sessionId, dto);
  }

  @Patch('segments/:id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Rename a segment or replace its chats' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Segment ID' })
  @ApiResponse({ status: 200, type: CampaignSegmentDto })
  @ApiResponse({ status: 404, description: 'No such segment.' })
  async updateSegment(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
    @Body() dto: UpdateCampaignSegmentDto,
  ): Promise<CampaignSegmentDto> {
    if (dto.name === undefined && dto.chatIds === undefined) {
      throw new BadRequestException('Provide name and/or chatIds');
    }
    return this.campaigns.updateSegment(sessionId, id, dto);
  }

  @Delete('segments/:id')
  @RequireRole(ApiKeyRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a saved segment' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Segment ID' })
  @ApiResponse({ status: 204, description: 'Segment deleted.' })
  @ApiResponse({ status: 404, description: 'No such segment.' })
  async removeSegment(@Param('sessionId') sessionId: string, @Param('id') id: string): Promise<void> {
    await this.campaigns.removeSegment(sessionId, id);
  }

  @Post('preview')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resolve an audience without saving anything',
    description:
      'Returns the number of distinct chats the audience resolves to and a sample. A `label` audience ' +
      'answers `501` on Baileys, which exposes label writes but no label query.',
  })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({ status: 200, type: CampaignPreviewResultDto })
  @ApiResponse({ status: 400, description: 'The audience is incomplete or names chats outside the session.' })
  @ApiResponse({ status: 501, description: 'The engine cannot list chats by label.' })
  async preview(
    @Param('sessionId') sessionId: string,
    @Body() dto: CampaignPreviewDto,
  ): Promise<CampaignPreviewResultDto> {
    return this.campaigns.preview(sessionId, dto);
  }

  @Get(':id')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'Campaign detail with the first page of recipients' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Campaign ID' })
  @ApiResponse({ status: 200, type: CampaignDetailDto })
  @ApiResponse({ status: 404, description: 'No such campaign.' })
  async get(@Param('sessionId') sessionId: string, @Param('id') id: string): Promise<CampaignDetailDto> {
    return this.campaigns.get(sessionId, id);
  }

  @Patch(':id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Edit a draft or scheduled campaign' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Campaign ID' })
  @ApiResponse({ status: 200, type: CampaignDto })
  @ApiResponse({ status: 400, description: 'The campaign already ran, or the edit is incomplete.' })
  @ApiResponse({ status: 404, description: 'No such campaign.' })
  async update(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
    @Body() dto: UpdateCampaignDto,
  ): Promise<CampaignDto> {
    if (
      dto.name === undefined &&
      dto.content === undefined &&
      dto.audience === undefined &&
      dto.options === undefined &&
      dto.scheduledAt === undefined
    ) {
      throw new BadRequestException('Provide at least one field to update');
    }
    return this.campaigns.update(sessionId, id, dto);
  }

  @Delete(':id')
  @RequireRole(ApiKeyRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a draft or cancelled campaign' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Campaign ID' })
  @ApiResponse({ status: 204, description: 'Campaign deleted.' })
  @ApiResponse({ status: 400, description: 'A running, scheduled or completed campaign cannot be deleted.' })
  @ApiResponse({ status: 404, description: 'No such campaign.' })
  async remove(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
    @CurrentApiKey() apiKey: ApiKey | undefined,
  ): Promise<void> {
    await this.campaigns.remove(sessionId, id, apiKey!);
  }

  @Post(':id/start')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start a draft or scheduled campaign now' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Campaign ID' })
  @ApiResponse({ status: 200, type: CampaignDto, description: 'The campaign is running.' })
  @ApiResponse({
    status: 400,
    description: 'The campaign already ran, the session is not active, or the audience is empty.',
  })
  @ApiResponse({ status: 404, description: 'No such campaign.' })
  async start(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
    @CurrentApiKey() apiKey: ApiKey | undefined,
  ): Promise<CampaignDto> {
    return this.runner.start(sessionId, id, apiKey!);
  }

  @Post(':id/cancel')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a draft, scheduled or running campaign' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Campaign ID' })
  @ApiResponse({ status: 200, type: CampaignDto })
  @ApiResponse({ status: 400, description: 'A completed or failed campaign cannot be cancelled.' })
  @ApiResponse({ status: 404, description: 'No such campaign.' })
  async cancel(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
    @CurrentApiKey() apiKey: ApiKey | undefined,
  ): Promise<CampaignDto> {
    return this.runner.cancel(sessionId, id, apiKey!);
  }

  @Get(':id/recipients')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'One page of a campaign’s recipients' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'id', description: 'Campaign ID' })
  @ApiQuery({ name: 'status', required: false, enum: CAMPAIGN_RECIPIENT_STATUSES })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: 'integer',
    description: `1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}`,
  })
  @ApiQuery({ name: 'offset', required: false, type: 'integer', description: 'Default 0' })
  @ApiResponse({ status: 200, type: [CampaignRecipientDto] })
  @ApiResponse({ status: 404, description: 'No such campaign.' })
  async listRecipients(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
    @Query('status') status: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
  ): Promise<CampaignRecipientDto[]> {
    return this.campaigns.listRecipients(
      sessionId,
      id,
      this.parseRecipientStatus(status),
      this.parseLimit(limit),
      this.parseOffset(offset),
    );
  }

  private parseStatus(status?: string): CampaignStatus | undefined {
    if (!status) return undefined;
    if (!CAMPAIGN_STATUSES.includes(status as CampaignStatus)) {
      throw new BadRequestException(`status must be one of ${CAMPAIGN_STATUSES.join(', ')}`);
    }
    return status as CampaignStatus;
  }

  private parseRecipientStatus(status?: string): CampaignRecipientStatus | undefined {
    if (!status) return undefined;
    if (!CAMPAIGN_RECIPIENT_STATUSES.includes(status as CampaignRecipientStatus)) {
      throw new BadRequestException(`status must be one of ${CAMPAIGN_RECIPIENT_STATUSES.join(', ')}`);
    }
    return status as CampaignRecipientStatus;
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
