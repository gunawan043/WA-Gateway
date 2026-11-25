import { Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { AlimCoreSettingsController } from './alim-core-settings.controller';
import { AlimCoreSettingsService } from './alim-core-settings.service';

@Module({
  controllers: [SettingsController, AlimCoreSettingsController],
  providers: [AlimCoreSettingsService],
})
export class SettingsModule {}
