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

/**
 * Menyambungkan balasan WhatsApp ke Approval Processor lewat event
 * `message:received` yang sudah ada. Tidak ada provider WhatsApp baru.
 */
@Injectable()
export class ApprovalInboundHook implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger(ApprovalInboundHook.name);
  private hookId: string | null = null;

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
  }

  onModuleDestroy(): void {
    if (this.hookId) {
      this.hooks.unregister(this.hookId);
      this.hookId = null;
    }
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
