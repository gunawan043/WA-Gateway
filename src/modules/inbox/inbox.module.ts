import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiKey } from '../auth/entities/api-key.entity';
import { DIVISION_INBOX_PORT } from '../division/division-inbox.port';
import { DivisionModule } from '../division/division.module';
import { SessionModule } from '../session/session.module';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';
import { InboxConversation } from './entities/inbox-conversation.entity';
import { InboxNote } from './entities/inbox-note.entity';

/**
 * Team inbox. AuditModule and EventsModule are global, so the service injects their providers
 * directly. SessionModule is imported for `SessionService.listChats` — the chat list itself lives in
 * the engine, and this module never duplicates it. DivisionModule is imported for the division
 * lookup and the resolve re-arm; it imports nothing back, so no cycle appears.
 *
 * `DIVISION_INBOX_PORT` is an alias for this service (never a factory: a factory would run the
 * service's lifecycle hooks a second time), so the division router can route a conversation without
 * importing this module.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([InboxConversation, InboxNote], 'data'),
    TypeOrmModule.forFeature([ApiKey], 'main'),
    SessionModule,
    DivisionModule,
  ],
  controllers: [InboxController],
  providers: [InboxService, { provide: DIVISION_INBOX_PORT, useExisting: InboxService }],
  exports: [InboxService, DIVISION_INBOX_PORT],
})
export class InboxModule {}
