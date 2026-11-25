import { test } from 'node:test';
import assert from 'node:assert/strict';
import { responseError } from '../src/features/project/responseError';
import { studioError } from '../src/cloudflare/apiResponse';

test('only authentication failures ask for sign-in; server interruption keeps the session', () => {
  for (const status of [200, 403, 429, 502, 503, 504, 524]) {
    const failure = responseError(new Response('<html>upstream error</html>', { status }));
    assert.doesNotMatch(failure.message, /sign in/i);
    assert.equal(failure.transient, status === 429 || status >= 500);
  }
  assert.match(responseError(new Response(null, { status: 401 })).message, /Sign in again/);
  assert.match(responseError(new Response(null, { status: 429, headers: { 'Retry-After': '299' } })).message, /299 seconds/);
});
test('API failures have a JSON body and preserve their actual HTTP status', async () => {
  for (const status of [401, 403, 503]) {
    const response = studioError(new Request('https://studio.test/studio/api/publish'), 'Test failure', status);
    assert.equal(response.status, status);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await response.json(), { error: 'Test failure' });
  }
});
