import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Division, InboxReport, Session } from '../services/api';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const SESSIONS = [{ id: 'sess-1', name: 'Nomor Pusat', status: 'ready' }] as unknown as Session[];

const DIVISIONS = [
  { id: 'div-smp', sessionId: 'sess-1', name: 'SMP Putra', keywords: [], slaMinutes: 15 },
  { id: 'div-sma', sessionId: 'sess-1', name: 'SMA Putri', keywords: [], slaMinutes: 0 },
] as unknown as Division[];

const REPORT: InboxReport = {
  from: '2026-10-22T00:00:00.000Z',
  to: '2026-11-21T00:00:00.000Z',
  totals: {
    conversations: 4,
    open: 2,
    resolved: 2,
    unassigned: 1,
    awaitingFirstResponse: 1,
    avgFirstResponseMinutes: 12.5,
    slaEligible: 3,
    slaBreached: 1,
    slaComplianceRate: 0.667,
  },
  byDivision: [
    {
      divisionId: 'div-smp',
      divisionName: 'SMP Putra',
      conversations: 3,
      slaEligible: 2,
      slaBreached: 1,
      avgFirstResponseMinutes: 10,
      slaComplianceRate: 0.5,
    },
    {
      divisionId: null,
      divisionName: null,
      conversations: 1,
      slaEligible: 1,
      slaBreached: 0,
      avgFirstResponseMinutes: 20,
      slaComplianceRate: 1,
    },
  ],
  byAgent: [
    {
      assigneeKeyId: 'key-1',
      assigneeName: 'Rina',
      conversations: 2,
      resolved: 1,
      slaEligible: 1,
      slaBreached: 0,
      avgFirstResponseMinutes: 8,
    },
    {
      assigneeKeyId: null,
      assigneeName: null,
      conversations: 1,
      resolved: 0,
      slaEligible: 1,
      slaBreached: 1,
      avgFirstResponseMinutes: null,
    },
  ],
  daily: [
    { date: '2026-11-20', conversations: 2, slaBreached: 0, avgFirstResponseMinutes: 9 },
    { date: '2026-11-21', conversations: 2, slaBreached: 1, avgFirstResponseMinutes: 16 },
  ],
};

let report: InboxReport = REPORT;
let reportStatus = 200;
let reportMessage = 'nope';
const reportPaths: string[] = [];

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api/, '');
    const method = init?.method ?? 'GET';

    if (path === '/sessions' && method === 'GET') return Promise.resolve(jsonResponse(SESSIONS));
    if (/^\/sessions\/[^/]+\/divisions$/.test(path) && method === 'GET') {
      return Promise.resolve(jsonResponse(DIVISIONS));
    }
    if (/^\/sessions\/[^/]+\/inbox\/reports/.test(path) && method === 'GET') {
      reportPaths.push(path);
      if (reportStatus !== 200) return Promise.resolve(jsonResponse({ message: reportMessage }, reportStatus));
      return Promise.resolve(jsonResponse(report));
    }

    return Promise.resolve(jsonResponse({ message: `unstubbed ${method} ${path}` }, 404));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let Reports: (typeof import('./Reports.tsx'))['Reports'];
let queryClient: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  (globalThis as Record<string, unknown>).ResizeObserver = class {
    private readonly cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
    }
    observe(target: Element): void {
      this.cb([{ target, contentRect: { width: 400, height: 260 } } as ResizeObserverEntry], this as never);
    }
    unobserve(): void {}
    disconnect(): void {}
  };
  installFetchStub();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ Reports } = await import('./Reports.tsx'));
});

afterEach(async () => {
  await rtl.waitFor(() => assert.equal(queryClient?.isFetching() ?? 0, 0));
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
  report = REPORT;
  reportStatus = 200;
  reportMessage = 'nope';
  reportPaths.length = 0;
});

function renderPage(): void {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(createElement(QueryClientProvider, { client: queryClient }, createElement(Reports)));
}

test('the cards, the charts and the agent table read the report', async () => {
  const { screen, within } = rtl;
  renderPage();

  await screen.findByText('Average first response');
  assert.equal(screen.getByText('12.5 min').className, '');
  assert.ok(screen.getByText('66.7%'), 'compliance is the fraction as a percentage');
  assert.ok(screen.getByText('1 awaiting a first reply'));
  assert.ok(screen.getByText('3 measured against a target'));

  // The overdue card turns into an alert; a report with no breach must not.
  assert.ok(screen.getByText('Overdue now').closest('.report-card')?.classList.contains('is-alert'));

  const table = screen.getByRole('table');
  const rina = within(table).getByText('Rina').closest('tr');
  assert.ok(rina, 'the agent row is in the table');
  assert.deepEqual(
    within(rina!)
      .getAllByRole('cell')
      .map(cell => cell.textContent),
    ['Rina', '2', '1', '8 min', '0'],
  );
  const unassigned = within(table).getByText('Unassigned').closest('tr');
  assert.deepEqual(
    within(unassigned!)
      .getAllByRole('cell')
      .map(cell => cell.textContent),
    ['Unassigned', '1', '0', '—', '1'],
    'a conversation with no response shows the empty value, not 0 min',
  );

  assert.ok(screen.getByText('Conversations by division'));
  assert.ok(screen.getByText('Conversations per day'));
});

test('the range and the division filter reach the request', async () => {
  const { screen, fireEvent } = rtl;
  renderPage();

  await screen.findByText('Average first response');
  assert.equal(reportPaths.length, 1);
  assert.match(reportPaths[0], /from=\d{4}-\d{2}-\d{2}T/);
  assert.doesNotMatch(reportPaths[0], /division=/, 'no division filter by default');

  fireEvent.click(screen.getByRole('button', { name: '7 days' }));
  await rtl.waitFor(() => assert.equal(reportPaths.length, 2));
  assert.notEqual(reportPaths[1], reportPaths[0], 'a new period is a new request');

  fireEvent.change(screen.getByLabelText('Division'), { target: { value: 'div-smp' } });
  await rtl.waitFor(() => assert.equal(reportPaths.length, 3));
  assert.match(reportPaths[2], /division=div-smp/);
});

test('a 403 explains that the key cannot read this inbox', async () => {
  const { screen } = rtl;
  reportStatus = 403;
  renderPage();

  await screen.findByText("Your key cannot read this session's inbox.");
});

test('a refused range shows the server message, not an empty page', async () => {
  const { screen } = rtl;
  reportStatus = 400;
  reportMessage = 'This range holds more than 20000 conversations; narrow the dates or pick a division';
  renderPage();

  await screen.findByText(/more than 20000 conversations/);
});

test('an empty period says so instead of drawing empty charts', async () => {
  const { screen } = rtl;
  report = {
    ...REPORT,
    totals: { ...REPORT.totals, conversations: 0, slaEligible: 0, slaBreached: 0, slaComplianceRate: null },
    byDivision: [],
    byAgent: [],
    daily: [],
  };
  renderPage();

  await screen.findByText('No conversations started in this period.');
  assert.equal(screen.queryByRole('table'), null);
});
