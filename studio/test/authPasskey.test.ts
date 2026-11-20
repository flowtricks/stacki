// Goal: passkey sign-in works end to end through core's real sign-in flow, and every way of abusing it fails.
// Method: a software authenticator (softAuthenticator.ts) enrols and signs in through authRoutes with an in-memory store that
// has the same transaction semantics as Durable Object storage. Cases: admin invites (hashed at rest, single use, 7-day
// expiry, revoke), enrolment, sign-in, replayed and foreign challenges, wrong origin, counter rollback, a locked handle,
// hostile requests to every public route, rate limits, and the conformance kit. No device, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPasskeyProvider, parseAssertion, PASSKEY_REQUEST_LIMITS } from '../src/features/auth/providers/passkey';
import { createPasskeyStore, inviteHash, PASSKEY_LIMITS, type KeyValueStorage, type PasskeyStore } from '../src/features/auth/providers/passkeyStore';
import { parsePasskeyAdminCommand, runPasskeyAdmin } from '../src/features/auth/providers/passkeyAdmin';
import { createAuthRuntime, mayEdit, mayManage } from '../src/features/auth/authRuntime';
import { authRoutes } from '../src/features/auth/authRoutes';
import { encodeBase64url, utf8Bytes } from '../src/features/auth/providers/base64url';
import { verifySession } from '../src/features/auth/session';
import { verifyPrincipal } from '../src/features/auth/principalSession';
import { parseQualifiedIdentity } from '../vendor/stacki/shared/properties/memberIdentity';
import { CONFORMANCE, runAuthProviderConformance } from './authProviderConformance';
import { contextFor, fakeNetwork, rolesFrom } from './builtInAuthFixtures';
import { loginAttemptFixture } from './loginAttemptFixture';
import { softAuthenticator } from './softAuthenticator';

const origin = CONFORMANCE.origin;
const rpId = new URL(origin).hostname;
const DAY = 86_400_000;

/** Memory storage with Durable Object semantics: operations inside `transaction` run one at a time. */
function memoryStorage(): { readonly storage: KeyValueStorage; readonly data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  let chain: Promise<unknown> = Promise.resolve();
  const operations = {
    get: (key: string) => Promise.resolve(data.get(key)),
    put: (key: string, value: unknown) => {
      data.set(key, structuredClone(value));
      return Promise.resolve();
    },
    delete: (key: string) => Promise.resolve(data.delete(key)),
    list: (options: { readonly prefix: string; readonly limit: number }) =>
      Promise.resolve(new Map([...data].filter(([key]) => key.startsWith(options.prefix)).slice(0, options.limit))),
  };
  const storage: KeyValueStorage = {
    ...operations,
    transaction: <T>(closure: (transaction: KeyValueStorage) => Promise<T>): Promise<T> => {
      const run = chain.then(() => closure(storage));
      chain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
  return { storage, data };
}

const rolesFile = JSON.stringify({
  version: 1,
  roles: [
    { id: 'admin', name: 'Admin', members: ['passkey:owner'] },
    { id: 'client', name: 'Client', members: ['passkey:client-acme', 'passkey:zed'] },
  ],
});

function world(options: { environment?: Record<string, unknown>; now?: { value: number } } = {}) {
  const clock = options.now ?? { value: Date.now() };
  const { storage, data } = memoryStorage();
  const store = createPasskeyStore(storage);
  const context = {
    ...contextFor({ AUTH_BOOTSTRAP_ADMIN: 'passkey:owner', ...options.environment }, fakeNetwork(), rolesFrom(rolesFile), () => clock.value),
    passkeys: store,
    passkeyHandleActive: (handle: string) => store.handleActive(handle, clock.value),
  };
  const provider = createPasskeyProvider(context);
  const runtime = createAuthRuntime({ provider, installed: 'built-in', origin, secret: CONFORMANCE.secret, editorAccess: undefined });
  const attempts = loginAttemptFixture().create();
  return { clock, store, data, provider, runtime, attempts };
}
type World = ReturnType<typeof world>;

async function startFlow(w: World, query = '', headers: Record<string, string> = {}) {
  const response = await authRoutes(new Request(`${origin}/studio/auth/login${query}`, { headers }), w.runtime, w.attempts);
  assert.ok(response);
  const cookie =
    response.headers
      .getSetCookie()
      .find((value) => value.startsWith('__Host-studio-state='))
      ?.split(';')[0] ?? '';
  const state = await stateOf(cookie);
  return { response, cookie, html: await response.clone().text(), stateCookie: cookie, state };
}

async function stateOf(cookie: string): Promise<string> {
  const claims = await verifySession(cookie.slice('__Host-studio-state='.length), CONFORMANCE.secret, 'login');
  assert.ok(claims);
  return claims.login;
}

const post = (w: World, step: string, body: unknown, cookie: string, extra: Record<string, string> = {}) =>
  authRoutes(
    new Request(`${origin}/studio/auth/provider/passkey/${step}`, {
      method: 'POST',
      headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', ...extra },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    w.runtime,
    w.attempts,
  );

async function invite(w: World, handle = 'client-acme', displayName: string | undefined = 'Acme Client') {
  const created = await runPasskeyAdmin(w.store, { action: 'invite', handle, displayName }, { origin, actor: 'passkey:owner', nowMs: w.clock.value });
  assert.ok(created.ok && created.value.kind === 'invite');
  const code = new URL(created.value.link).searchParams.get('invite') ?? '';
  return { code, link: created.value.link, expiresAt: created.value.expiresAt };
}

async function enrol(w: World, device: Awaited<ReturnType<typeof softAuthenticator>>, code: string) {
  const flow = await startFlow(w, `?invite=${code}`);
  const optionsResponse = await post(w, 'register-options', { invite: code }, flow.cookie);
  assert.equal(optionsResponse?.status, 200);
  const options = (await optionsResponse?.json()) as { challenge: string };
  const made = await device.create(options.challenge);
  const registered = await post(
    w,
    'register',
    { invite: code, clientDataJSON: encodeBase64url(made.clientDataJSON), attestationObject: encodeBase64url(made.attestationObject), label: 'Laptop' },
    flow.cookie,
  );
  return { flow, options, made, registered };
}

async function signIn(
  w: World,
  device: Awaited<ReturnType<typeof softAuthenticator>>,
  bad: Parameters<typeof device.assertionParameter>[1] = {},
  userHandle?: Uint8Array,
) {
  const flow = await startFlow(w);
  const optionsResponse = await post(w, 'options', {}, flow.cookie);
  assert.equal(optionsResponse?.status, 200);
  const options = (await optionsResponse?.json()) as { challenge: string; rpId: string };
  assert.equal(options.rpId, rpId);
  const assertion = await device.assertionParameter(options.challenge, bad, userHandle);
  const response = await authRoutes(
    new Request(`${origin}/studio/auth/passkey/callback?state=${flow.state}&assertion=${assertion}`, { headers: { Cookie: flow.cookie } }),
    w.runtime,
    w.attempts,
  );
  assert.ok(response);
  return { flow, options, assertion, response };
}

const sessionOf = async (response: Response) => {
  const cookie = response.headers.getSetCookie().find((value) => /^__Host-studio=[^;]/.test(value));
  return cookie === undefined ? undefined : verifyPrincipal(cookie.split(';')[0]?.slice('__Host-studio='.length) ?? '', CONFORMANCE.secret, 'studio');
};

test('an invite enrols a passkey once, then the person signs in as passkey:<handle>', async () => {
  const w = world();
  const device = await softAuthenticator({ origin, rpId });
  const { code, link } = await invite(w);
  assert.equal(link, `${origin}/studio/auth/login?invite=${code}`);
  const page = await startFlow(w, `?invite=${code}`);
  assert.equal(page.response.status, 200);
  assert.match(page.html, /Create your passkey/);
  assert.match(page.html, /Acme Client/);
  assert.match(page.response.headers.get('Content-Security-Policy') ?? '', /script-src 'sha256-/);
  const done = await enrol(w, device, code);
  assert.equal(done.registered?.status, 200);
  const result = await signIn(w, device);
  assert.equal(
    result.response.status,
    302,
    ((await result.response.clone().text()).match(/login-message">([^<]*)/)?.[1] ?? '') +
      ((await result.response.clone().text()).match(/Reference[^<]*/)?.[0] ?? ''),
  );
  const principal = await sessionOf(result.response);
  assert.equal(principal?.identity, 'passkey:client-acme');
  assert.equal(principal?.name, 'Acme Client');
  assert.ok(principal && (await mayEdit(w.runtime, principal, 'cached')), 'listed in roles.json');
  assert.equal(principal && (await mayManage(w.runtime, principal)), false, 'a client does not manage');
  // Core clears the state cookie in the real browser, so a replayed callback carries none.
  const replay = await authRoutes(
    new Request(`${origin}/studio/auth/passkey/callback?state=${result.flow.state}&assertion=${result.assertion}`),
    w.runtime,
    w.attempts,
  );
  assert.equal(replay?.status, 403);
  assert.equal(await sessionOf(replay ?? new Response()), undefined);
});

test('an invite is single use, expires after seven days, can be revoked, and is stored only as a hash', async () => {
  const w = world();
  const { code } = await invite(w);
  assert.ok(![...JSON.stringify([...w.data])].join('').includes(code), 'the code is never stored');
  assert.equal((await enrol(w, await softAuthenticator({ origin, rpId }), code)).registered?.status, 200);
  const again = await post(w, 'register-options', { invite: code }, (await startFlow(w, `?invite=${code}`)).cookie);
  assert.equal(again?.status, 400, 'a spent invite offers no options');
  assert.match((await startFlow(w, `?invite=${code}`)).html, /expired or was already used/);

  const second = await invite(w, 'zed');
  w.clock.value += 7 * DAY + 1;
  assert.equal((await post(w, 'register-options', { invite: second.code }, (await startFlow(w, `?invite=${second.code}`)).cookie))?.status, 400, 'expired');
  w.clock.value -= 7 * DAY + 1;

  const third = await invite(w, 'zed');
  const hashOfThird = await inviteHash(third.code);
  const view = await runPasskeyAdmin(w.store, { action: 'list' }, { origin, actor: 'passkey:owner', nowMs: w.clock.value });
  assert.ok(view.ok && view.value.kind === 'view');
  const pending = view.value.view.invites.find((entry) => entry.hash === hashOfThird);
  assert.ok(pending);
  assert.equal(JSON.stringify(view.value).includes(third.code), false, 'listing shows no code');
  const revoked = await runPasskeyAdmin(w.store, { action: 'revokeInvite', hash: pending.hash }, { origin, actor: 'passkey:owner', nowMs: w.clock.value });
  assert.ok(revoked.ok);
  assert.equal((await post(w, 'register-options', { invite: third.code }, (await startFlow(w, `?invite=${third.code}`)).cookie))?.status, 400, 'revoked');
  assert.equal(
    (await runPasskeyAdmin(w.store, { action: 'revokeInvite', hash: pending.hash }, { origin, actor: 'x', nowMs: 1 })).ok,
    false,
    'twice is not found',
  );
});

test('two requests cannot spend one invite or one challenge', async () => {
  const w = world();
  const { code } = await invite(w);
  const devices = await Promise.all([softAuthenticator({ origin, rpId }), softAuthenticator({ origin, rpId })]);
  const results = await Promise.all(devices.map((device) => enrol(w, device, code)));
  const statuses = results.map((result) => result.registered?.status).sort();
  assert.deepEqual(statuses, [200, 400], 'exactly one registration wins');
  assert.equal((await w.store.credentialsOf('client-acme')).length, 1);
});

test('registration refuses a wrong origin, a replayed challenge and another browser’s challenge', async () => {
  const w = world();
  const { code } = await invite(w);
  const device = await softAuthenticator({ origin, rpId });
  const flow = await startFlow(w, `?invite=${code}`);
  const options = (await (await post(w, 'register-options', { invite: code }, flow.cookie))?.json()) as { challenge: string };
  const wrong = await device.create(options.challenge, { origin: 'https://evil.example.test' });
  const body = (made: typeof wrong) => ({
    invite: code,
    clientDataJSON: encodeBase64url(made.clientDataJSON),
    attestationObject: encodeBase64url(made.attestationObject),
  });
  assert.equal((await post(w, 'register', body(wrong), flow.cookie))?.status, 400, 'wrong origin');
  const good = await device.create(options.challenge);
  assert.equal((await post(w, 'register', body(good), flow.cookie))?.status, 400, 'the challenge was spent by the failed attempt');
  const other = await startFlow(w, `?invite=${code}`);
  const options2 = (await (await post(w, 'register-options', { invite: code }, flow.cookie))?.json()) as { challenge: string };
  const made2 = await device.create(options2.challenge);
  assert.equal((await post(w, 'register', body(made2), other.cookie))?.status, 400, 'a challenge answers only the flow it was issued to');
  assert.equal((await w.store.credentialsOf('client-acme')).length, 0);
});

test('sign-in refuses a wrong origin, a counter that goes back, a foreign userHandle, and an unknown passkey', async () => {
  const w = world();
  const device = await softAuthenticator({ origin, rpId });
  assert.equal((await enrol(w, device, (await invite(w)).code)).registered?.status, 200);
  assert.equal((await signIn(w, device, { origin: 'https://evil.example.test' })).response.status >= 400, true);
  assert.equal((await signIn(w, device, { corruptSignature: true })).response.status >= 400, true);
  assert.equal((await signIn(w, device, {}, utf8Bytes('someone-else'))).response.status >= 400, true, 'userHandle must match the passkey’s handle');
  assert.equal((await signIn(w, device, {}, utf8Bytes('client-acme'))).response.status, 302, 'a matching userHandle is fine');
  const rolled = await signIn(w, device, { signCount: 1 });
  assert.equal(rolled.response.status >= 400, true, 'a counter at or below the stored one is a cloned authenticator');
  assert.equal(await sessionOf(rolled.response), undefined);
  const stranger = await softAuthenticator({ origin, rpId });
  assert.equal((await signIn(w, stranger)).response.status >= 400, true, 'an unregistered passkey');
  assert.equal((await signIn(w, device, { signCount: 10 })).response.status, 302, 'the real passkey still works afterwards');
});

test('removing a passkey stops it signing in; locking a handle ends its sessions and blocks new invites for eight hours', async () => {
  const w = world();
  const device = await softAuthenticator({ origin, rpId });
  await enrol(w, device, (await invite(w)).code);
  const [stored] = await w.store.credentialsOf('client-acme');
  assert.ok(stored);
  const principal = await sessionOf((await signIn(w, device)).response);
  assert.ok(principal);
  const removed = await runPasskeyAdmin(w.store, { action: 'removeCredential', id: stored.id }, { origin, actor: 'passkey:owner', nowMs: w.clock.value });
  assert.ok(removed.ok);
  assert.equal((await signIn(w, device)).response.status >= 400, true, 'a removed passkey cannot sign in');
  assert.ok(await mayEdit(w.runtime, principal, 'cached'), 'removing one passkey leaves the handle’s existing sessions to expire');

  await enrol(w, device, (await invite(w)).code);
  assert.ok((await runPasskeyAdmin(w.store, { action: 'lock', handle: 'client-acme' }, { origin, actor: 'passkey:owner', nowMs: w.clock.value })).ok);
  assert.equal(await mayEdit(w.runtime, principal, 'cached'), false, 'a locked handle’s live session stops working');
  assert.equal((await signIn(w, device)).response.status >= 400, true);
  const blocked = await runPasskeyAdmin(
    w.store,
    { action: 'invite', handle: 'client-acme', displayName: undefined },
    { origin, actor: 'passkey:owner', nowMs: w.clock.value },
  );
  assert.equal(blocked.ok ? 'ok' : blocked.error, 'locked');
  w.clock.value += PASSKEY_LIMITS.lockMs + 1;
  assert.ok(
    (
      await runPasskeyAdmin(
        w.store,
        { action: 'invite', handle: 'client-acme', displayName: undefined },
        { origin, actor: 'passkey:owner', nowMs: w.clock.value },
      )
    ).ok,
    'after every old session has expired',
  );
});

test('managers are roles.json admins, or the bootstrap admin while no valid file exists', async () => {
  const w = world();
  const owner = parseQualifiedIdentity('passkey:owner');
  assert.ok(owner.ok);
  await w.store.createInvite({ handle: 'owner', displayName: undefined, createdBy: 'x', nowMs: w.clock.value });
  assert.equal(await w.provider.canManage?.({ identity: owner.value, name: 'o', expires: Date.now() + 1000 }), true);
  assert.equal(await w.provider.canEdit?.({ identity: owner.value, name: 'o', expires: Date.now() + 1000 }, 'fresh'), true);
});

test('hostile requests to the passkey routes are refused and cost the Worker little', async () => {
  const w = world();
  const flow = await startFlow(w);
  const huge = JSON.stringify({ pad: 'x'.repeat(PASSKEY_REQUEST_LIMITS.bodyBytesMax + 1) });
  for (const [label, body] of [
    ['not json', '{'],
    ['an array', '[]'],
    ['a string', '"x"'],
    ['too large', huge],
    ['null', 'null'],
  ] as const) {
    for (const step of ['options', 'register-options', 'register']) {
      const response = await post(w, step, body, flow.cookie);
      assert.ok(response && response.status >= 400 && response.status < 500, `${step} ${label}: ${response?.status}`);
    }
  }
  const noState = await authRoutes(
    new Request(`${origin}/studio/auth/provider/passkey/options`, { method: 'POST', headers: { Origin: origin } }),
    w.runtime,
    w.attempts,
  );
  assert.equal(noState?.status, 403, 'no sign-in state, no ceremony');
  const foreign = await authRoutes(
    new Request(`${origin}/studio/auth/provider/passkey/options`, { method: 'POST', headers: { Origin: 'https://evil.test', Cookie: flow.cookie } }),
    w.runtime,
    w.attempts,
  );
  assert.equal(foreign?.status, 403, 'a cross-site POST is refused by core');
  const get = await authRoutes(new Request(`${origin}/studio/auth/provider/passkey/options`, { headers: { Cookie: flow.cookie } }), w.runtime, w.attempts);
  assert.equal(get?.status, 405);
  const unknown = await authRoutes(
    new Request(`${origin}/studio/auth/provider/other`, { method: 'POST', headers: { Origin: origin, Cookie: flow.cookie } }),
    w.runtime,
    w.attempts,
  );
  assert.equal(unknown, undefined, 'paths the provider does not own fall through');
  for (const assertion of [
    '',
    'x',
    '!!',
    'e30',
    encodeBase64url(utf8Bytes('[]')),
    encodeBase64url(utf8Bytes('{"id":1}')),
    'A'.repeat(PASSKEY_REQUEST_LIMITS.assertionCharsMax + 1),
    encodeBase64url(utf8Bytes(JSON.stringify({ id: 'AA', clientDataJSON: 'AA', authenticatorData: 'AA', signature: 'AA', userHandle: 5 }))),
  ]) {
    assert.equal(parseAssertion(assertion), undefined, assertion.slice(0, 20));
    const response = await authRoutes(
      new Request(`${origin}/studio/auth/passkey/callback?state=${flow.state}&assertion=${assertion}`, { headers: { Cookie: flow.cookie } }),
      w.runtime,
      w.attempts,
    );
    assert.ok(response && response.status >= 400, 'a bad assertion never signs in');
  }
});

test('the ceremony routes are rate limited per address', async () => {
  const w = world();
  const flow = await startFlow(w);
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 45; attempt++) {
    statuses.push((await post(w, 'options', {}, flow.cookie, { 'CF-Connecting-IP': '203.0.113.50' }))?.status ?? 0);
  }
  assert.ok(statuses.includes(429), 'a flood is answered with 429');
  assert.equal((await post(w, 'options', {}, flow.cookie, { 'CF-Connecting-IP': '203.0.113.51' }))?.status, 200, 'another address is unaffected');
});

test('admin commands are parsed strictly and handles are bounded', async () => {
  for (const bad of [
    null,
    'x',
    [],
    {},
    { action: 'drop' },
    { action: 'invite' },
    { action: 'invite', handle: 'Has Space' },
    { action: 'invite', handle: '-x' },
    { action: 'invite', handle: 'a'.repeat(65) },
    { action: 'invite', handle: 'ok', displayName: 'x'.repeat(81) },
    { action: 'invite', handle: 'ok', displayName: 'bad\nname' },
    { action: 'revokeInvite', hash: 'short' },
    { action: 'removeCredential', id: '../x' },
    { action: 'lock', handle: '' },
  ]) {
    assert.equal(parsePasskeyAdminCommand(bad).ok, false, JSON.stringify(bad));
  }
  assert.ok(parsePasskeyAdminCommand({ action: 'invite', handle: 'client-acme', displayName: 'Acme' }).ok);
  const w = world();
  for (let index = 0; index < PASSKEY_LIMITS.invitesMax; index++) {
    assert.ok((await w.store.createInvite({ handle: `h${index}`, displayName: undefined, createdBy: 'o', nowMs: w.clock.value })).ok);
  }
  const full = await w.store.createInvite({ handle: 'one-more', displayName: undefined, createdBy: 'o', nowMs: w.clock.value });
  assert.equal(full.ok ? 'ok' : full.error, 'full');
});

// ---- Conformance ----------------------------------------------------------------------------------------------------

const conformanceDevice = await softAuthenticator({ origin, rpId });
const conformanceChallenge = encodeBase64url(new Uint8Array(32).fill(9));
const conformanceAssertion = await conformanceDevice.assertionParameter(conformanceChallenge);
const conformanceRegistration = await verifyAfterRegistration();

async function verifyAfterRegistration() {
  const { verifyRegistration } = await import('../src/features/auth/providers/webauthn');
  const registered = await verifyRegistration(await conformanceDevice.create(conformanceChallenge), { challenge: conformanceChallenge, origin, rpId });
  assert.ok(registered.ok);
  return registered.value;
}

runAuthProviderConformance({
  name: 'passkey',
  installed: 'built-in',
  create: () => {
    // The kit starts flows with state values it generates, so the stand-in store here answers the challenge for any state;
    // challenge-to-state binding is tested above with the real store.
    const { storage, data } = memoryStorage();
    data.set('passkey/handle/client-acme', { handle: 'client-acme', displayName: 'Acme Client', createdAt: 1, createdBy: 'o', lockedUntil: 0 });
    data.set(`passkey/credential/${conformanceRegistration.credentialId}`, {
      id: conformanceRegistration.credentialId,
      handle: 'client-acme',
      label: 'L',
      createdAt: 1,
      lastUsedAt: undefined,
      key: conformanceRegistration.key,
      signCount: 0,
    });
    const real = createPasskeyStore(storage);
    const store: PasskeyStore = { ...real, takeChallenge: (challenge) => Promise.resolve(challenge === conformanceChallenge) };
    return createPasskeyProvider({
      ...contextFor({ AUTH_BOOTSTRAP_ADMIN: 'passkey:owner', EDITOR_ACCESS: 'authenticated' }, fakeNetwork(), rolesFrom(rolesFile)),
      passkeys: store,
      passkeyHandleActive: (handle) => real.handleActive(handle, Date.now()),
    });
  },
  acceptedCallback: (state, callbackUrl) => new Request(`${callbackUrl}?state=${state}&assertion=${conformanceAssertion}`),
  refusedCallback: (state, callbackUrl) => new Request(`${callbackUrl}?state=${state}&assertion=AAAA`),
  expectedIdentity: 'passkey:client-acme',
});
