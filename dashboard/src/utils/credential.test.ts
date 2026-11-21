// The one credential slot every part of the dashboard reads. A tab is signed in with either an API key
// or a session token, both stored under the same key so an existing tab keeps working across the
// upgrade, and the cached account beside it must never outlive the credential it describes.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearCredential,
  clearStoredAccount,
  isSessionToken,
  isSignedInAsUser,
  readCredential,
  readStoredAccount,
  storeAccount,
  storeCredential,
} from './credential.ts';

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
});

beforeEach(() => {
  sessionStorage.clear();
});

test('the credential round-trips under the key older builds already used', () => {
  assert.equal(readCredential(), null);
  storeCredential('owa_k1_abc');
  assert.equal(readCredential(), 'owa_k1_abc');
  assert.equal(sessionStorage.getItem('openwa_api_key'), 'owa_k1_abc');
});

test('clearing the credential drops the cached account with it', () => {
  storeCredential('owa_s1_abc');
  storeAccount({ id: 'u1', email: 'ada@example.com', name: 'Ada' });
  clearCredential();
  assert.equal(readCredential(), null);
  assert.equal(readStoredAccount(), null);
});

test('only the session prefix marks an email sign-in', () => {
  assert.equal(isSessionToken('owa_s1_abc'), true);
  assert.equal(isSessionToken('  owa_s1_abc  '), true);
  assert.equal(isSessionToken('owa_k1_abc'), false);
  assert.equal(isSessionToken(''), false);
  assert.equal(isSessionToken(null), false);
  assert.equal(isSessionToken(undefined), false);
});

test('isSignedInAsUser reads the stored credential, not a passed value', () => {
  assert.equal(isSignedInAsUser(), false);
  storeCredential('owa_k1_abc');
  assert.equal(isSignedInAsUser(), false);
  storeCredential('owa_s1_abc');
  assert.equal(isSignedInAsUser(), true);
});

test('the account round-trips and keeps an empty name when none was given', () => {
  storeAccount({ id: 'u1', email: 'ada@example.com', name: 'Ada' });
  assert.deepEqual(readStoredAccount(), { id: 'u1', email: 'ada@example.com', name: 'Ada' });
  sessionStorage.setItem('openwa_user', JSON.stringify({ id: 'u1', email: 'ada@example.com' }));
  assert.deepEqual(readStoredAccount(), { id: 'u1', email: 'ada@example.com', name: '' });
});

test('a corrupt or foreign entry reads as no account instead of failing the render', () => {
  sessionStorage.setItem('openwa_user', '{not json');
  assert.equal(readStoredAccount(), null);
  sessionStorage.setItem('openwa_user', JSON.stringify({ id: 1, email: 'ada@example.com' }));
  assert.equal(readStoredAccount(), null);
  sessionStorage.setItem('openwa_user', JSON.stringify({ id: 'u1' }));
  assert.equal(readStoredAccount(), null);
});

test('storing no account clears the one already there', () => {
  storeAccount({ id: 'u1', email: 'ada@example.com', name: 'Ada' });
  storeAccount(null);
  assert.equal(readStoredAccount(), null);
  storeAccount({ id: 'u1', email: 'ada@example.com', name: 'Ada' });
  clearStoredAccount();
  assert.equal(readStoredAccount(), null);
});
