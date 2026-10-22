// Goal: sign-in exposes bounded device codes, browser authorization URLs, and sanitized states.
// Method: round-trip all actions and states, then reject malformed and oversized input.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseIpcPayload } from '#dist/shared/ipc/ipcPayloads.js';
import {
  accountSignInPending,
  parseAccountRequest,
  parseAccountState,
} from '#dist/shared/ipc/publishAccount.js';

const id = '00000000-0000-4000-8000-000000000000';
test('GitHub sign-in actions and states round-trip', () => {
  for (const action of ['start', 'status', 'cancel']) {
    const request = { action, id };
    assert.deepEqual(parseAccountRequest(request), request);
    assert.deepEqual(parseIpcPayload('publish:account', { projectPath: '/site', request }), {
      projectPath: '/site',
      request,
    });
  }
  for (const state of [
    { kind: 'installing' },
    { kind: 'starting' },
    { kind: 'waiting', code: 'ABCD-1234' },
    { kind: 'complete' },
    { kind: 'cancelled' },
    { kind: 'failed', message: 'Unavailable' },
  ]) {
    assert.deepEqual(parseAccountState(state), state);
  }
});

test('GitHub sign-in rejects invalid identities, actions, states and bounds', () => {
  assert.throws(
    () => parseAccountRequest({ action: 'start', id: '' }),
    /Invalid GitHub sign-in session/,
  );
  assert.throws(
    () => parseAccountState({ kind: 'waiting', code: 'invalid' }),
    /Invalid GitHub sign-in code/,
  );
  for (const input of [
    undefined,
    {},
    { action: 'other', id },
    { action: 'start', id: '' },
    { action: 'status', id: 'x'.repeat(1000) },
    { action: 'cancel', id: 1 },
  ]) {
    assert.throws(() => parseAccountRequest(input));
  }
  for (const input of [
    undefined,
    {},
    { kind: 'unknown' },
    { kind: 'waiting', code: 'ABCD-1234-extra' },
    { kind: 'waiting', code: 1 },
    { kind: 'waiting', code: 'x'.repeat(1000) },
    { kind: 'failed', message: '' },
    { kind: 'failed', message: 'x'.repeat(1001) },
  ]) {
    assert.throws(() => parseAccountState(input));
  }
  assert.deepEqual(parseAccountState({ kind: 'complete', token: 'not-for-renderer' }), {
    kind: 'complete',
  });
});

test('Cloudflare sign-in accepts only its bounded authorization URL and provider', () => {
  const url = 'https://dash.cloudflare.com/oauth2/auth?client_id=test&state=nonce';
  for (const action of ['start', 'status', 'cancel']) {
    const request = { action, id, provider: 'cloudflare' };
    assert.deepEqual(parseAccountRequest(request), request);
    assert.deepEqual(parseIpcPayload('publish:account', { projectPath: '/site', request }), {
      projectPath: '/site',
      request,
    });
  }
  assert.deepEqual(parseAccountState({ kind: 'browser', url }), { kind: 'browser', url });
  assert.throws(() => parseAccountRequest({ action: 'start', id, provider: 'other' }));
  for (const invalid of [
    'https://evil.example/oauth2/auth',
    'https://dash.cloudflare.com.evil.example/oauth2/auth',
    'https://dash.cloudflare.com/other',
    'http://dash.cloudflare.com/oauth2/auth',
    'https://user:password@dash.cloudflare.com/oauth2/auth',
    `${url}#token`,
    `${url}&state=${'x'.repeat(4096)}`,
    undefined,
  ]) {
    assert.throws(() => parseAccountState({ kind: 'browser', url: invalid }));
  }
});

test('only running sign-in states are pending', () => {
  const url = 'https://dash.cloudflare.com/oauth2/auth?client_id=test&state=nonce';
  for (const state of [
    { kind: 'installing' },
    { kind: 'starting' },
    { kind: 'waiting', code: 'ABCD-1234' },
    { kind: 'browser', url },
  ]) {
    assert.equal(accountSignInPending(parseAccountState(state)), true, state.kind);
  }
  for (const state of [
    { kind: 'complete' },
    { kind: 'cancelled' },
    { kind: 'failed', message: 'Unavailable' },
  ]) {
    assert.equal(accountSignInPending(parseAccountState(state)), false, state.kind);
  }
});
