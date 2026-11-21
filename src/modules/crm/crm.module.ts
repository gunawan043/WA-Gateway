import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiKey } from '../auth/entities/api-key.entity';
import { CrmController } from './crm.controller';
import { CrmService } from './crm.service';
import { CrmDealActivity } from './entities/crm-deal-activity.entity';
import { CrmDeal } from './entities/crm-deal.entity';
import { CrmStage } from './entities/crm-stage.entity';

/**
 * Sales pipeline. AuditModule is global, so the service injects AuditService directly. `ApiKey` is
 * read on the always-SQLite `main` connection to resolve an assignee's display name, exactly as the
 * inbox does.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([CrmStage, CrmDeal, CrmDealActivity], 'data'),
    TypeOrmModule.forFeature([ApiKey], 'main'),
  ],
  controllers: [CrmController],
  providers: [CrmService],
  exports: [CrmService],
})
export class CrmModule {}
