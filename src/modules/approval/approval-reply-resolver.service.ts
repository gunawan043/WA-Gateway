import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ApprovalRequest } from './entities/approval-request.entity';
import { WhatsAppIdentityService } from './whatsapp-identity.service';

export type ResolutionSource = 'quoted' | 'reference' | 'single_pending' | 'none' | 'ambiguous';

export interface ReplyResolution {
  request: ApprovalRequest | null;
  source: ResolutionSource;
  /** Jumlah permohonan terbuka untuk pengirim ini; dipakai untuk pesan klarifikasi. */
  openCount: number;
}

/**
 * Reply Resolver.
 *
 * Balasan singkat hanya boleh diproses bila dapat dikaitkan secara pasti:
 * reply langsung ke notifikasi, referensi unik di teks, atau tepat satu
 * permohonan terbuka milik pengirim. Selain itu hasilnya `ambiguous`.
 */
@Injectable()
export class ApprovalReplyResolver {
  constructor(
    @InjectRepository(ApprovalRequest, 'data')
    private readonly requests: Repository<ApprovalRequest>,
    private readonly identities: WhatsAppIdentityService,
  ) {}

  async resolve(input: {
    sessionId?: string | null;
    senderIdentity: string;
    quotedMessageId?: string | null;
    reference: string | null;
  }): Promise<ReplyResolution> {
    const targetIdentity = this.identities.normalize(input.senderIdentity);

    if (targetIdentity === '') {
      return { request: null, source: 'none', openCount: 0 };
    }

    const sessionId = input.sessionId ?? null;

    // 1. Reply langsung ke pesan notifikasi Connect: tautan paling kuat.
    if (input.quotedMessageId) {
      const quoted = await this.requests.findOne({
        where: {
          notificationMessageId: input.quotedMessageId,
          targetIdentity,
          ...(sessionId ? { sessionId } : {}),
        },
      });

      if (quoted) {
        return { request: quoted, source: 'quoted', openCount: 1 };
      }
    }

    // 2. Referensi unik di teks.
    if (input.reference) {
      const byReference = await this.requests.findOne({
        where: {
          reference: input.reference,
          targetIdentity,
          ...(sessionId ? { sessionId } : {}),
        },
      });

      if (byReference) {
        return { request: byReference, source: 'reference', openCount: 1 };
      }

      // Referensi disebut tetapi bukan milik pengirim: jangan menebak.
      return { request: null, source: 'none', openCount: 0 };
    }

    // 3. Tepat satu permohonan terbuka untuk pengirim ini.
    const open = await this.requests.find({
      where: {
        targetIdentity,
        status: In(['PENDING_APPROVAL', 'NEEDS_CLARIFICATION']),
        ...(sessionId ? { sessionId } : {}),
      },
      order: { createdAt: 'DESC' },
      take: 5,
    });

    if (open.length === 1) {
      return { request: open[0], source: 'single_pending', openCount: 1 };
    }

    if (open.length === 0) {
      return { request: null, source: 'none', openCount: 0 };
    }

    return { request: null, source: 'ambiguous', openCount: open.length };
  }
}
