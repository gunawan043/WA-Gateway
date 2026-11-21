import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_GUARD } from '@nestjs/core';
import { ApiKey } from './entities/api-key.entity';
import { User } from './entities/user.entity';
import { UserSession } from './entities/user-session.entity';
import { RoleAssignment } from './entities/role-assignment.entity';
import { Session } from '../session/entities/session.entity';
import { Division } from '../division/entities/division.entity';
import { AuthService } from './auth.service';
import { SessionAuthService } from './session-auth.service';
import { UsersService } from './users.service';
import { UserSeedService } from './user-seed.service';
import { ApiKeyUsageTracker } from './api-key-usage-tracker.service';
import { ChatScopeService } from './chat-scope.service';
import { ActiveKeyIndex } from './active-key-index';
import { PermissionService } from './permission.service';
import { AssignmentsService } from './assignments.service';
import { AuthController } from './auth.controller';
import { AuthValidateController } from './auth-validate.controller';
import { AuthAgentsController } from './auth-agents.controller';
import { AuthSessionController } from './auth-session.controller';
import { AuthUsersController } from './auth-users.controller';
import { AuthAssignmentsController } from './auth-assignments.controller';
import { ApiKeyGuard } from './guards/api-key.guard';
import { PermissionGuard } from './guards/permission.guard';
import { ProxyAwareThrottlerGuard } from '../../common/security/proxy-aware-throttler.guard';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([ApiKey, User, UserSession, RoleAssignment], 'main'),
    // Scope existence checks read the `data` connection; the rows themselves carry no FK to `main`.
    TypeOrmModule.forFeature([Session, Division], 'data'),
  ],
  controllers: [
    AuthController,
    AuthValidateController,
    AuthAgentsController,
    AuthSessionController,
    AuthUsersController,
    AuthAssignmentsController,
  ],
  providers: [
    AuthService,
    SessionAuthService,
    UsersService,
    UserSeedService,
    ApiKeyUsageTracker,
    ChatScopeService,
    ActiveKeyIndex,
    PermissionService,
    AssignmentsService,
    {
      provide: APP_GUARD,
      useClass: ProxyAwareThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ApiKeyGuard,
    },
    // After ApiKeyGuard: it reads the key the guard resolved and attached (docs/35 §35.5.5).
    {
      provide: APP_GUARD,
      useClass: PermissionGuard,
    },
  ],
  exports: [AuthService, SessionAuthService, ChatScopeService, ActiveKeyIndex, PermissionService, AssignmentsService],
})
export class AuthModule {}
