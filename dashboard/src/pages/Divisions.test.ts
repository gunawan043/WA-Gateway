// Render test for the Divisions page (division routing) under the bare `node --test` runner.
// Harness mirrors ApiKeys.test.ts: jsdom globals, a fetch stub that records the writes, the real
// i18n bundle, and QueryClientProvider + ToastProvider around the page.
//
// What these tests protect: the page is configuration only (the routing happens on the inbound
// path and lands in the Inbox), so every assertion here is about what an operator sees and what
// the page sends — the menu order, the keyword chips, which CS is attached, and the exact body of
// each write. A failed load must read as an error rather than as "no divisions", because an empty
// menu on a live number is a routing outage, not a blank slate.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Division, DivisionSettings, Session } from '../services/api';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const SMP: Division = {
  id: 'div-smp',
  sessionId: 'sess-1',
  name: 'SMP Putra',
  keywords: ['smp', 'smp putra'],
  menuLabel: 'SMP Putra (1)',
  welcomeText: null,
  sortOrder: 1,
  slaMinutes: 15,
  isActive: true,
  agents: [
    { apiKeyId: 'key-1', name: 'Rina' },
    { apiKeyId: 'key-2', name: 'Budi' },
  ],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const SMA: Division = {
  id: 'div-sma',
  sessionId: 'sess-1',
  name: 'SMA Putri',
  keywords: [],
  menuLabel: null,
  welcomeText: 'Halo, CS SMA Putri di sini.',
  sortOrder: 2,
  slaMinutes: 0,
  isActive: false,
  agents: [],
  createdAt: '2026-01-02T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

const SETTINGS: DivisionSettings = {
  sessionId: 'sess-1',
  enabled: true,
  menuHeader: 'Silakan pilih divisi:',
  invalidReply: null,
  idleHours: 24,
};

const SESSIONS = [
  { id: 'sess-1', name: 'Nomor Pusat', status: 'ready' },
  { id: 'sess-2', name: 'Nomor Cadangan', status: 'created' },
] as unknown as Session[];

const AGENTS = [
  { id: 'key-1', name: 'Rina', role: 'operator', keyPrefix: 'owa_k1' },
  { id: 'key-2', name: 'Budi', role: 'operator', keyPrefix: 'owa_k2' },
];

// ── Fetch stub ───────────────────────────────────────────────────────────────

let sessions: Session[] = SESSIONS;
let divisions: Division[] = [SMP, SMA];
let settings: DivisionSettings = SETTINGS;
let divisionsStatus = 200;

let createBody: Record<string, unknown> | undefined;
let createPath: string | undefined;
let patchBodies: { path: string; body: Record<string, unknown> }[] = [];
let deletePaths: string[] = [];
const listPaths: string[] = [];

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api/, '');
    const method = init?.method ?? 'GET';

    if (path === '/sessions' && method === 'GET') return Promise.resolve(jsonResponse(sessions));
    if (path === '/auth/agents' && method === 'GET') return Promise.resolve(jsonResponse(AGENTS));

    // /divisions/settings must be matched before /divisions/:divisionId — 'settings' would
    // otherwise be read as a division id.
    if (/^\/sessions\/[^/]+\/divisions\/settings$/.test(path)) {
      if (method === 'PATCH') {
        patchBodies.push({ path, body: JSON.parse(String(init?.body)) });
        return Promise.resolve(jsonResponse({ ...settings, ...JSON.parse(String(init?.body)) }));
      }
      return Promise.resolve(jsonResponse(settings));
    }

    if (/^\/sessions\/[^/]+\/divisions$/.test(path)) {
      if (method === 'POST') {
        createPath = path;
        createBody = JSON.parse(String(init?.body));
        return Promise.resolve(jsonResponse({ ...SMP, id: 'div-new', ...createBody }, 201));
      }
      listPaths.push(path);
      if (divisionsStatus !== 200) {
        return Promise.resolve(jsonResponse({ message: 'Could not read divisions' }, divisionsStatus));
      }
      return Promise.resolve(jsonResponse(divisions));
    }

    if (/^\/sessions\/[^/]+\/divisions\/[^/]+$/.test(path)) {
      if (method === 'DELETE') {
        deletePaths.push(path);
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (method === 'PATCH') {
        const body = JSON.parse(String(init?.body));
        patchBodies.push({ path, body });
        return Promise.resolve(jsonResponse({ ...SMP, ...body }));
      }
    }

    return Promise.resolve(jsonResponse({ message: `unstubbed ${method} ${path}` }, 404));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let Divisions: (typeof import('./Divisions.tsx'))['Divisions'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let queryClient: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  installFetchStub();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ Divisions } = await import('./Divisions.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
  sessions = SESSIONS;
  divisions = [SMP, SMA];
  settings = SETTINGS;
  divisionsStatus = 200;
  createBody = undefined;
  createPath = undefined;
  patchBodies = [];
  deletePaths = [];
  listPaths.length = 0;
});

function renderPage(): void {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ToastProvider, null, createElement(Divisions)),
    ),
  );
}

/**
 * The top-level division rows only: keyword chips are <li> too, so a bare listitem query would
 * mix them in. A row is the listitem that carries the .divisions-body block.
 */
function divisionRows(): HTMLElement[] {
  return rtl.screen.getAllByRole('listitem').filter(item => item.querySelector('.divisions-body') !== null);
}

function rowFor(name: string): HTMLElement {
  const row = divisionRows().find(item => item.querySelector('strong')?.textContent === name);
  assert.ok(row, `no row for ${name}`);
  return row;
}

// ── Listing ──────────────────────────────────────────────────────────────────

test('the list shows the menu order, the menu label, the keyword chips and the CS names', async () => {
  const { screen, within } = rtl;
  renderPage();

  await screen.findByText('SMP Putra');

  const smp = rowFor('SMP Putra');
  assert.equal(within(smp).getByText('1').className, 'divisions-index', 'the menu position is the row index');
  assert.equal(within(smp).getByText('SMP Putra (1)').className, 'divisions-menu-label');
  assert.deepEqual(
    within(smp)
      .getAllByRole('listitem')
      .map(item => item.textContent),
    ['smp', 'smp putra'],
    'each keyword is a chip of its own',
  );
  assert.equal(within(smp).getByText('Rina, Budi').className, 'divisions-agents');

  // A division with no menuLabel falls back to its name, so the menu never shows a blank line.
  const sma = rowFor('SMA Putri');
  assert.equal(sma.querySelector('.divisions-menu-label')?.textContent, 'SMA Putri');
  assert.equal(within(sma).getByText('No CS assigned').className, 'divisions-agents');
  assert.ok(within(sma).getByText('Inactive'), 'an inactive division is badged');
  assert.ok(sma.classList.contains('is-inactive'));
});

test('the page reads the session chosen first — the ready one — not just the first listed', async () => {
  const { screen } = rtl;
  sessions = [
    { id: 'sess-2', name: 'Nomor Cadangan', status: 'created' },
    { id: 'sess-1', name: 'Nomor Pusat', status: 'ready' },
  ] as unknown as Session[];
  renderPage();

  await screen.findByText('SMP Putra');
  assert.ok(listPaths.includes('/sessions/sess-1/divisions'), `read ${listPaths.join(', ')}`);
  assert.ok(!listPaths.includes('/sessions/sess-2/divisions'));
});

test('switching the session loads that session’s divisions', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  renderPage();
  await screen.findByText('SMP Putra');

  const picker = screen.getByLabelText('Session');
  fireEvent.change(picker, { target: { value: 'sess-2' } });

  await waitFor(() => assert.ok(listPaths.includes('/sessions/sess-2/divisions'), `read ${listPaths.join(', ')}`));
});

test('an empty list invites creating the first division', async () => {
  const { screen } = rtl;
  divisions = [];
  renderPage();

  await screen.findByText('No divisions yet. Create one so customers can reach the right team.');
  assert.equal(screen.queryByRole('button', { name: 'Edit' }), null);
});

test('a failed load is an error, not an empty menu', async () => {
  const { screen } = rtl;
  divisionsStatus = 500;
  renderPage();

  await screen.findByText('Could not load the divisions.');
  assert.equal(
    screen.queryByText('No divisions yet. Create one so customers can reach the right team.'),
    null,
    'a read failure must not read as a gateway with no divisions',
  );
});

test('with no sessions at all the page asks for one instead of rendering an empty menu', async () => {
  const { screen } = rtl;
  sessions = [];
  renderPage();

  await screen.findByText('Select a session to configure its divisions.');
  assert.equal(screen.queryByRole('button', { name: 'New division' }), null);
  assert.equal(listPaths.length, 0, 'no divisions are read without a session');
});

// ── Writes ───────────────────────────────────────────────────────────────────

test('creating a division trims the keywords, sends blanks as null, and posts to the chosen session', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  renderPage();
  await screen.findByText('SMP Putra');

  fireEvent.click(screen.getByRole('button', { name: 'New division' }));
  const dialog = await screen.findByRole('dialog');

  const save = within(dialog).getByRole('button', { name: 'Save' });
  assert.equal((save as HTMLButtonElement).disabled, true, 'a division needs a name');

  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: '  CS SMP Putra  ' } });
  fireEvent.change(within(dialog).getByLabelText('Keywords'), { target: { value: ' smp , , putra ' } });
  fireEvent.change(within(dialog).getByLabelText('Menu position'), { target: { value: '3' } });
  fireEvent.change(within(dialog).getByLabelText('First response target (minutes)'), { target: { value: '15' } });
  fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Rina' }));
  fireEvent.click(save);

  await waitFor(() => assert.ok(createBody, 'no create was sent'));
  assert.equal(createPath, '/sessions/sess-1/divisions');
  assert.deepEqual(createBody, {
    name: 'CS SMP Putra',
    keywords: ['smp', 'putra'],
    menuLabel: null,
    welcomeText: null,
    sortOrder: 3,
    slaMinutes: 15,
    isActive: true,
    agentKeyIds: ['key-1'],
  });
});

test('editing pre-fills the form and patches only that division', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  renderPage();
  await screen.findByText('SMP Putra');

  const smp = rowFor('SMP Putra');
  fireEvent.click(within(smp).getByRole('button', { name: 'Edit' }));

  const dialog = await screen.findByRole('dialog');
  assert.equal((within(dialog).getByLabelText('Name') as HTMLInputElement).value, 'SMP Putra');
  assert.equal((within(dialog).getByLabelText('Menu label') as HTMLInputElement).value, 'SMP Putra (1)');
  assert.equal((within(dialog).getByLabelText('Keywords') as HTMLInputElement).value, 'smp, smp putra');
  assert.equal((within(dialog).getByLabelText('Menu position') as HTMLInputElement).value, '1');
  assert.equal((within(dialog).getByLabelText('First response target (minutes)') as HTMLInputElement).value, '15');
  assert.equal((within(dialog).getByRole('checkbox', { name: 'Rina' }) as HTMLInputElement).checked, true);
  assert.equal((within(dialog).getByRole('checkbox', { name: 'Budi' }) as HTMLInputElement).checked, true);

  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'SMP Putra Boarding' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

  await waitFor(() => assert.equal(patchBodies.length, 1, 'no update was sent'));
  assert.equal(patchBodies[0].path, '/sessions/sess-1/divisions/div-smp');
  assert.equal(patchBodies[0].body.name, 'SMP Putra Boarding');
  assert.deepEqual(patchBodies[0].body.agentKeyIds, ['key-1', 'key-2'], 'untouched agents stay attached');
});

test('deleting asks first, then deletes that division', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  renderPage();
  await screen.findByText('SMP Putra');

  const smp = rowFor('SMP Putra');
  fireEvent.click(within(smp).getByRole('button', { name: 'Delete' }));

  const dialog = await screen.findByRole('dialog');
  assert.ok(
    within(dialog).getByText(/Delete SMP Putra\?/),
    'the confirmation names the division and says the CS stays attached',
  );
  assert.equal(deletePaths.length, 0, 'nothing is deleted before the confirmation');

  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
  await waitFor(() => assert.deepEqual(deletePaths, ['/sessions/sess-1/divisions/div-smp']));
});

test('the settings form hydrates from the server and saves the edited values', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  renderPage();
  await screen.findByText('SMP Putra');

  const panel = screen.getByRole('region', { name: 'Routing settings' });
  await waitFor(() =>
    assert.equal((within(panel).getByLabelText('Menu header') as HTMLTextAreaElement).value, 'Silakan pilih divisi:'),
  );
  assert.equal((within(panel).getByLabelText('Idle hours before the menu returns') as HTMLInputElement).value, '24');

  fireEvent.change(within(panel).getByLabelText('Idle hours before the menu returns'), { target: { value: '48' } });
  fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));

  await waitFor(() => assert.equal(patchBodies.length, 1, 'no settings save was sent'));
  assert.equal(patchBodies[0].path, '/sessions/sess-1/divisions/settings');
  assert.deepEqual(patchBodies[0].body, {
    enabled: true,
    menuHeader: 'Silakan pilih divisi:',
    invalidReply: null,
    idleHours: 48,
  });
});
