import { Injectable } from '@nestjs/common';
import { createLogger } from '../../common/services/logger.service';
import { MessageService } from '../message/message.service';
import { ApprovalRequest } from './entities/approval-request.entity';
import { ApprovalNotificationService } from './approval-notification.service';

/**
 * WhatsApp Confirmation Handler.
 *
 * Semua pesan konfirmasi dikirim dari sini. Konfirmasi persetujuan HANYA
 * dikirim setelah Core mengonfirmasi sukses; kegagalan/timeout tidak pernah
 * menghasilkan pesan "disetujui".
 */
@Injectable()
export class ApprovalConfirmationService {
  private readonly logger = createLogger(ApprovalConfirmationService.name);

  constructor(
    private readonly messages: MessageService,
    private readonly notification: ApprovalNotificationService,
  ) {}

  async approved(
    request: ApprovalRequest,
    durationDays: number | null,
    expectedReturnAt: string | null,
  ): Promise<void> {
    const duration = durationDays ? `${durationDays} hari` : 'sesuai permohonan';
    const returned = expectedReturnAt
      ? new Date(expectedReturnAt).toISOString().slice(0, 16).replace('T', ' ')
      : (request.expectedReturnAt?.toISOString().slice(0, 16).replace('T', ' ') ?? '-');

    await this.send(
      request,
      [
        `Izin ${request.reference} *DISETUJUI* oleh ALIM Core.`,
        `Durasi: ${duration}`,
        `Perkiraan kembali: ${returned}`,
        '',
        'Terima kasih.',
      ].join('\n'),
    );
  }

  async rejected(request: ApprovalRequest): Promise<void> {
    await this.send(request, `Izin ${request.reference} telah *DITOLAK* di ALIM Core.`);
  }

  async clarification(
    request: ApprovalRequest,
    reason: 'missing_duration' | 'ambiguous' | 'open_multiple',
  ): Promise<void> {
    const text =
      reason === 'missing_duration'
        ? [
            `Balasan untuk ${request.reference} belum menyebutkan durasi.`,
            '',
            'Silakan balas dengan format:',
            `SETUJU <jumlah hari> HARI ${request.reference}`,
          ].join('\n')
        : reason === 'open_multiple'
          ? 'Ada lebih dari satu permohonan terbuka untuk nomor ini. Sertakan referensi izin pada balasan Anda.'
          : `Balasan tidak dapat dipastikan untuk ${request.reference}. Sertakan referensi izin dan keputusan yang jelas.`;

    await this.send(request, text);
  }

  async alreadyDecided(request: ApprovalRequest): Promise<void> {
    await this.send(
      request,
      `Izin ${request.reference} sudah diputuskan (status: ${request.coreStatus ?? request.status}). Perubahan tidak dapat dilakukan lewat WhatsApp.`,
    );
  }

  async expired(request: ApprovalRequest): Promise<void> {
    await this.send(
      request,
      `Izin ${request.reference} sudah kedaluwarsa di ALIM Core dan tidak dapat diputuskan lewat WhatsApp.`,
    );
  }

  async cancelled(request: ApprovalRequest): Promise<void> {
    await this.send(
      request,
      `Izin ${request.reference} sudah dibatalkan di ALIM Core dan tidak dapat diputuskan lewat WhatsApp.`,
    );
  }

  async notAuthorized(request: ApprovalRequest): Promise<void> {
    await this.send(
      request,
      `Nomor ini tidak tercatat sebagai Kepala Asrama yang berwenang untuk izin ${request.reference}.`,
    );
  }

  async coreRejected(request: ApprovalRequest, reason: string): Promise<void> {
    await this.send(request, `ALIM Core menolak keputusan untuk ${request.reference}: ${reason}`);
  }

  async invalidDuration(request: ApprovalRequest, value: number | null): Promise<void> {
    const shown = value === null ? 'tidak dikenali' : String(value);

    await this.send(
      request,
      `Durasi "${shown}" tidak valid untuk ${request.reference}. Balas dengan jumlah hari antara 1 dan 365, contoh: SETUJU 2 HARI ${request.reference}.`,
    );
  }

  async coreUnavailable(request: ApprovalRequest): Promise<void> {
    await this.send(
      request,
      `Keputusan untuk ${request.reference} belum dapat dipastikan karena ALIM Core tidak merespons. Mohon tunggu; jangan mengirim keputusan baru.`,
    );
  }

  async notFound(sessionId: string | null, chatId: string | null, reference: string | null): Promise<void> {
    await this.sendTo(
      sessionId,
      chatId,
      reference
        ? `Permohonan dengan referensi ${reference} tidak ditemukan atau bukan untuk nomor ini.`
        : 'Permohonan izin tidak dapat dikaitkan dengan balasan ini. Sertakan referensi izin.',
    );
  }

  async unknownSender(sessionId: string | null, chatId: string | null): Promise<void> {
    // Tidak membocorkan detail izin apa pun ke nomor tak dikenal.
    await this.sendTo(sessionId, chatId, 'Nomor ini belum terdaftar pada layanan persetujuan ALIM.');
  }

  private async send(request: ApprovalRequest, text: string): Promise<void> {
    await this.sendTo(request.sessionId, request.targetIdentity, text, request);
  }

  private async sendTo(
    sessionId: string | null | undefined,
    identity: string | null | undefined,
    text: string,
    request: ApprovalRequest | null = null,
  ): Promise<void> {
    if (!sessionId || !identity) {
      this.logger.debug('Konfirmasi dilewati: sesi atau tujuan tidak tersedia.');

      return;
    }

    try {
      await this.messages.sendText(sessionId, {
        chatId: this.notification.toChatId(identity),
        text,
      });
    } catch (error) {
      // Kegagalan mengirim konfirmasi tidak boleh mengubah status keputusan.
      this.logger.warn(`Gagal mengirim konfirmasi${request ? ` untuk ${request.reference}` : ''}: ${String(error)}`);
    }
  }
}
