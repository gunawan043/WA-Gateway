import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { allowUnauthenticatedAuditRow } from '../audit/auth-failure-audit-limiter';
import { EngineFactory } from '../../engine/engine.factory';
import { resolveClientIp } from '../../common/utils/ip';
import { setRequestActor } from '../../common/services/request-context';
import { Public, CurrentApiKey, CurrentAuthSession, CurrentUser } from './decorators/auth.decorators';
import { ApiKey } from './entities/api-key.entity';
import { User } from './entities/user.entity';
import { UserSession } from './entities/user-session.entity';
import { SessionAuthService } from './session-auth.service';
import { UsersService } from './users.service';
import { ChangePasswordDto, LoginDto, LoginResponseDto, MeResponseDto, toUserResponse } from './dto';

/**
 * Sign-in for people. Machines keep using `X-API-Key`.
 *
 * The token this issues is not a second principal: the guard resolves it to the account's linked
 * `api_keys` row, so roles, chat scope, audit attribution and the socket cap behave exactly as they
 * do for a key. Nothing here is reachable with a key that is not a dashboard account — `logout` and
 * `change-password` answer 400 for a key caller rather than pretending to act on an account.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthSessionController {
  constructor(
    private readonly usersService: UsersService,
    private readonly sessions: SessionAuthService,
    private readonly auditService: AuditService,
    private readonly engineFactory: EngineFactory,
    private readonly configService: ConfigService,
  ) {}

  /**
   * `@Public()` skips the key guard, which is also why the client IP has to be resolved here: the
   * guard normally stamps it on the request before any handler runs.
   */
  private clientIp(request: Request): string {
    const trustedProxies = this.configService.get<string[]>('security.trustedProxies') ?? [];
    return resolveClientIp(request, trustedProxies);
  }

  @Post('login')
  @Public()
  // Per IP, and deliberately tighter than the global tiers: a password guess is worth far less
  // throughput than a message. The global throttle still applies underneath.
  @Throttle({
    short: { limit: 5, ttl: 60_000 },
    medium: { limit: 20, ttl: 3_600_000 },
  })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in with email and password and receive a session token' })
  @ApiResponse({ status: 200, description: 'Signed in', type: LoginResponseDto })
  @ApiResponse({ status: 401, description: 'Email or password is incorrect, or the account is disabled' })
  @ApiResponse({ status: 429, description: 'Too many attempts from this address' })
  async login(@Body() dto: LoginDto, @Req() request: Request): Promise<LoginResponseDto> {
    const ipAddress = this.clientIp(request);
    const user = await this.usersService.authenticate(dto.email, dto.password);

    if (!user) {
      setRequestActor({ ipAddress });
      // Bounded per IP like the guard's own unauthenticated failures: an unknown-credential answer
      // costs the caller nothing, so one address cannot fill the audit log with them.
      if (allowUnauthenticatedAuditRow(ipAddress)) {
        void this.auditService.logWarn(AuditAction.USER_LOGIN_FAILED, {
          ipAddress,
          method: request.method,
          path: request.path,
          errorMessage: 'invalid credentials',
          metadata: { email: dto.email.trim().toLowerCase() },
        });
      }
      // One message for an unknown address, a wrong password and a disabled account.
      throw new UnauthorizedException('Email or password is incorrect');
    }

    const { token, session } = await this.sessions.issue(user, {
      ipAddress,
      userAgent: request.headers['user-agent'],
    });

    setRequestActor({ apiKeyId: user.apiKeyId, apiKeyName: user.name, ipAddress });
    await this.auditService.logInfo(AuditAction.USER_LOGIN_SUCCEEDED, {
      ipAddress,
      method: request.method,
      path: request.path,
      metadata: { userId: user.id, sessionId: session.id, role: user.role },
    });

    return {
      token,
      expiresAt: new Date(session.expiresAt).toISOString(),
      user: toUserResponse(user),
      role: user.role,
      // A dashboard account's linked key is never scoped; the field exists so the dashboard reads
      // the same shape it gets from /auth/validate.
      scoped: false,
      engineType: this.engineFactory.getCurrentEngine(),
    };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke the session token that made this request' })
  @ApiResponse({ status: 204, description: 'Session revoked' })
  @ApiResponse({ status: 400, description: 'The credential is an API key, not a dashboard session' })
  @ApiResponse({ status: 401, description: 'Missing or invalid credential' })
  async logout(@CurrentAuthSession() session: UserSession | undefined, @Req() request: Request): Promise<void> {
    if (!session) {
      throw new BadRequestException('Only a dashboard session can be logged out');
    }
    await this.sessions.revoke(session.id);
    await this.auditService.logInfo(AuditAction.USER_SESSION_REVOKED, {
      ipAddress: this.clientIp(request),
      method: request.method,
      path: request.path,
      metadata: { sessionId: session.id, userId: session.userId, reason: 'logout' },
    });
  }

  @Get('me')
  @ApiOperation({ summary: 'Describe the credential that made this request' })
  @ApiResponse({ status: 200, description: 'Caller identity', type: MeResponseDto })
  @ApiResponse({ status: 401, description: 'Missing or invalid credential' })
  me(@CurrentApiKey() apiKey: ApiKey, @CurrentUser() user: User | undefined): MeResponseDto {
    return {
      user: user ? toUserResponse(user) : null,
      role: apiKey.role,
      scoped: (apiKey.allowedSessions?.length ?? 0) > 0,
      engineType: this.engineFactory.getCurrentEngine(),
      keyId: apiKey.id,
      keyName: apiKey.name,
    };
  }

  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Change the signed-in account password' })
  @ApiResponse({ status: 204, description: 'Password changed; every other session was revoked' })
  @ApiResponse({ status: 400, description: 'The credential is an API key, not a dashboard session' })
  @ApiResponse({ status: 401, description: 'Current password is incorrect, or the credential is invalid' })
  async changePassword(
    @Body() dto: ChangePasswordDto,
    @CurrentUser() user: User | undefined,
    @CurrentAuthSession() session: UserSession | undefined,
    @Req() request: Request,
  ): Promise<void> {
    if (!user || !session) {
      throw new BadRequestException('Only a dashboard account can change its password');
    }
    await this.usersService.changeOwnPassword(user.id, dto.currentPassword, dto.newPassword, session.id);
    await this.auditService.logInfo(AuditAction.USER_PASSWORD_CHANGED, {
      ipAddress: this.clientIp(request),
      method: request.method,
      path: request.path,
      metadata: { userId: user.id },
    });
  }
}
