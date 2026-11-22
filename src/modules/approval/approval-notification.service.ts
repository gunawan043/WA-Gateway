import { Injectable } from '@nestjs/common';
import { createLogger } from '../../common/services/logger.service';
import { recordApprovalNotification } from '../../common/metrics/approval-metrics';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MessageService } from '../message/message.service';
import { ApprovalRequest } from './entities/approval-request.entity';
import { WhatsAppIdentityService } from './whatsapp-identity.service';

/**
 * Approval Notification.
 *
 * Menyusun dan mengirim notifikasi WhatsApp ke Kepala Asrama yang dituju.
 * Pesan selalu memuat identitas santri, info izin, durasi yang diminta,
 * referensi unik, dan instruksi balasan yang deterministik.
 */
@Injectable()
export class ApprovalNotificationService {
  private readonly logger = createLogger(ApprovalNotificationService.name);

  constructor(
    @InjectRepository(ApprovalRequest, 'data')
    private readonly requests: Repository<ApprovalRequest>,
    private readonly messages: MessageService,
    private readonly identities: WhatsAppIdentityService,
  ) {}

  buildText(request: ApprovalRequest): string {
    const duration = request.requestedDurationDays ? `${request.requestedDurationDays} hari` : 'tidak disebutkan';
    const departure = request.departureAt ? request.departureAt.toISOString().slice(0, 16).replace('T', ' ') : '-';
    const expectedReturn = request.expectedReturnAt
      ? request.expectedReturnAt.toISOString().slice(0, 16).replace('T', ' ')
      : '-';
    const student = request.studentClass ? `${request.studentName} (${request.studentClass})` : request.studentName;

    return [
      '*Persetujuan Izin Santri*',
      '',
      `Santri: ${student}`,
      `Asrama: ${request.dormitoryName ?? '-'}`,
      `Jenis izin: ${request.permitType}`,
      `Durasi diminta: ${duration}`,
      `Berangkat: ${departure}`,
      `Perkiraan kembali: ${expectedReturn}`,
      `Referensi: ${request.reference}`,
      '',
      'Balas dengan format berikut:',
      `SETUJU <jumlah hari> HARI ${request.reference}`,
      `TOLAK ${request.reference}`,
      '',
      'Balasan tanpa jumlah hari akan diminta klarifikasi.',
    ].join('\n');
  }

  async notify(request: ApprovalRequest): Promise<{ messageId: string | null }> {
    if (!request.sessionId || !request.targetIdentity) {
      this.logger.warn(`Permohonan ${request.reference} belum memiliki sesi atau tujuan; notifikasi dilewati.`);
      recordApprovalNotification('skipped');

      return { messageId: null };
    }

    const text = this.buildText(request);

    let response: { messageId: string };

    try {
      response = await this.messages.sendText(request.sessionId, {
        chatId: this.toChatId(request.targetIdentity),
        text,
      });
    } catch (error) {
      recordApprovalNotification('failed');

      throw error;
    }

    // Counted as sent before persisting: the message has left the gateway, and a failed save must
    // not make the metric claim nothing was delivered.
    recordApprovalNotification('sent');

    request.notificationMessageId = response.messageId;
    request.notificationSentAt = new Date();
    await this.requests.save(request);

    return { messageId: response.messageId };
  }

  toChatId(identity: string): string {
    if (identity.includes('@')) {
      return identity;
    }

    return `${this.identities.normalize(identity)}@c.us`;
  }
}
