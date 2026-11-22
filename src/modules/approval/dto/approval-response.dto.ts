import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { ApprovalRequest, ApprovalRequestStatus } from '../entities/approval-request.entity';
// Value import: the decorator below references the class at runtime for the OpenAPI schema.
import { ApprovalCommandView } from './approval-command-response.dto';

/**
 * Bentuk permohonan yang boleh dibaca lewat API.
 *
 * Sebelumnya controller mengembalikan entitas database apa adanya, sehingga `VIEWER` — role
 * terendah — menerima nomor WhatsApp Kepala Asrama, `sessionId`, `lastCommandId`, `metadata`, dan
 * `targetCorePersonId`. Field itu internal: tidak dipakai konsumen mana pun (dashboard tidak
 * membaca endpoint approval), tetapi cukup untuk memetakan siapa memutuskan apa dan lewat sesi
 * mana. Yang tersisa di sini adalah data yang memang dibutuhkan untuk menampilkan dan mengawasi
 * satu permohonan.
 *
 * Field yang sengaja TIDAK ada:
 *  - `targetIdentity` — nomor WhatsApp pribadi penerima keputusan;
 *  - `targetCorePersonId` — identitas personel Core yang berwenang;
 *  - `sessionId`, `notificationMessageId` — topologi sesi gateway;
 *  - `lastCommandId`, `metadata` — jejak internal proses keputusan.
 *
 * Pembatasan per unit/asrama belum dapat diterapkan: Connect tidak menyimpan scope unit, dan
 * `VIEWER` saat ini melihat seluruh asrama. Itu batasan yang didokumentasikan, bukan pembatasan
 * semu berdasarkan nama role atau jabatan Core.
 */
export class ApprovalRequestView {
  @ApiProperty({ description: 'Approval request id (Connect)' })
  readonly id: string;

  @ApiProperty({ description: 'UUID permohonan izin di ALIM Core', format: 'uuid' })
  readonly coreRequestId: string;

  @ApiProperty({ description: 'Referensi unik yang dikutip di WhatsApp' })
  readonly reference: string;

  @ApiProperty({ description: 'Nama santri' })
  readonly studentName: string;

  @ApiPropertyOptional({ description: 'Kelas santri', type: String, nullable: true })
  readonly studentClass: string | null;

  @ApiPropertyOptional({ description: 'UUID asrama di Core', type: String, format: 'uuid', nullable: true })
  readonly dormitoryCoreId: string | null;

  @ApiPropertyOptional({ description: 'Nama asrama', type: String, nullable: true })
  readonly dormitoryName: string | null;

  @ApiProperty({ description: 'Jenis izin Core' })
  readonly permitType: string;

  @ApiPropertyOptional({ description: 'Durasi yang diminta (hari)', type: Number, nullable: true })
  readonly requestedDurationDays: number | null;

  @ApiPropertyOptional({ description: 'Waktu keberangkatan', type: String, format: 'date-time', nullable: true })
  readonly departureAt: Date | null;

  @ApiPropertyOptional({ description: 'Perkiraan waktu kembali', type: String, format: 'date-time', nullable: true })
  readonly expectedReturnAt: Date | null;

  @ApiProperty({ description: 'Status internal Connect' })
  readonly status: ApprovalRequestStatus;

  @ApiPropertyOptional({
    description: 'Status izin versi Core pada sinkronisasi terakhir',
    type: String,
    nullable: true,
  })
  readonly coreStatus: string | null;

  @ApiProperty({ description: 'Berapa kali klarifikasi diminta' })
  readonly clarificationCount: number;

  @ApiPropertyOptional({ description: 'Waktu keputusan final', type: String, format: 'date-time', nullable: true })
  readonly decidedAt: Date | null;

  @ApiPropertyOptional({ description: 'Sumber keputusan final (`whatsapp` atau `core`)', type: String, nullable: true })
  readonly decisionSource: string | null;

  @ApiPropertyOptional({
    description: 'Waktu notifikasi terakhir terkirim',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  readonly notificationSentAt: Date | null;

  @ApiProperty({ description: 'Waktu permohonan diterima Connect', type: String, format: 'date-time' })
  readonly createdAt: Date;

  @ApiProperty({ description: 'Waktu perubahan terakhir', type: String, format: 'date-time' })
  readonly updatedAt: Date;

  constructor(request: ApprovalRequest) {
    this.id = request.id;
    this.coreRequestId = request.coreRequestId;
    this.reference = request.reference;
    this.studentName = request.studentName;
    this.studentClass = request.studentClass;
    this.dormitoryCoreId = request.dormitoryCoreId;
    this.dormitoryName = request.dormitoryName;
    this.permitType = request.permitType;
    this.requestedDurationDays = request.requestedDurationDays;
    this.departureAt = request.departureAt;
    this.expectedReturnAt = request.expectedReturnAt;
    this.status = request.status;
    this.coreStatus = request.coreStatus;
    this.clarificationCount = request.clarificationCount;
    this.decidedAt = request.decidedAt;
    this.decisionSource = request.decisionSource;
    this.notificationSentAt = request.notificationSentAt;
    this.createdAt = request.createdAt;
    this.updatedAt = request.updatedAt;
  }
}

export function toApprovalRequestView(request: ApprovalRequest): ApprovalRequestView {
  return new ApprovalRequestView(request);
}

/**
 * Detail satu permohonan, dengan riwayat command bila `include=commands` diminta.
 *
 * Riwayat ini yang membuat "menunggu pemeriksaan manual" dapat dikerjakan tanpa membuka basis
 * data: status command, jumlah percobaan, kode HTTP/error, dan jadwal retry berikutnya.
 */
export class ApprovalRequestDetailView extends ApprovalRequestView {
  @ApiPropertyOptional({
    type: () => [ApprovalCommandView],
    description: 'Riwayat command ke Core, hanya bila diminta dengan `include=commands`',
  })
  readonly commands?: ApprovalCommandView[];
}
