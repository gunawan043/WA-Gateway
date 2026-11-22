import { ApiProperty } from '@nestjs/swagger';
import type { ApprovalCommand, ApprovalCommandStatus, ApprovalDecision } from '../entities/approval-command.entity';

/**
 * Tampilan command untuk pemeriksaan manual.
 *
 * `coreResponseBody` sengaja tidak diekspos: isinya body mentah dari Core dan dapat memuat data
 * internal yang tidak dibutuhkan operator untuk memutuskan apakah command perlu dikirim ulang.
 * `externalMessageId` juga tidak: ia menunjuk pesan WhatsApp tertentu, sedangkan `commandId` sudah
 * cukup untuk menghubungkan command dengan log dan dengan permohonannya.
 *
 * `lastError` berasal dari dua sumber: pesan tetap milik Connect ("Core tidak merespons tepat
 * waktu.") dan `message` yang dikirim Core pada envelope responsnya. Sumber kedua tidak berada di
 * bawah kendali Connect, jadi nilainya disanitasi sebelum keluar: URL, email, deretan angka panjang
 * (nomor telepon), dan pasangan `kata=kunci` disamarkan, karakter kendali dibuang, dan panjangnya
 * dibatasi. `errorCode` juga dibatasi ke bentuk kode yang wajar.
 */
export class ApprovalCommandView {
  @ApiProperty() id!: string;
  @ApiProperty() commandId!: string;
  @ApiProperty() approvalRequestId!: string;
  @ApiProperty({ enum: ['approved', 'rejected', 'needs_clarification', 'expired', 'cancelled'] })
  decision!: ApprovalDecision;
  @ApiProperty({ nullable: true, type: 'integer' }) durationDays!: number | null;
  @ApiProperty({ enum: ['PENDING', 'SENT', 'APPLIED', 'DUPLICATE', 'REJECTED', 'FAILED', 'UNKNOWN'] })
  status!: ApprovalCommandStatus;
  @ApiProperty() attempts!: number;
  @ApiProperty({ nullable: true, type: 'integer' }) coreResponseCode!: number | null;
  @ApiProperty({ type: String, nullable: true }) errorCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) lastError!: string | null;
  @ApiProperty({ nullable: true, type: 'string', format: 'date-time' }) lastAttemptAt!: Date | null;
  @ApiProperty({ nullable: true, type: 'string', format: 'date-time' }) nextAttemptAt!: Date | null;
  @ApiProperty({ nullable: true, type: 'string', format: 'date-time' }) sentAt!: Date | null;
  @ApiProperty({ nullable: true, type: 'string', format: 'date-time' }) resolvedAt!: Date | null;
  @ApiProperty({ type: 'string', format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ type: 'string', format: 'date-time' }) updatedAt!: Date;
}

/** Batas panjang pesan yang keluar lewat API; kolomnya sendiri menyimpan sampai 500 karakter. */
const MAX_MESSAGE_LENGTH = 200;

/** Batas panjang kode error; kolomnya `varchar(64)`. */
const MAX_CODE_LENGTH = 64;

/**
 * Pesan error yang aman ditampilkan.
 *
 * Bukan pengganti audit: pesan aslinya tetap tersimpan di `approval_commands.lastError` untuk
 * pemeriksaan dengan akses basis data. Yang dibuang di sini adalah hal-hal yang tidak perlu dilihat
 * pembaca API dan berisiko membocorkan sesuatu bila Core mengirim teks bebas.
 */
export function sanitizeCommandMessage(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const compact = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (compact === '') {
    return null;
  }

  const redacted = compact
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
    // Deret 8+ digit menutupi nomor telepon; timestamp ISO tidak punya deret sepanjang itu.
    .replace(/\+?\d{8,}/g, '[number]')
    // `Authorization: Bearer <token>` harus habis seluruhnya; tanpa skema opsional, nilainya
    // tertinggal di belakang `[redacted]`. `Bearer <token>` tanpa nama header juga ditangani.
    .replace(
      /\b(?:authorization|token|api[_-]?key|secret|password)\b\s*[:=]\s*(?:(?:bearer|basic|digest)\s+)?\S+|\bbearer\s+\S+/gi,
      '[redacted]',
    );

  return redacted.length > MAX_MESSAGE_LENGTH ? `${redacted.slice(0, MAX_MESSAGE_LENGTH - 3)}...` : redacted;
}

/** Kode error hanya boleh berbentuk kode: huruf, angka, `_`, `.`, `:` atau `-`. */
export function sanitizeCommandCode(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();

  return /^[A-Za-z0-9_.:-]{1,64}$/.test(trimmed) ? trimmed.slice(0, MAX_CODE_LENGTH) : null;
}

export function toApprovalCommandView(command: ApprovalCommand): ApprovalCommandView {
  return {
    id: command.id,
    commandId: command.commandId,
    approvalRequestId: command.approvalRequestId,
    decision: command.decision,
    durationDays: command.durationDays,
    status: command.status,
    attempts: command.attempts,
    coreResponseCode: command.coreResponseCode,
    errorCode: sanitizeCommandCode(command.errorCode),
    lastError: sanitizeCommandMessage(command.lastError),
    lastAttemptAt: command.lastAttemptAt,
    nextAttemptAt: command.nextAttemptAt,
    sentAt: command.sentAt,
    resolvedAt: command.resolvedAt,
    createdAt: command.createdAt,
    updatedAt: command.updatedAt,
  };
}
