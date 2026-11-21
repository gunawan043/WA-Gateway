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
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { CurrentApiKey, RequirePermission, RequireUnscopedKey } from './decorators/auth.decorators';
import { AssignmentsService } from './assignments.service';
import { ApiKey } from './entities/api-key.entity';
import { AssignmentResponseDto, CreateAssignmentDto, UpdateAssignmentDto, toAssignmentResponse } from './dto';

/**
 * Role assignments (docs/35 §35.5.6).
 *
 * `@RequireUnscopedKey` because an assignment has no session dimension: a key confined to one
 * session must not be able to widen credentials. Each route then demands a catalogue permission,
 * so the role structure — not the legacy `api_keys.role` — is what authorizes the call.
 */
@ApiTags('auth')
@Controller('auth/assignments')
@RequireUnscopedKey()
export class AuthAssignmentsController {
  constructor(
    private readonly assignments: AssignmentsService,
    private readonly auditService: AuditService,
  ) {}

  private auditContext(
    request: Request,
    actor?: ApiKey,
  ): { apiKey?: ApiKey; ipAddress?: string; method?: string; path?: string } {
    return {
      apiKey: actor,
      ipAddress: (request as Request & { clientIp?: string }).clientIp ?? undefined,
      method: request.method,
      path: request.path,
    };
  }

  @Get()
  @RequirePermission('role.read')
  @ApiOperation({ summary: 'List the role assignments of one key or account (admin or scoped reader)' })
  @ApiQuery({ name: 'apiKeyId', required: true, description: "The key's id, or a dashboard account's linked key id" })
  @ApiResponse({ status: 200, description: 'Assignments, oldest first', type: [AssignmentResponseDto] })
  @ApiResponse({ status: 400, description: 'apiKeyId is missing' })
  @ApiResponse({ status: 401, description: 'Missing or invalid credential' })
  @ApiResponse({ status: 403, description: 'Missing role.read, or a session-scoped key' })
  @ApiResponse({ status: 404, description: 'No key with that id' })
  async list(@Query('apiKeyId') apiKeyId?: string): Promise<AssignmentResponseDto[]> {
    if (!apiKeyId) throw new BadRequestException('apiKeyId is required');
    const rows = await this.assignments.list(apiKeyId);
    return rows.map(toAssignmentResponse);
  }

  @Post()
  @RequirePermission('role.assign')
  @ApiOperation({ summary: 'Grant a role, optionally bounded to a scope and a validity window' })
  @ApiResponse({ status: 201, description: 'Assignment created', type: AssignmentResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid role, scope or validity window' })
  @ApiResponse({ status: 401, description: 'Missing or invalid credential' })
  @ApiResponse({ status: 403, description: 'Missing role.assign, a session-scoped key, or a scope outside your own' })
  @ApiResponse({ status: 404, description: 'No key with that id' })
  @ApiResponse({ status: 409, description: 'That assignment already exists' })
  async create(
    @Body() dto: CreateAssignmentDto,
    @Req() request: Request,
    @CurrentApiKey() actor?: ApiKey,
  ): Promise<AssignmentResponseDto> {
    if (!actor) throw new BadRequestException('An API key is required');
    const row = await this.assignments.create(dto, actor);
    await this.auditService.logInfo(AuditAction.ROLE_ASSIGNMENT_CREATED, {
      ...this.auditContext(request, actor),
      metadata: {
        targetKeyId: row.apiKeyId,
        assignmentId: row.id,
        role: row.role,
        scopeType: row.scopeType,
        scopeId: row.scopeId,
        validFrom: row.validFrom,
        validTo: row.validTo,
      },
    });
    return toAssignmentResponse(row);
  }

  @Patch(':id')
  @RequirePermission('role.assign')
  @ApiOperation({ summary: 'Change an assignment’s role, scope or validity window' })
  @ApiResponse({ status: 200, description: 'Assignment updated', type: AssignmentResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid role, scope or validity window' })
  @ApiResponse({ status: 401, description: 'Missing or invalid credential' })
  @ApiResponse({ status: 403, description: 'Missing role.assign, a session-scoped key, or a scope outside your own' })
  @ApiResponse({ status: 404, description: 'No such assignment' })
  @ApiResponse({ status: 409, description: 'That assignment already exists, or it is the last global administrator' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateAssignmentDto,
    @Req() request: Request,
    @CurrentApiKey() actor?: ApiKey,
  ): Promise<AssignmentResponseDto> {
    if (!actor) throw new BadRequestException('An API key is required');
    const before = await this.assignments.findOne(id);
    const row = await this.assignments.update(id, dto, actor);
    await this.auditService.logInfo(AuditAction.ROLE_ASSIGNMENT_UPDATED, {
      ...this.auditContext(request, actor),
      metadata: {
        targetKeyId: row.apiKeyId,
        assignmentId: row.id,
        before: {
          role: before.role,
          scopeType: before.scopeType,
          scopeId: before.scopeId,
          validFrom: before.validFrom,
          validTo: before.validTo,
        },
        after: {
          role: row.role,
          scopeType: row.scopeType,
          scopeId: row.scopeId,
          validFrom: row.validFrom,
          validTo: row.validTo,
        },
      },
    });
    return toAssignmentResponse(row);
  }

  @Delete(':id')
  @RequirePermission('role.assign')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke an assignment' })
  @ApiResponse({
    status: 204,
    description: 'Assignment revoked; the key’s cached authority and live sockets are dropped',
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid credential' })
  @ApiResponse({ status: 403, description: 'Missing role.assign, or a session-scoped key' })
  @ApiResponse({ status: 404, description: 'No such assignment' })
  @ApiResponse({ status: 409, description: 'It is the last global administrator' })
  async remove(@Param('id') id: string, @Req() request: Request, @CurrentApiKey() actor?: ApiKey): Promise<void> {
    const row = await this.assignments.remove(id);
    await this.auditService.logInfo(AuditAction.ROLE_ASSIGNMENT_REVOKED, {
      ...this.auditContext(request, actor),
      metadata: {
        targetKeyId: row.apiKeyId,
        assignmentId: row.id,
        role: row.role,
        scopeType: row.scopeType,
        scopeId: row.scopeId,
      },
    });
  }
}
