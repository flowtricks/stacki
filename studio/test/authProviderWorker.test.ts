// Goal: swapping the authentication provider works end to end in the real Workers runtime, and core, not the provider,
// guards every route. With a fake provider in the auth slot (as `npm run build` wires studio/cloudflare/auth-provider.ts)
// a person it signed in reaches the container with a provider-qualified identity and no GitHub headers; a person its
// policy rejects, a forged GitHub login, and a leftover GitHub session do not; and updates need the provider's say-so.
// Method: the real Worker in workerd (workerRuntime.ts) with a stub container that echoes what reached it. Sessions are
// minted with core's own signing function, since the sign-in routes themselves run in the Durable Object (their flow is
// covered, with the same provider, in authProviders.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { startWorkerRuntime, studioCookie, WORKER_TEST, WORKER_RUNTIME_LIMITS } from './workerRuntime';
import { signClaims } from '../src/features/auth/session';
import { signPrincipal } from '../src/features/auth/principalSession';
import { parsePerson, parseProviderId } from '../src/features/auth/authProvider';

async function fakeCookie(name: string, audience: 'studio' | 'preview' = 'studio', lifetimeMs = 60_000): Promise<string> {
  const provider = parseProviderId('fake');
  assert.ok(provider.ok);
  const person = parsePerson({ identity: `fake:${name}`, name: `${name} Example`, email: `${name}@example.test` }, provider.value);
  assert.ok(person.ok);
  const cookieName = audience === 'studio' ? '__Host-studio' : '__Host-studio-preview';
  if (lifetimeMs < 0) {
    // Core refuses to sign a session that is already over, so an expired one is made from the raw envelope.
    return `${cookieName}=${await signClaims({ v: 2, ...person.value, audience, expires: Date.now() + lifetimeMs }, WORKER_TEST.sessionSecret)}`;
  }
  const token = await signPrincipal(person.value, audience, Date.now() + lifetimeMs, WORKER_TEST.sessionSecret);
  assert.ok(token.ok);
  return `${cookieName}=${token.value}`;
}

const options = {
  authProviderModule: fileURLToPath(new URL('./fakeAuthProviderModule.ts', import.meta.url)),
  vars: { FAKE_PROVIDER_FLAG: 'on', EDITOR_ACCESS: 'repository' },
} as const;

test(
  'a swapped-in provider’s person reaches the container with a qualified identity and nothing forged',
  { timeout: WORKER_RUNTIME_LIMITS.testFileMs },
  async (context) => {
    const runtime = await startWorkerRuntime(options);
    context.after(() => runtime.dispose());
    const forged = {
      'x-studio-user': 'owner',
      'x-studio-user-id': '1',
      'x-studio-identity': 'github:owner',
      'x-studio-aliases': 'github:owner',
      'x-studio-name': 'owner',
    };
    const response = await runtime.fetch(WORKER_TEST.studioOrigin + '/studio/api/project', { headers: { cookie: await fakeCookie('alice'), ...forged } });
    assert.equal(response.headers.get('x-stub-preview'), 'reached');
    const echo = JSON.parse(await response.text()) as Record<string, unknown>;
    assert.equal(echo['identity'], 'fake:alice');
    assert.equal(echo['aliases'], 'fake:alice-alias');
    assert.equal(echo['name'], encodeURIComponent('alice Example'));
    assert.equal(echo['user'], null, 'no GitHub login for a non-GitHub person, whatever the client sent');
    assert.equal(echo['userId'], null);
    assert.equal(echo['token'], WORKER_TEST.containerToken);
    assert.equal(echo['cookie'], null, 'the browser’s cookies never reach the container');
    assert.deepEqual(runtime.unexpectedLogs([]), []);
  },
);

test('the provider’s edit policy and core’s session rules gate every request', { timeout: WORKER_RUNTIME_LIMITS.testFileMs }, async (context) => {
  const runtime = await startWorkerRuntime(options);
  context.after(() => runtime.dispose());
  const attempt = (cookie: string, path = '/studio/api/project') => runtime.fetch(WORKER_TEST.studioOrigin + path, { headers: { cookie } });
  assert.equal((await attempt(await fakeCookie('bob'))).headers.get('x-stub-preview'), 'reached');
  const mallory = await attempt(await fakeCookie('mallory'));
  assert.equal(mallory.status, 403, 'verified by the provider, refused by its policy');
  assert.equal(mallory.headers.get('x-stub-preview'), null);
  assert.equal((await attempt(await fakeCookie('alice', 'studio', -1_000))).status, 401, 'an expired session');
  assert.equal((await attempt(await fakeCookie('alice', 'preview'))).status, 401, 'a preview session is not a studio session');
  const leftover = await attempt(await studioCookie(60_000));
  assert.equal(leftover.status, 401, 'a GitHub session from before the switch proves nothing');
  assert.equal(leftover.headers.get('x-stub-preview'), null);
  assert.deepEqual(runtime.unexpectedLogs([]), []);
});

test('the editor is told who is signed in, and the sign-in page names the provider', { timeout: WORKER_RUNTIME_LIMITS.testFileMs }, async (context) => {
  const runtime = await startWorkerRuntime(options);
  context.after(() => runtime.dispose());
  const session = await runtime.fetch(WORKER_TEST.studioOrigin + '/studio/api/session', { headers: { cookie: await fakeCookie('alice') } });
  assert.deepEqual(JSON.parse(await session.text()), {
    kind: 'account',
    identity: 'fake:alice',
    aliases: ['fake:alice-alias'],
    name: 'alice Example',
    email: 'alice@example.test',
  });
  const page = await runtime.fetch(WORKER_TEST.studioOrigin + '/studio', {});
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('Continue with Fake Login'));
  assert.equal(html.includes('GitHub'), false);
  assert.deepEqual(runtime.unexpectedLogs([]), []);
});

test(
  'preview sessions are minted by core for the same person and re-checked against the provider',
  { timeout: WORKER_RUNTIME_LIMITS.testFileMs },
  async (context) => {
    const runtime = await startWorkerRuntime(options);
    context.after(() => runtime.dispose());
    const issued = JSON.parse(
      await (await runtime.fetch(WORKER_TEST.studioOrigin + '/studio/api/preview-url?page=/', { headers: { cookie: await fakeCookie('bob') } })).text(),
    ) as { url: string };
    const entry = await runtime.fetch(issued.url, { redirect: 'manual' });
    assert.equal(entry.status, 302);
    const previewCookie = (entry.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    assert.ok(previewCookie.startsWith('__Host-studio-preview='));
    // The preview is a cross-site frame on workers.dev: a Lax cookie is refused there and the editor script never runs.
    const attributes = (entry.headers.get('set-cookie') ?? '').split(';').map((part) => part.trim());
    assert.ok(attributes.includes('SameSite=None'), 'the preview cookie is allowed in a cross-site frame');
    assert.ok(attributes.includes('Partitioned'), 'the preview cookie is partitioned to the editor site');
    assert.ok(attributes.includes('Secure'));
    assert.ok(!attributes.includes('SameSite=Lax'));
    const reached = await runtime.fetch(WORKER_TEST.previewOrigin + '/', { headers: { cookie: previewCookie } });
    assert.equal(reached.headers.get('x-stub-preview'), 'reached');
    const echoed: unknown = JSON.parse(await reached.text());
    assert.deepEqual(echoed !== null && typeof echoed === 'object' && 'identity' in echoed ? echoed.identity : undefined, 'fake:bob');
    const replayed = await runtime.fetch(WORKER_TEST.previewOrigin + '/__studio-entry?token=' + (await fakeCookie('mallory', 'preview')).split('=')[1], {
      redirect: 'manual',
    });
    assert.equal(replayed.status, 403, 'a preview token for a person the policy rejects');
    assert.deepEqual(runtime.unexpectedLogs([]), []);
  },
);

test('managing Studio updates needs the provider’s canManage', { timeout: WORKER_RUNTIME_LIMITS.testFileMs }, async (context) => {
  const runtime = await startWorkerRuntime(options);
  context.after(() => runtime.dispose());
  const bob = await runtime.fetch(WORKER_TEST.studioOrigin + '/studio/api/updates', { headers: { cookie: await fakeCookie('bob') } });
  assert.equal(bob.status, 403, 'bob may edit but not manage');
  assert.deepEqual(runtime.unexpectedLogs([]), []);
});
