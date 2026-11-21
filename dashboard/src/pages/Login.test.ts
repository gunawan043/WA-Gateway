// Login page under the bare `node --test` runner, on the jsdom harness the other page tests use. People
// sign in with an email and a password; a machine credential is one toggle away. The key typed at
// sign-in is the one the dashboard stores and compares against its API key prefixes, so it must be
// stored trimmed; a gateway that is down is not reported as an invalid key; and the form's alignment
// must follow the document direction set on <html>.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';

let sentKey: string | null = null;
let sentPath = '';
let sentBody: unknown = null;
let reply: () => Response = okReply;

function okReply(): Response {
  return new Response(JSON.stringify({ valid: true, role: 'admin' }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    sentPath = url.replace(/^https?:\/\/[^/]+/, '');
    sentKey = new Headers(init?.headers).get('X-API-Key');
    try {
      sentBody = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    } catch {
      sentBody = null;
    }
    return Promise.resolve(reply());
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let Login: (typeof import('./Login.tsx'))['Login'];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  (globalThis as Record<string, unknown>).__APP_VERSION__ = '0.0.0-test';
  (globalThis as Record<string, unknown>).__BUILD_TIME__ = '2026-01-01T00:00:00.000Z';
  installFetchStub();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ Login } = await import('./Login.tsx'));
});

afterEach(() => {
  sentKey = null;
  sentPath = '';
  sentBody = null;
  reply = okReply;
  rtl.cleanup();
});

type OnLogin = (typeof import('./Login.tsx'))['Login'] extends (props: infer P) => unknown
  ? P extends { onLogin: infer F }
    ? F
    : never
  : never;

/** Renders the page and moves to the API-key form, which the page no longer opens on. */
async function renderKeyMode(onLogin: OnLogin): Promise<void> {
  const { screen, fireEvent } = rtl;
  rtl.render(createElement(Login, { onLogin }));
  fireEvent.click(screen.getByRole('button', { name: 'Use an API key instead' }));
  await rtl.waitFor(() => assert.ok(screen.getByLabelText('API Key')));
}

// --- Dashboard account (email + password) ---------------------------------

test('the form opens on the email and password side', () => {
  const { screen } = rtl;
  rtl.render(createElement(Login, { onLogin: () => undefined }));
  assert.ok(screen.getByLabelText('Email'));
  assert.ok(screen.getByLabelText('Password'));
  assert.equal(screen.queryByLabelText('API Key'), null);
});

test('a signed-in account hands the token, its role and the account up to the app', async () => {
  const { screen, fireEvent } = rtl;
  const logins: unknown[][] = [];
  reply = () =>
    jsonResponse({
      token: 'owa_s1_abc',
      expiresAt: '2026-12-01T00:00:00.000Z',
      user: { id: 'u1', email: 'ada@example.com', name: 'Ada', role: 'admin', isActive: true },
      role: 'admin',
      scoped: false,
      engineType: 'baileys',
    });
  rtl.render(createElement(Login, { onLogin: (...args: unknown[]) => logins.push(args) }));

  fireEvent.change(screen.getByLabelText('Email'), { target: { value: ' ada@example.com ' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse battery' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

  await rtl.waitFor(() => assert.equal(logins.length, 1));
  assert.deepEqual(logins[0], [
    'owa_s1_abc',
    'admin',
    'baileys',
    false,
    undefined,
    undefined,
    { id: 'u1', email: 'ada@example.com', name: 'Ada' },
  ]);
  assert.equal(sentPath, '/api/auth/login');
  // Signing in must not carry whatever credential the tab already held: the gateway would answer for
  // that actor instead of the one whose password was just typed.
  assert.equal(sentKey, null, 'the sign-in carried a stored credential');
  assert.deepEqual(sentBody, { email: 'ada@example.com', password: 'correct horse battery' });
});

test('a wrong password is announced and tied to the fields, without saying which one was wrong', async () => {
  const { screen, fireEvent } = rtl;
  reply = () => jsonResponse({ statusCode: 401, message: 'Email or password is incorrect' }, 401);
  rtl.render(createElement(Login, { onLogin: () => assert.fail('a refused account signed in') }));

  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ada@example.com' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'nope' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

  const alert = await rtl.waitFor(() => {
    const el = document.querySelector('.error-message');
    assert.ok(el);
    return el;
  });
  assert.equal(alert.textContent, 'Email or password is incorrect');
  const email = screen.getByLabelText('Email');
  assert.equal(email.getAttribute('aria-invalid'), 'true');
  assert.equal(email.getAttribute('aria-describedby'), alert.id);
});

test('a throttled sign-in says to wait instead of blaming the password', async () => {
  const { screen, fireEvent } = rtl;
  reply = () => jsonResponse({ statusCode: 429, message: 'ThrottlerException: Too Many Requests' }, 429);
  rtl.render(createElement(Login, { onLogin: () => assert.fail('a throttled sign-in signed in') }));

  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ada@example.com' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse battery' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

  await rtl.waitFor(() =>
    assert.equal(screen.getByRole('alert').textContent, 'Too many attempts. Try again in a minute.'),
  );
});

test('an empty field is refused before any request', async () => {
  const { screen, fireEvent } = rtl;
  rtl.render(createElement(Login, { onLogin: () => assert.fail('an empty form signed in') }));

  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await rtl.waitFor(() => assert.equal(screen.getByRole('alert').textContent, 'Email is required'));
  assert.equal(sentPath, '');

  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ada@example.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await rtl.waitFor(() => assert.equal(screen.getByRole('alert').textContent, 'Password is required'));
  assert.equal(sentPath, '');
});

test('a 200 without a token is a connection error, not a sign-in', async () => {
  const { screen, fireEvent } = rtl;
  reply = okReply; // the validate shape: no token
  const logins: unknown[] = [];
  rtl.render(createElement(Login, { onLogin: (...args: unknown[]) => logins.push(args) }));

  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ada@example.com' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse battery' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

  await rtl.waitFor(() =>
    assert.equal(screen.getByRole('alert').textContent, 'Unable to connect to server. Please try again.'),
  );
  assert.deepEqual(logins, []);
});

test('switching to the API-key form clears the refusal it no longer describes', async () => {
  const { screen, fireEvent } = rtl;
  rtl.render(createElement(Login, { onLogin: () => undefined }));

  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await rtl.waitFor(() => assert.ok(screen.getByRole('alert')));

  fireEvent.click(screen.getByRole('button', { name: 'Use an API key instead' }));
  await rtl.waitFor(() => assert.ok(screen.getByLabelText('API Key')));
  assert.equal(screen.queryByRole('alert'), null);
  assert.ok(screen.getByRole('button', { name: 'Sign in with email instead' }));
});

test('the account password can be revealed and hidden again', async () => {
  const { screen, fireEvent } = rtl;
  rtl.render(createElement(Login, { onLogin: () => undefined }));
  assert.equal(screen.getByLabelText('Password').getAttribute('type'), 'password');
  fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
  assert.equal(screen.getByLabelText('Password').getAttribute('type'), 'text');
  fireEvent.click(screen.getByRole('button', { name: 'Hide password' }));
  assert.equal(screen.getByLabelText('Password').getAttribute('type'), 'password');
});

// --- Machine credential (API key) -----------------------------------------

test('a key pasted with surrounding whitespace is sent and stored trimmed', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  const logins: string[] = [];
  await renderKeyMode((key: string) => logins.push(key));

  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: '  owa_k1_secret ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

  await waitFor(() => assert.equal(logins.length, 1));
  assert.deepEqual(logins, ['owa_k1_secret']);
  assert.equal(sentKey, 'owa_k1_secret');
  assert.equal(sentPath, '/api/auth/validate');
});

async function submitAndReadError(): Promise<string> {
  const { screen, fireEvent } = rtl;
  await renderKeyMode(() => assert.fail('a refused key signed in'));
  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'owa_k1_secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  const message = await rtl.waitFor(() => {
    const el = document.querySelector('.error-message');
    assert.ok(el);
    return el.textContent ?? '';
  });
  return message;
}

// The only feedback a failed sign-in gives is this message, so it has to reach a screen reader and name the field it
// is about.
test('a refused sign-in is announced and tied to the key field', async () => {
  reply = () => new Response('', { status: 401 });
  await submitAndReadError();
  const alert = rtl.screen.getByRole('alert');
  assert.equal(alert.textContent, 'Invalid API key');
  const input = rtl.screen.getByLabelText('API Key');
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.equal(input.getAttribute('aria-describedby'), alert.id);
});

test('a proxy error page while the gateway is down is a connection error, not an invalid key', async () => {
  reply = () => new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } });
  assert.equal(await submitAndReadError(), 'Unable to connect to server. Please try again.');
});

test('a 5xx with a JSON message is still a connection error', async () => {
  reply = () => new Response(JSON.stringify({ statusCode: 503, message: 'Service Unavailable' }), { status: 503 });
  assert.equal(await submitAndReadError(), 'Unable to connect to server. Please try again.');
});

test('a refused key keeps the reason the gateway gave', async () => {
  reply = () => new Response(JSON.stringify({ statusCode: 401, message: 'API key has expired' }), { status: 401 });
  assert.equal(await submitAndReadError(), 'API key has expired');
});

test('a 401 without a message reads as an invalid key', async () => {
  reply = () => new Response('', { status: 401 });
  assert.equal(await submitAndReadError(), 'Invalid API key');
});

// A 200 that is not the gateway's answer (a reverse proxy serving the app's HTML for a misrouted /api) or that does not
// say the key is valid signed in any typed text as a viewer, and every page then failed its first read.
for (const [label, body] of [
  ['an HTML page', '<!doctype html><title>OpenWA</title>'],
  ['valid: false', JSON.stringify({ valid: false })],
] as const) {
  test(`a 200 carrying ${label} is a connection error, not a sign-in`, async () => {
    const { screen, fireEvent } = rtl;
    reply = () => new Response(body, { status: 200 });
    // Recorded, not thrown: the form's own catch would turn a throw here into the very error this test expects.
    const logins: string[] = [];
    await renderKeyMode((key: string) => logins.push(key));
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'owa_k1_secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await rtl.waitFor(() => assert.ok(logins.length > 0 || document.querySelector('.error-message')));
    assert.deepEqual(logins, [], 'the answer signed the key in');
    assert.equal(screen.getByRole('alert').textContent, 'Unable to connect to server. Please try again.');
  });
}

test('a refusal other than 401 without a message is a connection error, not an invalid key', async () => {
  reply = () => new Response('', { status: 403 });
  assert.equal(await submitAndReadError(), 'Unable to connect to server. Please try again.');
});

test('the login form aligns to the document direction, which is set on <html>', () => {
  const css = readFileSync(fileURLToPath(new URL('./Login.css', import.meta.url)), 'utf8');
  // i18n sets `dir` on the document element only, so a `[dir]` compound after another selector part
  // would need a second element carrying `dir` inside the page and never matches.
  assert.deepEqual(css.match(/[^\s,{}][^,{}]*\s\[dir[^\]]*\][^{]*/g) ?? [], []);
  assert.match(css, /\.login-container \.login-form \{\s*text-align: start;\s*\}/);
});

// The language picker shows the language in use; its name says it picks the language and keeps the shown words.
test('the language picker is named for what it sets and for the language it shows', () => {
  rtl.render(createElement(Login, { onLogin: () => undefined }));
  assert.ok(rtl.screen.getByRole('button', { name: 'Language, English' }));
});
