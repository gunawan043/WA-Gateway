import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { InboxConversation, Session } from '../services/api';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const SESSIONS = [{ id: 'sess-1', name: 'Nomor Pusat', status: 'ready' }] as unknown as Session[];

const conversation = (overrides: Partial<InboxConversation>): InboxConversation => ({
  chatId: '628111@c.us',
  name: 'Alice',
  isGroup: false,
  kind: 'individual',
  unreadCount: 0,
  timestamp: 1_790_000_000,
  lastMessage: 'halo',
  lastMessageType: 'text',
  archived: false,
  pinned: false,
  status: 'open',
  assigneeKeyId: null,
  assigneeName: null,
  divisionId: 'div-smp',
  divisionName: 'SMP Putra',
  firstInboundAt: '2026-11-21T09:00:00.000Z',
  firstResponseAt: null,
  slaStartedAt: '2026-11-21T09:00:00.000Z',
  slaDueAt: null,
  slaBreachedAt: null,
  slaMinutes: 15,
  resolvedAt: null,
  ...overrides,
});

const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

let conversations: InboxConversation[] = [];

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api/, '');
    const method = init?.method ?? 'GET';

    if (path === '/sessions' && method === 'GET') return Promise.resolve(jsonResponse(SESSIONS));
    if (path === '/auth/agents' && method === 'GET') return Promise.resolve(jsonResponse([]));
    if (/^\/sessions\/[^/]+\/divisions$/.test(path) && method === 'GET') return Promise.resolve(jsonResponse([]));
    if (/^\/sessions\/[^/]+\/inbox\/conversations(\?|$)/.test(path) && method === 'GET') {
      return Promise.resolve(jsonResponse(conversations));
    }

    return Promise.resolve(jsonResponse({ message: `unstubbed ${method} ${path}` }, 404));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let Inbox: (typeof import('./Inbox.tsx'))['Inbox'];
let RoleProvider: (typeof import('../components/RoleProvider.tsx'))['RoleProvider'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let queryClient: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  installFetchStub();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ Inbox } = await import('./Inbox.tsx'));
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
});

afterEach(async () => {
  await rtl.waitFor(() => assert.equal(queryClient?.isFetching() ?? 0, 0));
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
  conversations = [];
});

function renderPage(): HTMLElement {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  return rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Inbox))),
    ),
  ).container;
}

test('a running window shows the minutes left, in amber', async () => {
  conversations = [conversation({ slaDueAt: inMinutes(12) })];
  const { screen } = rtl;
  const container = renderPage();

  await screen.findByText('Alice');
  const badge = container.querySelector('.inbox-sla');
  assert.ok(badge, 'the row carries a badge');
  assert.ok(badge!.classList.contains('is-due'));
  assert.ok(!badge!.classList.contains('is-breached'));
  // 12 minutes from now, rounded up, so the text never says "11 min left" a second later.
  assert.match(badge!.textContent ?? '', /^1[12] min left$/);
});

test('an overdue window shows the breach, in red', async () => {
  conversations = [conversation({ slaDueAt: inMinutes(-5), slaBreachedAt: new Date().toISOString() })];
  const { screen } = rtl;
  const container = renderPage();

  await screen.findByText('Alice');
  const badge = container.querySelector('.inbox-sla');
  assert.ok(badge!.classList.contains('is-breached'));
  assert.equal(badge!.textContent, 'Overdue');
});

test('a deadline that just passed reads as overdue before the sweeper runs', async () => {
  conversations = [conversation({ slaDueAt: inMinutes(-1) })];
  const { screen } = rtl;
  const container = renderPage();

  await screen.findByText('Alice');
  assert.ok(container.querySelector('.inbox-sla')?.classList.contains('is-breached'));
});

test('a conversation with no target shows no badge', async () => {
  conversations = [conversation({ slaDueAt: null, slaMinutes: null })];
  const { screen } = rtl;
  const container = renderPage();

  await screen.findByText('Alice');
  assert.equal(container.querySelector('.inbox-sla'), null);
});
