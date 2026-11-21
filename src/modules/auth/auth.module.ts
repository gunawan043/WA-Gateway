import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_GUARD } from '@nestjs/core';
import { ApiKey } from './entities/api-key.entity';
import { User } from './entities/user.entity';
import { UserSession } from './entities/user-session.entity';
import { AuthService } from './auth.service';
import { SessionAuthService } from './session-auth.service';
import { UsersService } from './users.service';
import { UserSeedService } from './user-seed.service';
import { ApiKeyUsageTracker } from './api-key-usage-tracker.service';
import { ChatScopeService } from './chat-scope.service';
import { ActiveKeyIndex } from './active-key-index';
import { AuthController } from './auth.controller';
import { AuthValidateController } from './auth-validate.controller';
import { AuthAgentsController } from './auth-agents.controller';
import { AuthSessionController } from './auth-session.controller';
import { AuthUsersController } from './auth-users.controller';
import { ApiKeyGuard } from './guards/api-key.guard';
import { ProxyAwareThrottlerGuard } from '../../common/security/proxy-aware-throttler.guard';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([ApiKey, User, UserSession], 'main')],
  controllers: [
    AuthController,
    AuthValidateController,
    AuthAgentsController,
    AuthSessionController,
    AuthUsersController,
  ],
  providers: [
    AuthService,
    SessionAuthService,
    UsersService,
    UserSeedService,
    ApiKeyUsageTracker,
    ChatScopeService,
    ActiveKeyIndex,
    {
      provide: APP_GUARD,
      useClass: ProxyAwareThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ApiKeyGuard,
    },
  ],
  exports: [AuthService, SessionAuthService, ChatScopeService, ActiveKeyIndex],
})
export class AuthModule {}
