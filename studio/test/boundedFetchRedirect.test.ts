// Goal: identity-service fetches work on the Workers runtime, which rejects `redirect: 'error'`, and still refuse
// redirects. Method: call fetchJson with a fetcher that records its init and answers a JSON body or a 302.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchJson } from '../src/features/auth/providers/boundedFetch';

test('identity fetches ask for redirect: manual, which the Workers runtime accepts', async () => {
  let seen: RequestInit | undefined;
  const answer = await fetchJson(
    async (_url, init) => {
      seen = init;
      return Response.json({ issuer: 'https://idp.example' });
    },
    'https://idp.example/.well-known/openid-configuration',
    {},
  );
  assert.equal(seen?.redirect, 'manual');
  assert.deepEqual(answer, { ok: true, value: { issuer: 'https://idp.example' } });
});
test('a redirect answer is refused as a status failure', async () => {
  const answer = await fetchJson(
    async () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example/' } }),
    'https://idp.example/jwks',
    {},
  );
  assert.deepEqual(answer, { ok: false, error: { kind: 'status', status: 302 } });
});
