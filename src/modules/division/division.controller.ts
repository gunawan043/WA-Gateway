import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentApiKey, RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { DivisionService } from './division.service';
import {
  CreateDivisionDto,
  DivisionDto,
  DivisionSettingsDto,
  UpdateDivisionDto,
  UpdateDivisionSettingsDto,
} from './dto/division.dto';

/**
 * Division routing configuration. This is session configuration, not chat data: a key restricted to
 * specific chats is refused by the default chat-scope rule, which is the intended answer.
 *
 * The `settings` routes are declared before `:divisionId` so the literal is never parsed as an id.
 */
@ApiTags('divisions')
@Controller('sessions/:sessionId/divisions')
export class DivisionController {
  constructor(private readonly divisions: DivisionService) {}

  @Get()
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'List the session’s divisions in menu order' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({
    status: 200,
    description: 'Divisions ordered by sortOrder, then name.',
    type: DivisionDto,
    isArray: true,
  })
  async list(@Param('sessionId') sessionId: string): Promise<DivisionDto[]> {
    return this.divisions.list(sessionId);
  }

  @Post()
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Create a division' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({ status: 201, description: 'Division created.', type: DivisionDto })
  @ApiResponse({
    status: 400,
    description: 'Invalid keyword (only digits), unknown or inactive agent key, or the per-session limit is reached.',
  })
  @ApiResponse({ status: 404, description: 'No session with this id.' })
  @ApiResponse({ status: 409, description: 'A division with this name already exists in the session.' })
  async create(
    @Param('sessionId') sessionId: string,
    @Body() dto: CreateDivisionDto,
    @CurrentApiKey() apiKey?: ApiKey,
  ): Promise<DivisionDto> {
    return this.divisions.create(sessionId, dto, apiKey);
  }

  @Get('settings')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'Get the session’s routing settings' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({ status: 200, description: 'Settings, with defaults when never saved.', type: DivisionSettingsDto })
  async getSettings(@Param('sessionId') sessionId: string): Promise<DivisionSettingsDto> {
    return this.divisions.getSettings(sessionId);
  }

  @Patch('settings')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Update the session’s routing settings' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiResponse({ status: 200, description: 'Updated settings.', type: DivisionSettingsDto })
  @ApiResponse({ status: 404, description: 'No session with this id.' })
  async updateSettings(
    @Param('sessionId') sessionId: string,
    @Body() dto: UpdateDivisionSettingsDto,
    @CurrentApiKey() apiKey?: ApiKey,
  ): Promise<DivisionSettingsDto> {
    return this.divisions.updateSettings(sessionId, dto, apiKey);
  }

  @Patch(':divisionId')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Update a division, including its agents' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'divisionId', description: 'Division ID' })
  @ApiResponse({ status: 200, description: 'Updated division.', type: DivisionDto })
  @ApiResponse({ status: 400, description: 'Invalid keyword, or an unknown or inactive agent key.' })
  @ApiResponse({ status: 404, description: 'No such division in this session.' })
  @ApiResponse({ status: 409, description: 'A division with this name already exists in the session.' })
  async update(
    @Param('sessionId') sessionId: string,
    @Param('divisionId') divisionId: string,
    @Body() dto: UpdateDivisionDto,
    @CurrentApiKey() apiKey?: ApiKey,
  ): Promise<DivisionDto> {
    return this.divisions.update(sessionId, divisionId, dto, apiKey);
  }

  @Delete(':divisionId')
  @RequireRole(ApiKeyRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a division' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'divisionId', description: 'Division ID' })
  @ApiResponse({ status: 204, description: 'Division deleted. Routed conversations keep their assignee.' })
  @ApiResponse({ status: 404, description: 'No such division in this session.' })
  async remove(
    @Param('sessionId') sessionId: string,
    @Param('divisionId') divisionId: string,
    @CurrentApiKey() apiKey?: ApiKey,
  ): Promise<void> {
    await this.divisions.remove(sessionId, divisionId, apiKey);
  }
}
