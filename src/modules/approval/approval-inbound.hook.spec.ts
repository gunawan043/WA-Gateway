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
  let hooks: HookManager;
  let processor: ApprovalProcessorService;
  let hook: ApprovalInboundHook;

  beforeEach(() => {
    registered = [];
    unregistered = [];
    handle = jest.fn().mockResolvedValue('applied');

    hooks = {
      register: jest.fn((pluginId: string, event: string, handler: Registered['handler'], priority: number) => {
        registered.push({ pluginId, event, handler, priority });
        return `hook-${registered.length}`;
      }),
      unregister: jest.fn((id: string) => unregistered.push(id)),
    } as unknown as HookManager;

    processor = { handle } as unknown as ApprovalProcessorService;
    hook = new ApprovalInboundHook(hooks, processor);
  });

  const context = (data: Record<string, unknown>, sessionId: string | null = 'sess-1'): HookContext<unknown> =>
    ({ sessionId, data }) as unknown as HookContext<unknown>;

  const firstContext = (): ApprovalInboundContext => (handle.mock.calls[0] as unknown[])[0] as ApprovalInboundContext;

  it('mendaftarkan satu handler pada message:received dengan prioritas 50', () => {
    hook.onModuleInit();

    expect(registered).toHaveLength(1);
    expect(registered[0].pluginId).toBe('approval');
    expect(registered[0].event).toBe('message:received');
    expect(registered[0].priority).toBe(50);
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

    expect(registered).toHaveLength(1);
  });

  it('melepas hook saat destroy', () => {
    hook.onModuleInit();
    hook.onModuleDestroy();

    expect(unregistered).toEqual(['hook-1']);
  });

  it('aman dipanggil destroy tanpa init', () => {
    expect(() => hook.onModuleDestroy()).not.toThrow();
    expect(unregistered).toEqual([]);
  });
});
