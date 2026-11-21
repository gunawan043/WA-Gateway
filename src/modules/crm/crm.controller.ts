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
import { CurrentApiKey, RequireRole, RequireUnscopedKey } from '../auth/decorators/auth.decorators';
import { CrmService } from './crm.service';
import {
  AddCrmActivityDto,
  CreateCrmDealDto,
  CRM_STATUSES,
  CrmActivityDto,
  CrmBoardDto,
  CrmDealDetailDto,
  CrmDealDto,
  CrmStageDto,
  UpdateCrmDealDto,
  UpdateCrmStageDto,
} from './dto/crm.dto';
import type { CrmDealStatus } from './entities/crm-deal.entity';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * The sales pipeline. It is deployment-global — a deal is not owned by a session — so the class is
 * fenced with @RequireUnscopedKey and is NOT @ChatScoped: a chat-restricted key is refused by the
 * guard's default-deny, and a session-restricted key cannot reach the pipeline at all.
 */
@ApiTags('crm')
@Controller('crm')
@RequireUnscopedKey()
export class CrmController {
  constructor(private readonly crm: CrmService) {}

  @Get('board')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'The pipeline as stage columns, with open/won/lost counts' })
  @ApiResponse({ status: 200, type: CrmBoardDto })
  async board(): Promise<CrmBoardDto> {
    return this.crm.board();
  }

  @Get('stages')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'Pipeline stages in display order' })
  @ApiResponse({ status: 200, type: [CrmStageDto] })
  async listStages(): Promise<CrmStageDto[]> {
    return this.crm.listStages();
  }

  @Patch('stages/:id')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Rename, reorder or recolour a stage' })
  @ApiParam({ name: 'id', description: 'Stage ID' })
  @ApiResponse({ status: 200, type: CrmStageDto })
  @ApiResponse({ status: 404, description: 'No such stage.' })
  async updateStage(@Param('id') id: string, @Body() dto: UpdateCrmStageDto): Promise<CrmStageDto> {
    if (dto.name === undefined && dto.position === undefined && dto.color === undefined) {
      throw new BadRequestException('Provide name, position and/or color');
    }
    return this.crm.updateStage(id, dto);
  }

  @Get('deals')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'List deals, newest activity first' })
  @ApiQuery({ name: 'status', required: false, enum: CRM_STATUSES })
  @ApiQuery({ name: 'stageId', required: false, description: 'Only deals in this stage.' })
  @ApiQuery({
    name: 'assignee',
    required: false,
    description: '`me`, `unassigned`, or an API key id. Omit for every deal.',
  })
  @ApiQuery({ name: 'q', required: false, description: 'Case-insensitive search on title and notes.' })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: 'integer',
    description: `1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}`,
  })
  @ApiQuery({ name: 'offset', required: false, type: 'integer' })
  @ApiResponse({ status: 200, type: [CrmDealDto] })
  async list(
    @CurrentApiKey() apiKey: ApiKey | undefined,
    @Query('status') status?: string,
    @Query('stageId') stageId?: string,
    @Query('assignee') assignee?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<CrmDealDto[]> {
    if (status && !CRM_STATUSES.includes(status as CrmDealStatus)) {
      throw new BadRequestException(`status must be one of ${CRM_STATUSES.join(', ')}`);
    }

    return this.crm.listDeals(
      { status: status as CrmDealStatus | undefined, stageId, assignee, q },
      this.parseLimit(limit),
      this.parseOffset(offset),
      apiKey?.id,
    );
  }

  @Post('deals')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a deal' })
  @ApiResponse({ status: 201, type: CrmDealDetailDto })
  @ApiResponse({ status: 400, description: 'Unknown stage, or assigneeKeyId is not an active API key.' })
  async create(@Body() dto: CreateCrmDealDto, @CurrentApiKey() apiKey: ApiKey | undefined): Promise<CrmDealDetailDto> {
    return this.crm.create(dto, apiKey!);
  }

  @Get('deals/:id')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'One deal with its activity history' })
  @ApiParam({ name: 'id', description: 'Deal ID' })
  @ApiResponse({ status: 200, type: CrmDealDetailDto })
  @ApiResponse({ status: 404, description: 'No such deal.' })
  async get(@Param('id') id: string): Promise<CrmDealDetailDto> {
    return this.crm.get(id);
  }

  @Patch('deals/:id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Update a deal, including moving it to another stage' })
  @ApiParam({ name: 'id', description: 'Deal ID' })
  @ApiResponse({ status: 200, type: CrmDealDetailDto })
  @ApiResponse({ status: 400, description: 'Unknown stage, or assigneeKeyId is not an active API key.' })
  @ApiResponse({ status: 404, description: 'No such deal.' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateCrmDealDto,
    @CurrentApiKey() apiKey: ApiKey | undefined,
  ): Promise<CrmDealDetailDto> {
    if (Object.values(dto).every(value => value === undefined)) {
      throw new BadRequestException('Provide at least one field to update');
    }
    return this.crm.update(id, dto, apiKey!);
  }

  @Delete('deals/:id')
  @RequireRole(ApiKeyRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a deal and its history' })
  @ApiParam({ name: 'id', description: 'Deal ID' })
  @ApiResponse({ status: 204, description: 'Deal deleted.' })
  @ApiResponse({ status: 404, description: 'No such deal.' })
  async remove(@Param('id') id: string, @CurrentApiKey() apiKey: ApiKey | undefined): Promise<void> {
    await this.crm.remove(id, apiKey!);
  }

  @Post('deals/:id/activities')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Append a note to a deal’s history' })
  @ApiParam({ name: 'id', description: 'Deal ID' })
  @ApiResponse({ status: 201, type: CrmActivityDto })
  @ApiResponse({ status: 404, description: 'No such deal.' })
  async addActivity(
    @Param('id') id: string,
    @Body() dto: AddCrmActivityDto,
    @CurrentApiKey() apiKey: ApiKey | undefined,
  ): Promise<CrmActivityDto> {
    return this.crm.addActivity(id, dto, apiKey!);
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
