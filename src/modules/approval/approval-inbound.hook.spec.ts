import { ApprovalInboundHook } from './approval-inbound.hook';
import type { HookContext } from '../../core/hooks/hook.interfaces';
import type { HookManager } from '../../core/hooks/hook-manager.service';
import type { ApprovalInboundContext, ApprovalProcessorService } from './approval-processor.service';

type Registered = {
  pluginId: string;
  event: string;
  handler: (ctx: HookContext<unknown>) => Promise<unknown>;
  priority: number;
};

/**
 * The hook is the only bridge from Baileys' `message:received` event to the processor.
 * It must never break the inbound pipeline (always `continue: true`), must map the payload
 * fields the processor relies on, and must unregister on shutdown so a hot reload does not
 * leave a second listener behind.
 */
describe('ApprovalInboundHook', () => {
  let registered: Registered[];
  let unregistered: string[];
  let handle: jest.Mock;
  let record: jest.Mock;
  let hooks: HookManager;
  let processor: ApprovalProcessorService;
  let hook: ApprovalInboundHook;

  beforeEach(() => {
    registered = [];
    unregistered = [];
    handle = jest.fn().mockResolvedValue('applied');
    record = jest.fn().mockResolvedValue(undefined);

    hooks = {
      register: jest.fn((pluginId: string, event: string, handler: Registered['handler'], priority: number) => {
        registered.push({ pluginId, event, handler, priority });
        return `hook-${registered.length}`;
      }),
      unregister: jest.fn((id: string) => unregistered.push(id)),
    } as unknown as HookManager;

    processor = { handle, recordNotification: record } as unknown as ApprovalProcessorService;
    hook = new ApprovalInboundHook(hooks, processor);
  });

  const context = (data: Record<string, unknown>, sessionId: string | null = 'sess-1'): HookContext<unknown> =>
    ({ sessionId, data }) as unknown as HookContext<unknown>;

  const firstContext = (): ApprovalInboundContext => (handle.mock.calls[0] as unknown[])[0] as ApprovalInboundContext;

  it('mendaftarkan satu handler pada message:received dengan prioritas 50', () => {
    hook.onModuleInit();

    // The second registration is the message:sent listener that records notification ids.
    expect(registered).toHaveLength(2);
    expect(registered[0]).toMatchObject({ pluginId: 'approval', event: 'message:received', priority: 50 });
  });

  it('mendaftarkan listener message:sent paling awal, sebelum pesan itu disimpan', () => {
    hook.onModuleInit();

    const sent = registered.filter(entry => entry.event === 'message:sent');
    expect(sent).toHaveLength(1);
    // Priority 0 runs before the chain's own observers: a reply in the same turn then finds the link.
    expect(sent[0].priority).toBe(0);
  });

  it('memetakan payload WhatsApp ke konteks processor', async () => {
    hook.onModuleInit();

    await registered[0].handler(
      context({
        id: 'wamid.IN',
        from: '628111222333@s.whatsapp.net',
        chatId: '628111222333@c.us',
        body: 'SETUJU 2 HARI IZN-2026-00125',
        isGroup: false,
        fromMe: false,
        quotedMessage: { id: 'wamid.NOTIF' },
      }),
    );

    const ctx = firstContext();
    expect(ctx).toEqual({
      sessionId: 'sess-1',
      externalMessageId: 'wamid.IN',
      chatId: '628111222333@c.us',
      senderIdentity: '628111222333@s.whatsapp.net',
      body: 'SETUJU 2 HARI IZN-2026-00125',
      quotedMessageId: 'wamid.NOTIF',
      isGroup: false,
      fromMe: false,
    });
  });

  it('memakai chatId sebagai identitas bila from tidak ada', async () => {
    hook.onModuleInit();

    await registered[0].handler(context({ id: 'wamid.IN', chatId: '628111222333@c.us', body: 'TOLAK IZN-2026-00125' }));

    const ctx = firstContext();
    expect(ctx.senderIdentity).toBe('628111222333@c.us');
  });

  it('selalu mengembalikan continue:true walau processor melempar', async () => {
    hook.onModuleInit();
    handle.mockRejectedValue(new Error('boom'));

    await expect(registered[0].handler(context({ id: 'wamid.IN' }))).resolves.toEqual({ continue: true });
  });

  it('tidak mendaftar dua kali saat init dipanggil ulang', () => {
    hook.onModuleInit();
    hook.onModuleInit();

    expect(registered).toHaveLength(2);
  });

  it('melepas hook saat destroy', () => {
    hook.onModuleInit();
    hook.onModuleDestroy();

    expect(unregistered).toEqual(['hook-1', 'hook-2']);
  });

  it('aman dipanggil destroy tanpa init', () => {
    expect(() => hook.onModuleDestroy()).not.toThrow();
    expect(unregistered).toEqual([]);
  });

  /**
   * A reply quoting the notification has no reference in its text ("SETUJU 2 HARI"), so the resolver
   * falls back to `notificationMessageId === quotedMessage.id`. Without the second handler that link is
   * never written and every quoted reply reaches `not_found` — the WhatsApp reply produced no approval
   * command, which is the break this pair closes.
   */
  describe('tautan balasan ke pesan notifikasi', () => {
    const notificationId = 'wamid.NOTIF-OUT';
    const reminderId = 'wamid.NOTIF-REMINDER';

    const register = (): void => {
      hook.onModuleInit();
    };

    const sent = (data: Record<string, unknown>): void => {
      const handler = registered.find(entry => entry.event === 'message:sent');

      expect(handler).toBeDefined();
      void handler!.handler(context(data));
    };

    beforeEach(() => {
      register();
    });

    it('memakai id pesan keluar dari event message:sent sebagai tautan balasan', async () => {
      sent({ id: notificationId, chatId: '628111222333@c.us', body: 'SETUJU 2 HARI?' });

      await registered[0].handler(
        context(
          {
            id: 'wamid.IN',
            from: '628111222333@s.whatsapp.net',
            chatId: '628111222333@c.us',
            body: 'SETUJU 2 HARI',
            quotedMessage: { id: notificationId },
          },
          'sess-1',
        ),
      );

      expect(record).toHaveBeenCalledWith('sess-1', notificationId, 'SETUJU 2 HARI?', '628111222333@c.us');
      expect(firstContext().quotedMessageId).toBe(notificationId);
    });

    it('mengikuti pesan pengingat yang terakhir dikirim untuk chat itu', async () => {
      sent({ id: notificationId, chatId: '628111222333@c.us', body: 'SETUJU 2 HARI?' });
      sent({ id: reminderId, chatId: '628111222333@c.us', body: 'Pengingat: SETUJU 2 HARI?' });

      await registered[0].handler(
        context({
          id: 'wamid.IN',
          from: '628111222333@s.whatsapp.net',
          chatId: '628111222333@c.us',
          body: 'TOLAK',
          quotedMessage: { id: reminderId },
        }),
      );

      expect(firstContext().quotedMessageId).toBe(reminderId);
    });

    it('meneruskan teks dan chat pesan keluar apa adanya; yang memutuskan tautan adalah processor', () => {
      // A chat message does not carry the permit's reference line, so recordNotification links nothing
      // and the reply that quotes it resolves to not_found instead of a command.
      sent({ id: 'wamid.CHAT', chatId: '628111222333@c.us', body: 'Halo, ada yang bisa dibantu?' });

      expect(record).toHaveBeenCalledWith('sess-1', 'wamid.CHAT', 'Halo, ada yang bisa dibantu?', '628111222333@c.us');
    });

    it('tidak mengingat pesan keluar tanpa sesi, karena tautannya milik satu sesi', () => {
      const handler = registered.find(entry => entry.event === 'message:sent');
      void handler!.handler(
        context({ id: 'wamid.OUT', chatId: '628111222333@c.us', body: 'Referensi: IZN-2026-00125' }, null),
      );

      expect(record).not.toHaveBeenCalled();
    });

    it('membiarkan balasan ditautkan lewat reply-to saat notifikasi tidak pernah dikirim', async () => {
      // Notification sent before this process started, or by another node: no message:sent was seen.
      await registered[0].handler(
        context({
          id: 'wamid.IN',
          from: '628111222333@s.whatsapp.net',
          chatId: '628111222333@c.us',
          body: 'SETUJU 2 HARI',
          quotedMessage: { id: 'wamid.UNSEEN' },
        }),
      );

      expect(record).not.toHaveBeenCalled();
      expect(firstContext().quotedMessageId).toBe('wamid.UNSEEN');
    });
  });
});
