import { BaileysAdapter } from './baileys.adapter';
import type { BaileysEventsHost } from './baileys-events';
import type { BaileysSessionStore } from './baileys-session-store';

/**
 * The events delegate judges an edit or delete against the key the chat preview holds and hands that
 * judgement to the session store with the preview change; the adapter's host has to carry it through.
 */
describe('Baileys adapter preview edit wiring', () => {
  // The adapter owns a lifecycle delegate. Disposing it is also what an assertion failure does when
  // it skips past destroy(): a leaked delegate keeps `this` reachable in the worker, and anything it
  // still schedules runs against a module this file no longer controls.
  let adapter: BaileysAdapter;

  afterEach(async () => {
    await adapter?.destroy();
  });

  it('passes the preview check of an edit through to the session store', () => {
    adapter = new BaileysAdapter({ sessionId: 'sess-1', dbSessionId: 'db-uuid-1', authDir: './data/baileys' });
    const { sessionStore: store, events } = adapter as unknown as {
      sessionStore: BaileysSessionStore;
      events: { host: BaileysEventsHost };
    };
    store.recordMessage(
      {
        key: { id: 'M1', remoteJid: '628111@s.whatsapp.net', fromMe: true },
        message: { conversation: 'original' },
        messageTimestamp: 1_700_000_000,
      },
      'text',
    );
    events.host.recordMessageEdit('628111@s.whatsapp.net', 'M1', 'forged', undefined, () => false);
    expect(store.listChats()[0].lastMessage).toBe('original');
    events.host.recordMessageEdit('628111@s.whatsapp.net', 'M1', 'edited', undefined, () => true);
    expect(store.listChats()[0].lastMessage).toBe('edited');
  });
});
