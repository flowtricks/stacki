import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForDeployment } from '../src/features/publishing/deployment';
import { serveSite } from '../src/features/deployment/siteGateway';

test('deployment confirmation requires the exact live revision and survives transient outages', async () => {
  const sha = 'a'.repeat(40);
  let calls = 0;
  const result = await waitForDeployment('https://site.test/__studio-deployment', sha, {
    attempts: 3,
    interval: 1,
    transport: async (_url, options) => {
      assert.equal(options?.cache, 'no-store');
      calls++;
      return calls === 1 ? new Response('Restarting', { status: 503 }) : Response.json({ sha: calls === 2 ? 'b'.repeat(40) : sha });
    },
  });
  assert.equal(result, 'live');
  assert.equal(calls, 3);
});

test('an unrelated deployment cannot mark a published revision live', async () => {
  const result = await waitForDeployment('https://site.test/__studio-deployment', 'a'.repeat(40), {
    attempts: 2,
    interval: 1,
    transport: async () => Response.json({ sha: 'b'.repeat(40) }),
  });
  assert.equal(result, 'pending');
});

test('the public deployment marker reports only a validated deployed tag and is never cached', async () => {
  for (const tag of ['a'.repeat(40), 'not-a-revision']) {
    const response = await serveSite(new Request('https://site.test/__studio-deployment'), {
      ASSETS: {
        async fetch() {
          throw new Error('Marker must not serve a cached asset');
        },
      },
      SITE_VERSION: { tag },
    });
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await response.json(), { sha: tag.startsWith('a') ? tag : null });
  }
});

test('the public site never serves assets for an unconfigured studio route', async () => {
  const environment = {
    ASSETS: { fetch: async () => new Response('public website') },
  };
  for (const route of ['/studio', '/studio/', '/studio/api/project']) {
    const response = await serveSite(new Request('https://site.test' + route), environment);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  const publicPage = await serveSite(new Request('https://site.test/studio-tour'), environment);
  assert.equal(await publicPage.text(), 'public website');
});

test('studio requests retain their origin, cookies, and body through the site gateway', async () => {
  const request = new Request('https://site.test/studio/api/file', {
    method: 'POST',
    headers: { Origin: 'https://site.test', Cookie: '__Host-studio=session' },
    body: 'changes',
  });
  const response = await serveSite(request, {
    ASSETS: { fetch: async () => new Response('unexpected assets', { status: 500 }) },
    STUDIO: {
      async fetch(forwarded: Request) {
        assert.equal(forwarded, request);
        assert.equal(await forwarded.text(), 'changes');
        return new Response('authenticated studio');
      },
    },
  });
  assert.equal(await response.text(), 'authenticated studio');
});
