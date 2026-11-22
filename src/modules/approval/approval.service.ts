import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApprovalRequest, ApprovalRequestStatus } from './entities/approval-request.entity';
import { ApprovalNotificationService } from './approval-notification.service';
import { WhatsAppIdentityService } from './whatsapp-identity.service';
import { IngestApprovalRequestDto } from './dto/approval.dto';

/** Status yang masih boleh menerima penetapan target pertama kali. */
const TARGET_BINDABLE: readonly ApprovalRequestStatus[] = ['PENDING_APPROVAL'];

/**
 * Penerimaan data izin dari Core dan pembacaan status internal Connect.
 *
 * Permohonan yang sudah final tidak ditimpa keputusannya; hanya metadata
 * tampilan dan `coreStatus` yang disegarkan.
 *
 * Subjek otorisasi (`targetCorePersonId`, `targetIdentity`) dan sesi pengiriman bersifat tetap
 * begitu permohonan berjalan: mengubahnya di tengah proses berarti mengubah siapa yang berhak
 * memutuskan — persis yang tidak boleh terjadi lewat sinkronisasi ulang.
 */
@Injectable()
export class ApprovalService {
  constructor(
    @InjectRepository(ApprovalRequest, 'data')
    private readonly requests: Repository<ApprovalRequest>,
    private readonly notification: ApprovalNotificationService,
    private readonly identities: WhatsAppIdentityService,
  ) {}

  async ingest(dto: IngestApprovalRequestDto, allowedSessions: string[] | null = null): Promise<ApprovalRequest> {
    this.assertSessionAllowed(dto.sessionId, allowedSessions);

    const targetIdentity = this.normalizeTargetIdentity(dto.targetIdentity);
    const existing = await this.requests.findOne({ where: { coreRequestId: dto.coreRequestId } });

    if (existing) {
      this.assertSubjectsUnchanged(existing, dto, targetIdentity);

      existing.studentName = dto.studentName;
      existing.studentClass = dto.studentClass ?? existing.studentClass;
      existing.dormitoryCoreId = dto.dormitoryCoreId ?? existing.dormitoryCoreId;
      existing.dormitoryName = dto.dormitoryName ?? existing.dormitoryName;
      existing.permitType = dto.permitType;
      existing.requestedDurationDays = dto.requestedDurationDays ?? existing.requestedDurationDays;
      existing.departureAt = dto.departureAt ? new Date(dto.departureAt) : existing.departureAt;
      existing.expectedReturnAt = dto.expectedReturnAt ? new Date(dto.expectedReturnAt) : existing.expectedReturnAt;
      existing.targetCorePersonId = dto.targetCorePersonId ?? existing.targetCorePersonId;
      existing.targetIdentity = targetIdentity ?? existing.targetIdentity;
      existing.sessionId = dto.sessionId ?? existing.sessionId;
      existing.coreStatus = dto.coreStatus ?? existing.coreStatus;

      const saved = await this.requests.save(existing);

      if (dto.notify !== false) {
        await this.safeNotify(saved);
      }

      return saved;
    }

    const created = await this.requests.save(
      this.requests.create({
        coreRequestId: dto.coreRequestId,
        reference: dto.reference,
        studentName: dto.studentName,
        studentClass: dto.studentClass ?? null,
        dormitoryCoreId: dto.dormitoryCoreId ?? null,
        dormitoryName: dto.dormitoryName ?? null,
        permitType: dto.permitType,
        requestedDurationDays: dto.requestedDurationDays ?? null,
        departureAt: dto.departureAt ? new Date(dto.departureAt) : null,
        expectedReturnAt: dto.expectedReturnAt ? new Date(dto.expectedReturnAt) : null,
        status: 'PENDING_APPROVAL',
        coreStatus: dto.coreStatus ?? 'pending',
        targetCorePersonId: dto.targetCorePersonId ?? null,
        targetIdentity,
        sessionId: dto.sessionId ?? null,
      }),
    );

    if (dto.notify !== false) {
      await this.safeNotify(created);
    }

    return created;
  }

  async list(filter: { status?: ApprovalRequestStatus; limit?: number }): Promise<ApprovalRequest[]> {
    return this.requests.find({
      where: filter.status ? { status: filter.status } : {},
      order: { createdAt: 'DESC' },
      take: Math.min(Math.max(filter.limit ?? 50, 1), 200),
    });
  }

  async get(id: string): Promise<ApprovalRequest> {
    const request = await this.requests.findOne({ where: { id } });

    if (!request) {
      throw new NotFoundException('Permohonan izin tidak ditemukan.');
    }

    return request;
  }

  async notify(id: string): Promise<ApprovalRequest> {
    const request = await this.get(id);
    await this.notification.notify(request);

    return request;
  }

  /**
   * Subjek otorisasi tidak boleh berubah lewat sinkronisasi ulang.
   *
   * `targetCorePersonId` dan `targetIdentity` menentukan siapa yang berhak menjawab; `sessionId`
   * menentukan sesi yang dipakai mengirim. Ketiganya boleh **diisi pertama kali** selama
   * permohonan masih `PENDING_APPROVAL` (Core dapat mengirim target menyusul), tetapi setelah
   * berjalan (`PROCESSING`) atau final nilainya tetap — perubahan harus ditolak, bukan diterapkan
   * diam-diam. Nilai yang sama (ingest ulang idempoten) selalu diterima.
   */
  private assertSubjectsUnchanged(
    existing: ApprovalRequest,
    dto: IngestApprovalRequestDto,
    targetIdentity: string | null,
  ): void {
    this.assertFrozen(existing, 'targetCorePersonId', dto.targetCorePersonId ?? null);
    this.assertFrozen(existing, 'targetIdentity', targetIdentity);
    this.assertFrozen(existing, 'sessionId', dto.sessionId ?? null);
  }

  private assertFrozen(
    existing: ApprovalRequest,
    field: 'targetCorePersonId' | 'targetIdentity' | 'sessionId',
    requested: string | null,
  ): void {
    if (requested === null) {
      return;
    }

    const current = existing[field];

    if (current === requested) {
      return;
    }

    if (current === null && TARGET_BINDABLE.includes(existing.status)) {
      return;
    }

    throw new ConflictException({
      code: 'approval_subject_immutable',
      field,
      message: `Field ${field} tidak dapat diubah setelah permohonan berjalan; subjek otorisasi bersifat tetap.`,
      current,
      requested,
    });
  }

  /**
   * Nomor tujuan disimpan dalam bentuk ternormalisasi agar pencocokan balasan konsisten.
   *
   * Nilai yang dikirim tetapi tidak menghasilkan satu digit pun ditolak: mengabaikannya diam-diam
   * akan menyamarkan bug Core sebagai "tidak ada perubahan subjek".
   */
  private normalizeTargetIdentity(value: string | undefined): string | null {
    if (!value) {
      return null;
    }

    const normalized = this.identities.normalize(value);

    if (normalized === '') {
      throw new BadRequestException('Nomor WhatsApp tujuan tidak valid.');
    }

    return normalized;
  }

  /**
   * Rute ini deployment-global, tetapi `sessionId` menentukan sesi WhatsApp
   * yang dipakai mengirim notifikasi. Key yang dibatasi sesi tidak boleh
   * menyebut sesi di luar cakupannya.
   */
  private assertSessionAllowed(sessionId: string | undefined, allowedSessions: string[] | null): void {
    if (!sessionId || allowedSessions === null || allowedSessions.length === 0) {
      return;
    }

    if (!allowedSessions.includes(sessionId)) {
      throw new ForbiddenException('Sesi WhatsApp di luar cakupan key ini.');
    }
  }

  private async safeNotify(request: ApprovalRequest): Promise<void> {
    try {
      await this.notification.notify(request);
    } catch {
      // Notifikasi gagal tidak boleh membatalkan penyimpanan permohonan;
      // pengiriman dapat diulang lewat POST /approval/requests/:id/notify.
    }
  }
}
