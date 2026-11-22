import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ToStrictBoolean, ToStrictNumber, ToStrictString } from '../../../common/utils/strict-boolean';
import { NoNulCharacter } from '../../../common/validation/no-nul-character';

export const APPROVAL_REQUEST_STATUSES = [
  'PENDING_APPROVAL',
  'PROCESSING',
  'APPROVED',
  'REJECTED',
  'NEEDS_CLARIFICATION',
  'EXPIRED',
  'CANCELLED',
] as const;

/**
 * Data izin yang dikirim Core ke Connect. `coreRequestId` adalah UUID
 * `dormitory_permits.id` dan menjadi kunci idempotensi penerimaan.
 */
export class IngestApprovalRequestDto {
  @ApiProperty({ description: 'UUID permohonan izin di ALIM Core', format: 'uuid' })
  @IsUUID()
  coreRequestId!: string;

  @ApiProperty({ description: 'Referensi unik yang dikutip di WhatsApp', example: 'IZN-2026-00125', maxLength: 64 })
  @ToStrictString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @NoNulCharacter()
  reference!: string;

  @ApiProperty({ description: 'Nama santri', example: 'Ahmad Fauzi', maxLength: 191 })
  @ToStrictString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(191)
  @NoNulCharacter()
  studentName!: string;

  @ApiPropertyOptional({ description: 'Kelas santri', example: '7A', maxLength: 100 })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxLength(100)
  @NoNulCharacter()
  studentClass?: string;

  @ApiPropertyOptional({ description: 'UUID asrama di Core', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  dormitoryCoreId?: string;

  @ApiPropertyOptional({ description: 'Nama asrama', example: 'Asrama Putra 1', maxLength: 191 })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxLength(191)
  @NoNulCharacter()
  dormitoryName?: string;

  @ApiProperty({ description: 'Jenis izin Core', example: 'pulang', maxLength: 64 })
  @ToStrictString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  permitType!: string;

  @ApiPropertyOptional({ description: 'Durasi yang diminta (hari)', type: 'integer', minimum: 1, maximum: 365 })
  @IsOptional()
  @ToStrictNumber()
  @IsInt()
  @Min(1)
  @Max(365)
  requestedDurationDays?: number;

  @ApiPropertyOptional({ description: 'Waktu keberangkatan (ISO 8601)' })
  @IsOptional()
  @IsISO8601()
  departureAt?: string;

  @ApiPropertyOptional({ description: 'Perkiraan waktu kembali (ISO 8601)' })
  @IsOptional()
  @IsISO8601()
  expectedReturnAt?: string;

  @ApiPropertyOptional({ description: 'UUID user Core Kepala Asrama yang dituju', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  targetCorePersonId?: string;

  @ApiPropertyOptional({ description: 'Nomor WhatsApp tujuan (JID atau digit)', example: '6281234567890' })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxLength(191)
  targetIdentity?: string;

  @ApiPropertyOptional({ description: 'Sesi WhatsApp yang dipakai mengirim notifikasi' })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxLength(100)
  sessionId?: string;

  @ApiPropertyOptional({ description: 'Status izin di Core', example: 'pending', maxLength: 32 })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxLength(32)
  coreStatus?: string;

  @ApiPropertyOptional({ description: 'Kirim notifikasi WhatsApp sekarang (default true)' })
  @IsOptional()
  @ToStrictBoolean()
  @IsBoolean()
  notify?: boolean;
}

export class ListApprovalRequestsQueryDto {
  @ApiPropertyOptional({ enum: APPROVAL_REQUEST_STATUSES })
  @IsOptional()
  @IsIn(APPROVAL_REQUEST_STATUSES)
  status?: (typeof APPROVAL_REQUEST_STATUSES)[number];

  @ApiPropertyOptional({ description: 'Maksimum baris (1–200)', type: 'integer', default: 50 })
  @IsOptional()
  @ToStrictNumber()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class GetApprovalRequestQueryDto {
  @ApiPropertyOptional({
    enum: ['commands'],
    description: 'Sertakan riwayat command ke Core (untuk pemeriksaan manual)',
  })
  @IsOptional()
  @IsIn(['commands'])
  include?: 'commands';
}

export class UpsertWhatsAppIdentityDto {
  @ApiProperty({ description: 'Nomor WhatsApp / JID', example: '6281234567890' })
  @ToStrictString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(191)
  externalIdentity!: string;

  @ApiProperty({ description: 'UUID user Core', format: 'uuid' })
  @IsUUID()
  corePersonId!: string;

  @ApiPropertyOptional({ description: 'Nama tampilan', maxLength: 191 })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxLength(191)
  displayName?: string;

  /**
   * Tidak punya default `true`. Connect tidak memiliki proses pembuktian kepemilikan nomor, jadi
   * nilai `true` di sini adalah pernyataan operator yang dicatat pada audit — bukan bukti, dan
   * bukan sesuatu yang boleh terjadi hanya karena endpoint dipanggil.
   */
  @ApiPropertyOptional({ description: 'Tandai sudah diverifikasi operator (tanpa default)', default: false })
  @IsOptional()
  @ToStrictBoolean()
  @IsBoolean()
  isVerified?: boolean;

  /** Pencabutan akses tanpa menghapus riwayat pemetaan; Core hanya memakai baris yang aktif. */
  @ApiPropertyOptional({ description: 'Pemetaan masih berlaku', default: true })
  @IsOptional()
  @ToStrictBoolean()
  @IsBoolean()
  isActive?: boolean;

  /** Wajib `true` bila nomor dipindahkan ke personel Core lain; tanpa ini permintaan ditolak 409. */
  @ApiPropertyOptional({ description: 'Setujui pemindahan nomor ke personel Core lain', default: false })
  @IsOptional()
  @ToStrictBoolean()
  @IsBoolean()
  reassign?: boolean;
}
