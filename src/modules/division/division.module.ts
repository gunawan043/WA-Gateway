import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiKey } from '../auth/entities/api-key.entity';
import { Session } from '../session/entities/session.entity';
import { DivisionController } from './division.controller';
import { DivisionRouterService } from './division-router.service';
import { DivisionService } from './division.service';
import { Division } from './entities/division.entity';
import { DivisionAgent } from './entities/division-agent.entity';
import { DivisionChatState } from './entities/division-chat-state.entity';
import { DivisionSettings } from './entities/division-settings.entity';

/**
 * Division routing. Deliberately imports no feature module: SessionModule imports this one (the
 * projector calls the router), so anything imported here must not lead back to SessionModule.
 * `InboxService` is reached through the leaf `DIVISION_INBOX_PORT` token resolved lazily, and the
 * Session ENTITY is registered here for the same reason AutomationModule registers it — a
 * repository needs only the entity, while importing SessionModule would close the cycle.
 *
 * AuditModule and EventsModule are global.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Division, DivisionAgent, DivisionSettings, DivisionChatState, Session], 'data'),
    TypeOrmModule.forFeature([ApiKey], 'main'),
  ],
  controllers: [DivisionController],
  providers: [DivisionService, DivisionRouterService],
  exports: [DivisionService, DivisionRouterService],
})
export class DivisionModule {}
