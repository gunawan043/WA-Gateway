import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { ApiKeyRole } from './entities/api-key.entity';
import { CurrentApiKey, RequireRole, RequireUnscopedKey } from './decorators/auth.decorators';
import { UsersService } from './users.service';
import { AssignmentsService } from './assignments.service';
import { isActiveAt } from './permission.service';
import { permissionsOfRoles, type RoleName } from './permissions';
import {
  CreateUserDto,
  ResetPasswordDto,
  UpdateUserDto,
  UserResponseDto,
  toAssignmentResponse,
  toUserResponse,
} from './dto';
import type { ApiKey } from './entities/api-key.entity';

/**
 * Dashboard accounts. ADMIN-only and off-limits to session-scoped keys: minting an account mints a
 * credential, which is exactly what `@RequireUnscopedKey` exists to stop a confined key from doing.
 *
 * From Fase 1 a new account must carry `assignments` (docs/35 §35.4.1). The legacy `role` is still
 * accepted and is derived from the grants when omitted, so the linked key — which every other part
 * of the gateway reads — stays meaningful.
 */
@ApiTags('auth')
@Controller('auth/users')
@RequireRole(ApiKeyRole.ADMIN)
@RequireUnscopedKey()
export class AuthUsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly assignments: AssignmentsService,
    private readonly auditService: AuditService,
  ) {}

  private auditContext(request: Request): { ipAddress?: string; method?: string; path?: string } {
    return {
      ipAddress: (request as Request & { clientIp?: string }).clientIp ?? undefined,
      method: request.method,
      path: request.path,
    };
  }

  /**
   * The legacy `api_keys.role` a set of grants implies, strongest grant wins. Only used when the
   * caller omitted `role`, so the column never disagrees with what the account can actually do.
   */
  private legacyRoleFrom(specs: readonly { role: RoleName }[]): ApiKeyRole {
    if (specs.some(spec => spec.role === 'system_admin' || spec.role === 'connect_admin')) {
      return ApiKeyRole.ADMIN;
    }
    if (specs.every(spec => spec.role === 'quality_evaluator' || spec.role === 'analyst')) {
      return ApiKeyRole.VIEWER;
    }
    return ApiKeyRole.OPERATOR;
  }

  @Get()
  @ApiOperation({ summary: 'List dashboard accounts (admin only)' })
  @ApiResponse({ status: 200, description: 'Accounts, newest first', type: [UserResponseDto] })
  @ApiResponse({ status: 401, description: 'Missing or invalid credential' })
  @ApiResponse({ status: 403, description: 'Role below ADMIN, or a session-scoped key' })
  async findAll(): Promise<UserResponseDto[]> {
    const users = await this.usersService.findAll();
    // One statement for every account's grants, not one per row.
    const rows = await this.assignments.listForKeys(users.map(user => user.apiKeyId));
    const now = new Date();
    return users.map(user => {
      const own = rows.filter(row => row.apiKeyId === user.apiKeyId);
      const active = own.filter(row => isActiveAt(row, now));
      const roles = [...new Set(active.map(row => row.role))] as RoleName[];
      return {
        ...toUserResponse(user),
        roles,
        permissions: permissionsOfRoles(roles),
        assignments: own.map(toAssignmentResponse),
      };
    });
  }

  @Post()
  @ApiOperation({ summary: 'Create a dashboard account with its role assignments (admin only)' })
  @ApiResponse({ status: 201, description: 'Account created', type: UserResponseDto })
  @ApiResponse({ status: 400, description: 'Validation failed, or `assignments` is missing or invalid' })
  @ApiResponse({ status: 401, description: 'Missing or invalid credential' })
  @ApiResponse({ status: 403, description: 'Role below ADMIN, a session-scoped key, or a scope outside your own' })
  @ApiResponse({ status: 409, description: 'A user with that email already exists' })
  async create(
    @Body() dto: CreateUserDto,
    @Req() request: Request,
    @CurrentApiKey() actor?: ApiKey,
  ): Promise<UserResponseDto> {
    // Validated before anything is written: a malformed grant must not leave a half-created account.
    const specs = await this.assignments.prepareForNewUser(dto.assignments);
    if (actor) await this.assignments.assertGrantable(actor, specs);

    const user = await this.usersService.create({
      email: dto.email,
      name: dto.name,
      role: dto.role ?? this.legacyRoleFrom(specs),
      password: dto.password,
      assignments: specs,
      grantedByKeyId: actor?.id ?? null,
      coreUserId: dto.coreUserId ?? null,
    });
    await this.auditService.logInfo(AuditAction.USER_CREATED, {
      ...this.auditContext(request),
      metadata: {
        targetUserId: user.id,
        targetEmail: user.email,
        role: user.role,
        assignments: specs.map(spec => ({ role: spec.role, scopeType: spec.scopeType, scopeId: spec.scopeId })),
        coreUserId: user.coreUserId ?? null,
      },
    });
    return toUserResponse(user);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a dashboard account (admin only)' })
  @ApiResponse({ status: 200, description: 'Account updated', type: UserResponseDto })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  @ApiResponse({ status: 401, description: 'Missing or invalid credential' })
  @ApiResponse({ status: 403, description: 'Role below ADMIN, or a session-scoped key' })
  @ApiResponse({ status: 404, description: 'No such account' })
  @ApiResponse({ status: 409, description: 'The change would remove the last admin' })
  async update(@Param('id') id: string, @Body() dto: UpdateUserDto, @Req() request: Request): Promise<UserResponseDto> {
    const user = await this.usersService.update(id, dto);
    await this.auditService.logInfo(AuditAction.USER_UPDATED, {
      ...this.auditContext(request),
      metadata: {
        targetUserId: user.id,
        targetEmail: user.email,
        role: user.role,
        isActive: user.isActive,
        name: user.name,
        coreUserId: user.coreUserId ?? null,
      },
    });
    return toUserResponse(user);
  }

  @Post(':id/reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Set a new password for an account and revoke its sessions (admin only)' })
  @ApiResponse({ status: 204, description: 'Password replaced; every session of the account was revoked' })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  @ApiResponse({ status: 401, description: 'Missing or invalid credential' })
  @ApiResponse({ status: 403, description: 'Role below ADMIN, or a session-scoped key' })
  @ApiResponse({ status: 404, description: 'No such account' })
  async resetPassword(@Param('id') id: string, @Body() dto: ResetPasswordDto, @Req() request: Request): Promise<void> {
    const user = await this.usersService.resetPassword(id, dto.password);
    await this.auditService.logInfo(AuditAction.USER_PASSWORD_RESET, {
      ...this.auditContext(request),
      metadata: { targetUserId: user.id, targetEmail: user.email },
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an account and its linked API key (admin only)' })
  @ApiResponse({ status: 204, description: 'Account deleted' })
  @ApiResponse({ status: 401, description: 'Missing or invalid credential' })
  @ApiResponse({ status: 403, description: 'Role below ADMIN, or a session-scoped key' })
  @ApiResponse({ status: 404, description: 'No such account' })
  @ApiResponse({ status: 409, description: 'The account is the last admin' })
  async remove(@Param('id') id: string, @Req() request: Request): Promise<void> {
    const user = await this.usersService.remove(id);
    await this.auditService.logInfo(AuditAction.USER_DELETED, {
      ...this.auditContext(request),
      metadata: { targetUserId: user.id, targetEmail: user.email, role: user.role },
    });
  }
}
