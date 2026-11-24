import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createLogger } from '../../common/services/logger.service';
import { HookManager } from '../../core/hooks/hook-manager.service';
import type { HookContext } from '../../core/hooks/hook.interfaces';
import { ApprovalInboundContext, ApprovalProcessorService } from './approval-processor.service';

interface InboundPayload {
  id?: string;
  from?: string;
  chatId?: string;
  body?: string;
  isGroup?: boolean;
  fromMe?: boolean;
  quotedMessage?: { id?: string; body?: string } | null;
}

/** One outbound message, as `message:sent` was about to hand it to the session's own record. */
interface SentPayload {
  id?: string;
  chatId?: string;
  body?: string;
}

/**
 * Menyambungkan balasan WhatsApp ke Approval Processor lewat event
 * `message:received` yang sudah ada. Tidak ada provider WhatsApp baru.
 *
 * Selain itu, hook ini mendengar `message:sent` untuk mengingat pesan keluar yang dikirim
 * Processor sendiri (notifikasi dan pengingat). Balasan berbentuk "SETUJU 2 HARI" tanpa referensi
 * hanya bisa dikaitkan ke permohonan lewat reply-to, dan reply-to yang dikutip WhatsApp adalah id
 * pesan NOTIFIKASI — bukan id permohonan. Tanpa ingatan ini `notificationMessageId` tidak pernah
 * terisi dan setiap balasan seperti itu berakhir `not_found`: balasan tidak pernah menjadi command.
 * Processor hanya menautkan pesan yang memuat baris referensi permohonan yang masih terbuka,
 * sehingga obrolan biasa tidak pernah dikaitkan.
 */
@Injectable()
export class ApprovalInboundHook implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger(ApprovalInboundHook.name);
  private hookId: string | null = null;
  private sentHookId: string | null = null;

  constructor(
    private readonly hooks: HookManager,
    private readonly processor: ApprovalProcessorService,
  ) {}

  onModuleInit(): void {
    // Idempoten: init ganda (mis. hot reload) tidak boleh meninggalkan listener kedua
    // yang tidak pernah dilepas.
    if (this.hookId !== null) {
      return;
    }

    this.hookId = this.hooks.register(
      'approval',
      'message:received',
      async (ctx: HookContext<unknown>) => {
        try {
          await this.processor.handle(this.toContext(ctx));
        } catch (error) {
          // Kegagalan pemrosesan persetujuan tidak boleh menghentikan jalur
          // pesan masuk atau handler lain.
          this.logger.error(`Gagal memproses balasan persetujuan: ${String(error)}`);
        }

        return { continue: true };
      },
      50,
    );

    // Runs BEFORE the chain's own observers (priority 0) so the link is written before the message
    // row is committed: a reply that arrives in the same turn then finds it. Returning no `data`
    // leaves the payload untouched.
    this.sentHookId = this.hooks.register(
      'approval',
      'message:sent',
      async (ctx: HookContext<unknown>) => {
        try {
          await this.rememberNotification(ctx);
        } catch (error) {
          this.logger.error(`Gagal mengingat pesan notifikasi persetujuan: ${String(error)}`);
        }

        return { continue: true };
      },
      0,
    );
  }

  onModuleDestroy(): void {
    for (const id of [this.hookId, this.sentHookId]) {
      if (id) {
        this.hooks.unregister(id);
      }
    }

    this.hookId = null;
    this.sentHookId = null;
  }

  /**
   * Ingat id pesan keluar yang baru saja dikirim. Teks dan chatnya diteruskan apa adanya: yang
   * memutuskan apakah pesan ini notifikasi sebuah permohonan adalah Processor, karena hanya ia yang
   * tahu permohonan terbuka mana yang teksnya memuat baris referensi itu.
   */
  private async rememberNotification(ctx: HookContext<unknown>): Promise<void> {
    const data = (ctx.data ?? {}) as SentPayload;
    const messageId = (data.id ?? '').trim();
    const sessionId = ctx.sessionId ?? null;

    if (messageId === '' || !sessionId) {
      return;
    }

    await this.processor.recordNotification(sessionId, messageId, (data.body ?? '').trim(), (data.chatId ?? '').trim());
  }

  private toContext(ctx: HookContext<unknown>): ApprovalInboundContext {
    const data = (ctx.data ?? {}) as InboundPayload;
    const senderIdentity = data.from ?? data.chatId ?? '';

    return {
      sessionId: ctx.sessionId ?? null,
      externalMessageId: data.id ?? '',
      chatId: data.chatId ?? senderIdentity,
      senderIdentity,
      body: data.body ?? null,
      quotedMessageId: data.quotedMessage?.id ?? null,
      isGroup: data.isGroup === true,
      fromMe: data.fromMe === true,
    };
  }
}
