import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MessageModule } from '../message/message.module';
import { ApprovalConfirmationService } from './approval-confirmation.service';
import { ApprovalController } from './approval.controller';
import { ApprovalInboundHook } from './approval-inbound.hook';
import { ApprovalNotificationService } from './approval-notification.service';
import { ApprovalProcessorService } from './approval-processor.service';
import { ApprovalReplyResolver } from './approval-reply-resolver.service';
import { ApprovalRetryService } from './approval-retry.service';
import { ApprovalService } from './approval.service';
import { ALIM_CORE_APPROVAL_CLIENT } from './core-client/alim-core-approval.client';
import type { AlimCoreApprovalClient } from './core-client/alim-core-approval.client';
import { assertApprovalCoreClientAllowed, isApprovalIntegrationDisabled } from './core-client/core-client-policy';
import { DisabledAlimCoreApprovalClient } from './core-client/disabled-alim-core-approval.client';
import { HttpAlimCoreApprovalClient } from './core-client/http-alim-core-approval.client';
import { MockAlimCoreApprovalClient } from './core-client/mock-alim-core-approval.client';
import { ApprovalCommand } from './entities/approval-command.entity';
import { ApprovalRequest } from './entities/approval-request.entity';
import { WhatsAppIdentity } from './entities/whatsapp-identity.entity';
import { WhatsAppIdentityService } from './whatsapp-identity.service';

/**
 * Alur persetujuan izin lewat WhatsApp.
 *
 * Client Core dipilih dari konfigurasi (`connect.approval.coreClient`):
 * `mock` untuk pengembangan/uji kontrak, `http` untuk Core nyata. Keduanya
 * memakai kontrak yang sama, sehingga tidak ada endpoint palsu di Core.
 */
/**
 * Memilih klien Core untuk provider `ALIM_CORE_APPROVAL_CLIENT`.
 *
 * Diekspor supaya jalur startup ini dapat diuji langsung: `assertApprovalCoreClientAllowed`
 * menggagalkan boot ketika produksi akan memakai mock atau klien HTTP tanpa alamat/kunci, dan
 * mengizinkan `disabled` — mode yang membuat ALIM Connect berjalan tanpa integrasi Core.
 */
export function createApprovalCoreClient(
  config: ConfigService,
  mock: MockAlimCoreApprovalClient,
  http: HttpAlimCoreApprovalClient,
  disabled: DisabledAlimCoreApprovalClient,
): AlimCoreApprovalClient {
  const coreClient = config.get<string>('connect.approval.coreClient', 'mock');

  assertApprovalCoreClientAllowed({
    coreClient,
    coreBaseUrl: config.get<string>('connect.approval.coreBaseUrl', ''),
    coreApiKey: config.get<string>('connect.approval.coreApiKey', ''),
  });

  if (isApprovalIntegrationDisabled({ coreClient, coreBaseUrl: '', coreApiKey: '' })) {
    return disabled;
  }

  return coreClient === 'http' ? http : mock;
}

@Module({
  imports: [TypeOrmModule.forFeature([ApprovalRequest, ApprovalCommand, WhatsAppIdentity], 'data'), MessageModule],
  controllers: [ApprovalController],
  providers: [
    ApprovalService,
    ApprovalNotificationService,
    ApprovalConfirmationService,
    ApprovalReplyResolver,
    ApprovalProcessorService,
    ApprovalRetryService,
    WhatsAppIdentityService,
    ApprovalInboundHook,
    MockAlimCoreApprovalClient,
    HttpAlimCoreApprovalClient,
    DisabledAlimCoreApprovalClient,
    {
      provide: ALIM_CORE_APPROVAL_CLIENT,
      inject: [ConfigService, MockAlimCoreApprovalClient, HttpAlimCoreApprovalClient, DisabledAlimCoreApprovalClient],
      useFactory: createApprovalCoreClient,
    },
  ],
  exports: [ApprovalService, ApprovalProcessorService, WhatsAppIdentityService],
})
export class ApprovalModule {}
