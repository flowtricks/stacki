// Signed identities must expire, remain audience-bound, and reject tampering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signSession, verifySession } from '../src/features/auth/session';
const secret = 'test-secret-only-at-least-32-characters';
test('signed sessions verify only for their intended audience', async () => {
  const identity = {
    id: 123,
    login: 'editor',
    expires: Date.now() + 10_000,
    audience: 'studio' as const,
  };
  const token = await signSession(identity, secret);
  assert.deepEqual(await verifySession(token, secret, 'studio'), identity);
  assert.equal(await verifySession(token, secret, 'preview'), undefined);
  assert.equal(await verifySession(token + 'tampered', secret, 'studio'), undefined);
  assert.equal(await verifySession(token, secret + 'different', 'studio'), undefined);
});
test('expired and malformed sessions fail closed', async () => {
  const token = await signSession({ id: 123, login: 'editor', expires: Date.now() - 1, audience: 'studio' }, secret);
  assert.equal(await verifySession(token, secret, 'studio'), undefined);
  for (const value of ['', 'a.b', '{}', '.']) {
    assert.equal(await verifySession(value, secret, 'studio'), undefined);
  }
});
