import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { ApiKeyRole } from './entities/api-key.entity';
import { RequireRole, RequireUnscopedKey } from './decorators/auth.decorators';
import { UsersService } from './users.service';
import { CreateUserDto, ResetPasswordDto, UpdateUserDto, UserResponseDto, toUserResponse } from './dto';

/**
 * Dashboard accounts. ADMIN-only and off-limits to session-scoped keys: minting an account mints a
 * credential, which is exactly what `@RequireUnscopedKey` exists to stop a confined key from doing.
 */
@ApiTags('auth')
@Controller('auth/users')
@RequireRole(ApiKeyRole.ADMIN)
@RequireUnscopedKey()
export class AuthUsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly auditService: AuditService,
  ) {}

  private auditContext(request: Request): { ipAddress?: string; method?: string; path?: string } {
    return {
      ipAddress: (request as Request & { clientIp?: string }).clientIp ?? undefined,
      method: request.method,
      path: request.path,
    };
  }

  @Get()
  @ApiOperation({ summary: 'List dashboard accounts (admin only)' })
  @ApiResponse({ status: 200, description: 'Accounts, newest first', type: [UserResponseDto] })
  @ApiResponse({ status: 401, description: 'Missing or invalid credential' })
  @ApiResponse({ status: 403, description: 'Role below ADMIN, or a session-scoped key' })
  async findAll(): Promise<UserResponseDto[]> {
    const users = await this.usersService.findAll();
    return users.map(toUserResponse);
  }

  @Post()
  @ApiOperation({ summary: 'Create a dashboard account (admin only)' })
  @ApiResponse({ status: 201, description: 'Account created', type: UserResponseDto })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  @ApiResponse({ status: 401, description: 'Missing or invalid credential' })
  @ApiResponse({ status: 403, description: 'Role below ADMIN, or a session-scoped key' })
  @ApiResponse({ status: 409, description: 'A user with that email already exists' })
  async create(@Body() dto: CreateUserDto, @Req() request: Request): Promise<UserResponseDto> {
    const user = await this.usersService.create({
      email: dto.email,
      name: dto.name,
      role: dto.role ?? ApiKeyRole.OPERATOR,
      password: dto.password,
    });
    await this.auditService.logInfo(AuditAction.USER_CREATED, {
      ...this.auditContext(request),
      metadata: { targetUserId: user.id, targetEmail: user.email, role: user.role },
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
