import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequireRole, RequireUnscopedKey } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { UpdateAlimCoreSettingsDto } from './dto/update-alim-core-settings.dto';
import { AlimCoreSettingsService, type AlimCoreSettingsView, type SaveResult } from './alim-core-settings.service';
import { ShutdownService } from '../../common/services/shutdown.service';

/**
 * The ALIM Core connection, in one place.
 *
 * These values used to require editing `.env` over SSH and knowing which of twenty-one keys belonged
 * to which half of the integration. The page this backs reads the effective configuration, writes
 * changes to the dashboard-owned overlay, and never returns a secret.
 *
 * Every route is ADMIN and unscoped: this is deployment-wide configuration, so a key confined to a
 * few sessions has no claim on it — the same gate the deployment settings endpoint already uses.
 */
@ApiTags('settings')
@Controller('settings/alim-core')
export class AlimCoreSettingsController {
  constructor(
    private readonly service: AlimCoreSettingsService,
    private readonly shutdown: ShutdownService,
  ) {}

  @Get()
  @RequireRole(ApiKeyRole.ADMIN)
  @RequireUnscopedKey()
  @ApiOperation({ summary: 'Read the ALIM Core connection settings and their status' })
  @ApiResponse({ status: 200, description: 'Effective values. Secrets are reported as set or unset only.' })
  get(): AlimCoreSettingsView {
    return this.service.read();
  }

  @Put()
  @RequireRole(ApiKeyRole.ADMIN)
  @RequireUnscopedKey()
  @ApiOperation({ summary: 'Validate and store ALIM Core connection settings' })
  @ApiResponse({ status: 200, description: 'Stored. A restart applies the values.' })
  @ApiResponse({ status: 400, description: 'A value is malformed, or the combination cannot boot' })
  put(@Body() dto: UpdateAlimCoreSettingsDto): SaveResult {
    return this.service.save(dto.values ?? {}, process.env.NODE_ENV);
  }

  /**
   * Applies what was saved. Separate from the save on purpose: the values only reach the running
   * process at boot, and restarting is loud enough that it should be a distinct, deliberate action
   * rather than a side effect of pressing "save".
   *
   * The shutdown is scheduled, not awaited: the response has to leave before the process drains,
   * otherwise the browser shows a failed request for a restart that did happen. Readiness reports 503
   * during the grace window, so the load balancer stops sending traffic first.
   */
  @Post('restart')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireRole(ApiKeyRole.ADMIN)
  @RequireUnscopedKey()
  @ApiOperation({ summary: 'Restart the application so saved settings take effect' })
  @ApiResponse({ status: 202, description: 'Restart requested; the process drains and exits' })
  restart(): { requested: boolean; pending: string[] } {
    const pending = this.service.read().fields.filter(field => field.pendingRestart).map(field => field.key);
    this.shutdown.shutdown();
    return { requested: true, pending };
  }
}
