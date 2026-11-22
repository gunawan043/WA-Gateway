import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Optional,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { recordApprovalIngestRejection } from '../../common/metrics/approval-metrics';
import { CurrentApiKey, RequireRole, RequireUnscopedKey } from '../auth/decorators/auth.decorators';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { ApprovalIngestGuard } from './approval-ingest.guard';
import { ApprovalService } from './approval.service';
import { WhatsAppIdentityService, snapshotOf } from './whatsapp-identity.service';
import type { WhatsAppIdentityUpsertResult } from './whatsapp-identity.service';
import {
  GetApprovalRequestQueryDto,
  IngestApprovalRequestDto,
  ListApprovalRequestsQueryDto,
  UpsertWhatsAppIdentityDto,
} from './dto/approval.dto';
import { ApprovalRequestDetailView, ApprovalRequestView, toApprovalRequestView } from './dto/approval-response.dto';
import { toApprovalCommandView } from './dto/approval-command-response.dto';
import { WhatsAppIdentity } from './entities/whatsapp-identity.entity';

/**
 * Penerimaan permohonan izin dari ALIM Core dan pengelolaan pemetaan identitas.
 *
 * Endpoint ini tidak memutuskan izin: keputusan hanya masuk lewat balasan
 * WhatsApp yang diteruskan ke Approval Command API milik Core.
 *
 * Deployment-global (tidak ada dimensi sesi pada rute), jadi ditutup untuk
 * key yang dibatasi sesi.
 */
@ApiTags('approval')
@RequireUnscopedKey()
@Controller('approval')
export class ApprovalController {
  constructor(
    private readonly approvals: ApprovalService,
    private readonly identities: WhatsAppIdentityService,
    // Audit bersifat best-effort (lihat AuditService.log). `@Optional()` mengikuti pola controller
    // infra: tes yang tidak peduli audit tidak harus menyediakannya, sedangkan aplikasi selalu
    // memilikinya karena AuditModule bersifat global.
    @Optional() private readonly audit?: AuditService,
  ) {}

  @Post('requests')
  @RequireRole(ApiKeyRole.ADMIN)
  @UseGuards(ApprovalIngestGuard)
  @ApiOperation({ summary: 'Terima permohonan izin dari ALIM Core dan kirim notifikasi WhatsApp' })
  @ApiResponse({ status: 201, description: 'Permohonan tersimpan (idempoten berdasarkan coreRequestId).' })
  @ApiResponse({ status: 401, description: 'Kredensial layanan Core tidak sah.' })
  @ApiResponse({
    status: 409,
    description: 'Subjek otorisasi berubah setelah permohonan diproses (approval_subject_immutable).',
  })
  @ApiResponse({ status: 503, description: 'Ingest belum dikonfigurasi (ALIM_CONNECT_INGEST_KEY kosong).' })
  async ingest(@Body() dto: IngestApprovalRequestDto, @CurrentApiKey() apiKey?: ApiKey): Promise<ApprovalRequestView> {
    try {
      const request = await this.approvals.ingest(dto, apiKey?.allowedSessions ?? null);

      return toApprovalRequestView(request);
    } catch (error) {
      // Refusals are counted here rather than in the service: the service also answers a scoped key
      // with 403, which is an authorisation answer, not a rejected ingest contract.
      if (error instanceof ConflictException) {
        recordApprovalIngestRejection('subject_immutable');
      } else if (error instanceof BadRequestException) {
        recordApprovalIngestRejection('invalid');
      }

      throw error;
    }
  }

  @Get('requests')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'Daftar permohonan izin beserta status internal Connect' })
  async list(@Query() query: ListApprovalRequestsQueryDto): Promise<ApprovalRequestView[]> {
    const requests = await this.approvals.list(query);

    return requests.map(toApprovalRequestView);
  }

  @Get('requests/:id')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'Detail satu permohonan izin, opsional dengan riwayat command' })
  @ApiParam({ name: 'id', description: 'Approval request id' })
  @ApiResponse({ status: 200, type: ApprovalRequestDetailView })
  async get(@Param('id') id: string, @Query() query: GetApprovalRequestQueryDto): Promise<ApprovalRequestDetailView> {
    const request = toApprovalRequestView(await this.approvals.get(id));

    if (query.include !== 'commands') {
      return request;
    }

    const commands = await this.approvals.listCommands(id);

    return { ...request, commands: commands.map(toApprovalCommandView) };
  }

  @Post('requests/:id/notify')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Kirim ulang notifikasi WhatsApp untuk permohonan ini' })
  @ApiParam({ name: 'id', description: 'Approval request id' })
  async notify(@Param('id') id: string): Promise<ApprovalRequestView> {
    return toApprovalRequestView(await this.approvals.notify(id));
  }

  @Post('identities')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Petakan nomor WhatsApp ke personel Core' })
  @ApiResponse({
    status: 409,
    description:
      'Nomor sudah dipetakan ke personel Core lain tanpa `reassign: true` (identity_reassign_requires_flag).',
  })
  async upsertIdentity(
    @Body() dto: UpsertWhatsAppIdentityDto,
    @CurrentApiKey() apiKey?: ApiKey,
  ): Promise<WhatsAppIdentity> {
    try {
      const result = await this.identities.upsert({
        externalIdentity: dto.externalIdentity,
        corePersonId: dto.corePersonId,
        displayName: dto.displayName ?? null,
        isVerified: dto.isVerified,
        isActive: dto.isActive,
        reassign: dto.reassign ?? false,
      });

      await this.recordIdentityChange(result, apiKey);

      return result.identity;
    } catch (error) {
      await this.recordIdentityRejection(error, dto, apiKey);
      throw error;
    }
  }

  /**
   * Jejak audit untuk setiap perubahan pemetaan.
   *
   * Actor berasal dari key yang sudah diautentikasi (kolom `apiKeyId`/`apiKeyName` pada baris
   * audit), bukan dari payload — sehingga klaim "saya begini" tidak pernah dipercaya. Nilai
   * sebelum dan sesudah disimpan agar pemetaan tetap dapat dipertanggungjawabkan setelah
   * dinonaktifkan atau dialihkan.
   */
  private async recordIdentityChange(result: WhatsAppIdentityUpsertResult, apiKey?: ApiKey): Promise<void> {
    await this.audit?.logInfo(AuditAction.APPROVAL_IDENTITY_CHANGED, {
      apiKey,
      metadata: {
        result: 'applied',
        change: result.change,
        externalIdentity: result.identity.externalIdentity,
        before: result.before,
        after: snapshotOf(result.identity),
      },
    });
  }

  /** Percobaan pemindahan tanpa penanda dicatat: itu kejadian yang perlu terlihat, bukan 400 biasa. */
  private async recordIdentityRejection(
    error: unknown,
    dto: UpsertWhatsAppIdentityDto,
    apiKey?: ApiKey,
  ): Promise<void> {
    if (!(error instanceof ConflictException)) {
      return;
    }

    const response = error.getResponse() as { code?: string; currentCorePersonId?: string };

    await this.audit?.logWarn(AuditAction.APPROVAL_IDENTITY_CHANGED, {
      apiKey,
      metadata: {
        result: 'rejected',
        change: 'reassign',
        code: response.code ?? 'identity_reassign_requires_flag',
        externalIdentity: dto.externalIdentity,
        requestedCorePersonId: dto.corePersonId,
        currentCorePersonId: response.currentCorePersonId ?? null,
      },
    });
  }
}
