import { Module } from '@nestjs/common';
import { ALIM_CORE_SSO_CLIENT } from './core-client/alim-core-sso.client';
import { HttpAlimCoreSsoClient } from './core-client/http-alim-core-sso.client';
import { SsoHandoffController } from './sso-handoff.controller';
import { SsoHandoffService } from './sso-handoff.service';

/**
 * The WhatsApp Connect SSO handoff.
 *
 * There is deliberately no mock client: the approval integration can run against a mock because a
 * mock decision is still recorded and reviewed, but a mock exchange would mint a real dashboard
 * session without Core ever redeeming a code. When the integration is not configured the endpoint
 * answers 503, which is the safe failure.
 */
@Module({
  controllers: [SsoHandoffController],
  providers: [
    SsoHandoffService,
    {
      provide: ALIM_CORE_SSO_CLIENT,
      useClass: HttpAlimCoreSsoClient,
    },
  ],
})
export class SsoModule {}
