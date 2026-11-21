// Render tests for the Users page under the bare `node --test` runner. An account is a person who can
// sign in with an email and a password; each owns one linked API key, so the page never mints a key
// here. The gateway enforces the last-admin rule; the page only explains a 409 it receives.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const ada = {
  id: 'u1',
  email: 'ada@example.com',
  name: 'Ada',
  role: 'admin',
  isActive: true,
  apiKeyId: 'k1',
  lastLoginAt: '2026-11-01T10:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const grace = {
  ...ada,
  id: 'u2',
  email: 'grace@example.com',
  name: 'Grace',
  role: 'operator',
  isActive: false,
  apiKeyId: 'k2',
  lastLoginAt: null,
};

let userList: Record<string, unknown>[] = [ada, grace];
let listStatus = 200;
let createStatus = 201;
let updateStatus = 200;
let deleteStatus = 204;
let resetStatus = 204;
let passwordStatus = 204;
const calls: { method: string; path: string; body: Record<string, unknown> | undefined }[] = [];

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const method = init?.method ?? 'GET';
    let body: Record<string, unknown> | undefined;
    try {
      body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    } catch {
      body = undefined;
    }
    calls.push({ method, path, body });

    if (path === '/api/auth/users' && method === 'GET') {
      if (listStatus !== 200)
        return Promise.resolve(jsonResponse({ message: 'This API key cannot access this resource' }, listStatus));
      return Promise.resolve(jsonResponse(userList));
    }
    if (path === '/api/auth/users' && method === 'POST') {
      if (createStatus === 409) return Promise.resolve(jsonResponse({ message: 'Email already in use' }, 409));
      return Promise.resolve(jsonResponse({ ...ada, id: 'u3', email: body?.email }, 201));
    }
    if (/^\/api\/auth\/users\/[^/]+\/reset-password$/.test(path) && method === 'POST') {
      return Promise.resolve(resetStatus === 204 ? new Response(null, { status: 204 }) : jsonResponse({}, resetStatus));
    }
    if (/^\/api\/auth\/users\/[^/]+$/.test(path) && method === 'PATCH') {
      if (updateStatus === 409) return Promise.resolve(jsonResponse({ message: 'This is the last admin' }, 409));
      return Promise.resolve(jsonResponse(ada));
    }
    if (/^\/api\/auth\/users\/[^/]+$/.test(path) && method === 'DELETE') {
      if (deleteStatus === 409) return Promise.resolve(jsonResponse({ message: 'This is the last admin' }, 409));
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (path === '/api/auth/change-password' && method === 'POST') {
      if (passwordStatus === 401)
        return Promise.resolve(jsonResponse({ message: 'Current password is incorrect' }, 401));
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(jsonResponse({ message: `unstubbed ${method} ${path}` }, 404));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let Users: (typeof import('./Users.tsx'))['Users'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  installFetchStub();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ Users } = await import('./Users.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  userList = [ada, grace];
  listStatus = 200;
  createStatus = 201;
  updateStatus = 200;
  deleteStatus = 204;
  resetStatus = 204;
  passwordStatus = 204;
  calls.length = 0;
  window.sessionStorage.clear();
});

async function renderUsers(): Promise<void> {
  rtl.render(createElement(ToastProvider, null, createElement(Users)));
  await rtl.waitFor(() => assert.ok(document.querySelector('.users-table, .users-empty')));
}

const lastCall = (method: string, pattern: RegExp) =>
  [...calls].reverse().find(call => call.method === method && pattern.test(call.path));

test('the table lists each account with its role, status and last sign-in', async () => {
  window.sessionStorage.setItem('openwa_api_key', 'owa_k1_admin');
  await renderUsers();

  const rows = document.querySelectorAll('.users-table tbody tr');
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent ?? '', /Ada/);
  assert.match(rows[0].textContent ?? '', /ada@example\.com/);
  assert.match(rows[1].textContent ?? '', /Inactive/);
  // A never-signed-in account reads as such instead of an empty cell.
  assert.match(rows[1].textContent ?? '', /Never/);
});

test('the caller’s own account is marked You', async () => {
  window.sessionStorage.setItem('openwa_api_key', 'owa_s1_token');
  window.sessionStorage.setItem('openwa_user', JSON.stringify({ id: 'u2', email: 'grace@example.com', name: 'Grace' }));
  await renderUsers();

  const rows = document.querySelectorAll('.users-table tbody tr');
  assert.equal(rows[0].querySelector('.user-you-badge'), null);
  assert.equal(rows[1].querySelector('.user-you-badge')?.textContent, 'You');
});

test('an empty list explains what an account is for', async () => {
  userList = [];
  await renderUsers();
  assert.ok(document.querySelector('.users-empty'));
  assert.match(document.querySelector('.users-empty')?.textContent ?? '', /No users yet/);
});

test('a refused read is reported as a failure, not as an empty list', async () => {
  listStatus = 403;
  await renderUsers();
  const empty = document.querySelector('.users-empty');
  assert.ok(empty);
  assert.match(empty?.textContent ?? '', /Could not load users/);
  assert.doesNotMatch(empty?.textContent ?? '', /No users yet/);
});

test('creating an account sends the trimmed address, the name, the role and the password', async () => {
  await renderUsers();
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Add user' }));

  rtl.fireEvent.change(rtl.screen.getByLabelText('Email'), { target: { value: '  lin@example.com ' } });
  rtl.fireEvent.change(rtl.screen.getByLabelText('Name'), { target: { value: 'Lin' } });
  rtl.fireEvent.change(rtl.screen.getByLabelText('Password'), { target: { value: 'correct horse battery' } });
  rtl.fireEvent.change(rtl.screen.getByLabelText('Confirm password'), {
    target: { value: 'correct horse battery' },
  });
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Create' }));

  await rtl.waitFor(() => assert.ok(lastCall('POST', /^\/api\/auth\/users$/)));
  assert.deepEqual(lastCall('POST', /^\/api\/auth\/users$/)?.body, {
    email: 'lin@example.com',
    name: 'Lin',
    password: 'correct horse battery',
    role: 'operator',
  });
  await rtl.waitFor(() => assert.equal(rtl.screen.queryByRole('dialog'), null));
});

test('a short password or a mismatch keeps the create button disabled', async () => {
  await renderUsers();
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Add user' }));
  const create = () => rtl.screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement;

  rtl.fireEvent.change(rtl.screen.getByLabelText('Email'), { target: { value: 'lin@example.com' } });
  rtl.fireEvent.change(rtl.screen.getByLabelText('Name'), { target: { value: 'Lin' } });
  rtl.fireEvent.change(rtl.screen.getByLabelText('Password'), { target: { value: 'short' } });
  rtl.fireEvent.change(rtl.screen.getByLabelText('Confirm password'), { target: { value: 'short' } });
  assert.equal(create().disabled, true, 'an eleven-character password was accepted');

  rtl.fireEvent.change(rtl.screen.getByLabelText('Password'), { target: { value: 'correct horse battery' } });
  assert.equal(create().disabled, true, 'a mismatched confirmation was accepted');
  assert.equal(rtl.screen.getByRole('alert').textContent, 'The passwords do not match');

  rtl.fireEvent.change(rtl.screen.getByLabelText('Confirm password'), {
    target: { value: 'correct horse battery' },
  });
  assert.equal(create().disabled, false);
});

test('a taken address is named instead of echoing the server message', async () => {
  createStatus = 409;
  await renderUsers();
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Add user' }));
  rtl.fireEvent.change(rtl.screen.getByLabelText('Email'), { target: { value: 'ada@example.com' } });
  rtl.fireEvent.change(rtl.screen.getByLabelText('Name'), { target: { value: 'Ada Two' } });
  rtl.fireEvent.change(rtl.screen.getByLabelText('Password'), { target: { value: 'correct horse battery' } });
  rtl.fireEvent.change(rtl.screen.getByLabelText('Confirm password'), {
    target: { value: 'correct horse battery' },
  });
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Create' }));

  await rtl.waitFor(() => assert.ok(document.querySelector('.user-dialog-error')));
  assert.equal(document.querySelector('.user-dialog-error')?.textContent, 'This email is already in use');
});

test('editing sends the name, role and active flag, and never the address', async () => {
  await renderUsers();
  rtl.fireEvent.click(rtl.screen.getAllByRole('button', { name: 'Edit user' })[0]);

  const email = rtl.screen.getByLabelText('Email') as HTMLInputElement;
  assert.equal(email.disabled, true, 'the address is editable');

  rtl.fireEvent.change(rtl.screen.getByLabelText('Name'), { target: { value: 'Ada Hopper' } });
  rtl.fireEvent.change(rtl.screen.getByLabelText('Role'), { target: { value: 'viewer' } });
  rtl.fireEvent.click(rtl.screen.getByLabelText('Active')); // uncheck
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Save' }));

  await rtl.waitFor(() => assert.ok(lastCall('PATCH', /^\/api\/auth\/users\/u1$/)));
  assert.deepEqual(lastCall('PATCH', /^\/api\/auth\/users\/u1$/)?.body, {
    name: 'Ada Hopper',
    role: 'viewer',
    isActive: false,
  });
});

test('a last-admin refusal explains itself on an edit', async () => {
  updateStatus = 409;
  await renderUsers();
  rtl.fireEvent.click(rtl.screen.getAllByRole('button', { name: 'Edit user' })[0]);
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Save' }));

  await rtl.waitFor(() => assert.ok(document.querySelector('.user-dialog-error')));
  assert.match(document.querySelector('.user-dialog-error')?.textContent ?? '', /last admin/i);
});

test('resetting a password sends the new one and says it ends every session', async () => {
  await renderUsers();
  rtl.fireEvent.click(rtl.screen.getAllByRole('button', { name: 'Reset password' })[0]);
  assert.match(rtl.screen.getByRole('dialog').textContent ?? '', /Every session of this account ends/);

  rtl.fireEvent.change(rtl.screen.getByLabelText('New password'), { target: { value: 'correct horse battery' } });
  rtl.fireEvent.change(rtl.screen.getByLabelText('Confirm password'), {
    target: { value: 'correct horse battery' },
  });
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Save' }));

  await rtl.waitFor(() => assert.ok(lastCall('POST', /^\/api\/auth\/users\/u1\/reset-password$/)));
  assert.deepEqual(lastCall('POST', /^\/api\/auth\/users\/u1\/reset-password$/)?.body, {
    password: 'correct horse battery',
  });
});

test('deleting asks first, then removes the account', async () => {
  await renderUsers();
  rtl.fireEvent.click(rtl.screen.getAllByRole('button', { name: 'Delete user' })[1]);
  assert.match(rtl.screen.getByRole('dialog').textContent ?? '', /grace@example\.com/);

  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Delete' }));
  await rtl.waitFor(() => assert.ok(lastCall('DELETE', /^\/api\/auth\/users\/u2$/)));
});

test('the caller’s own account cannot be deleted from here', async () => {
  window.sessionStorage.setItem('openwa_api_key', 'owa_s1_token');
  window.sessionStorage.setItem('openwa_user', JSON.stringify({ id: 'u1', email: 'ada@example.com', name: 'Ada' }));
  await renderUsers();
  rtl.fireEvent.click(rtl.screen.getAllByRole('button', { name: 'Delete user' })[0]);

  const dialog = rtl.screen.getByRole('dialog');
  assert.match(dialog.textContent ?? '', /This is your own account/);
  assert.equal((rtl.within(dialog).getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled, true);
  assert.equal(lastCall('DELETE', /^\/api\/auth\/users\//), undefined);
});

test('changing your own password is offered only to an email sign-in', async () => {
  window.sessionStorage.setItem('openwa_api_key', 'owa_k1_admin');
  await renderUsers();
  assert.equal(rtl.screen.queryByRole('button', { name: 'Change my password' }), null);
  rtl.cleanup();

  window.sessionStorage.setItem('openwa_api_key', 'owa_s1_token');
  await renderUsers();
  assert.ok(rtl.screen.getByRole('button', { name: 'Change my password' }));
});

test('changing your own password sends the current one and the new one', async () => {
  window.sessionStorage.setItem('openwa_api_key', 'owa_s1_token');
  await renderUsers();
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Change my password' }));

  rtl.fireEvent.change(rtl.screen.getByLabelText('Current password'), { target: { value: 'old password here' } });
  rtl.fireEvent.change(rtl.screen.getByLabelText('New password'), { target: { value: 'correct horse battery' } });
  rtl.fireEvent.change(rtl.screen.getByLabelText('Confirm password'), {
    target: { value: 'correct horse battery' },
  });
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Save' }));

  await rtl.waitFor(() => assert.ok(lastCall('POST', /^\/api\/auth\/change-password$/)));
  assert.deepEqual(lastCall('POST', /^\/api\/auth\/change-password$/)?.body, {
    currentPassword: 'old password here',
    newPassword: 'correct horse battery',
  });
});

test('a wrong current password is reported as such, not as a server failure', async () => {
  passwordStatus = 401;
  window.sessionStorage.setItem('openwa_api_key', 'owa_s1_token');
  await renderUsers();
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Change my password' }));
  rtl.fireEvent.change(rtl.screen.getByLabelText('Current password'), { target: { value: 'wrong password' } });
  rtl.fireEvent.change(rtl.screen.getByLabelText('New password'), { target: { value: 'correct horse battery' } });
  rtl.fireEvent.change(rtl.screen.getByLabelText('Confirm password'), {
    target: { value: 'correct horse battery' },
  });
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Save' }));

  await rtl.waitFor(() => assert.ok(document.querySelector('.user-dialog-error')));
  assert.equal(document.querySelector('.user-dialog-error')?.textContent, 'Current password is incorrect');
  // The credential is still good: a typo in one field must not end the session.
  assert.equal(window.sessionStorage.getItem('openwa_api_key'), 'owa_s1_token');
});
