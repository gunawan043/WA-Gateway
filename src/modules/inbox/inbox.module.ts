import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiKey } from '../auth/entities/api-key.entity';
import { SessionModule } from '../session/session.module';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';
import { InboxConversation } from './entities/inbox-conversation.entity';
import { InboxNote } from './entities/inbox-note.entity';

/**
 * Team inbox. AuditModule and EventsModule are global, so the service injects their providers
 * directly. SessionModule is imported for `SessionService.listChats` — the chat list itself lives in
 * the engine, and this module never duplicates it.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([InboxConversation, InboxNote], 'data'),
    TypeOrmModule.forFeature([ApiKey], 'main'),
    SessionModule,
  ],
  controllers: [InboxController],
  providers: [InboxService],
  exports: [InboxService],
})
export class InboxModule {}
