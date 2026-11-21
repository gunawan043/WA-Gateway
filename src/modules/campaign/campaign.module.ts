import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LabelModule } from '../label/label.module';
import { MessageModule } from '../message/message.module';
import { SessionModule } from '../session/session.module';
import { CampaignController } from './campaign.controller';
import { CampaignRunnerService } from './campaign-runner.service';
import { CampaignService } from './campaign.service';
import { CampaignRecipient } from './entities/campaign-recipient.entity';
import { CampaignSegment } from './entities/campaign-segment.entity';
import { Campaign } from './entities/campaign.entity';

/**
 * Broadcast campaigns. AuditModule and EventsModule are global, so the services inject theirs
 * directly. MessageModule supplies the bulk send path the runner drives; SessionModule and
 * LabelModule supply the two engine-backed audience sources (`all` chats and label membership).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Campaign, CampaignRecipient, CampaignSegment], 'data'),
    SessionModule,
    LabelModule,
    MessageModule,
  ],
  controllers: [CampaignController],
  providers: [CampaignService, CampaignRunnerService],
  exports: [CampaignService, CampaignRunnerService],
})
export class CampaignModule {}
