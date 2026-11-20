// Goal: Studio's authentication-provider seam holds. GitHub stays the default and behaves as before; another provider
// can be swapped in; and whatever a provider returns, core alone decides identity namespace, sessions, edit policy and
// roles, so a provider cannot widen access or sign anyone in as someone else.
// Method: unit tests of each parser at and past its bound; roles.json compatibility (a bare login is github:<login>);
// session tokens (GitHub's payload unchanged, other providers' signed by core only); the conformance kit run against the
// built-in GitHub provider and a fake one; and hostile providers pushed through the real sign-in flow, which must end in
// a sign-in page and never a session. The workerd end-to-end test is authProviderWorker.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IDENTITY_LIMITS,
  githubIdentity,
  identityKey,
  identityProvider,
  identitySubject,
  parseProviderId,
  parseQualifiedIdentity,
} from '../vendor/stacki/shared/properties/memberIdentity';
import { memberRole, parseProjectRoles, resolveRole, ROLE_LIMITS } from '../vendor/stacki/shared/properties/projectRoles';
import {
  AUTH_LIMITS,
  field,
  parseAliases,
  parsePerson,
  parseRefusal,
  providerEnvironment,
  validateAuthProvider,
  type AuthProvider,
  type Principal,
} from '../src/features/auth/authProvider';
import { createAuthRuntime, mayEdit, mayManage, memberAliases, mintSession, principalFromToken } from '../src/features/auth/authRuntime';
import { signPrincipal, verifyPrincipal } from '../src/features/auth/principalSession';
import { authRoutes } from '../src/features/auth/authRoutes';
import { loginPage } from '../src/features/auth/loginPage';
import { signClaims, signSession, verifySession } from '../src/features/auth/session';
import { createGitHubProvider } from '../src/features/auth/githubProvider';
import { requestPerson } from '../src/features/auth/requestPerson';
import { createFakeProvider } from './fakeAuthProvider';
import { CONFORMANCE, runAuthProviderConformance } from './authProviderConformance';
import { loginAttemptFixture } from './loginAttemptFixture';

const secret = CONFORMANCE.secret;
const unwrap = <T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }): T => {
  assert.ok(result.ok, 'expected ok');
  return result.value;
};

// ---- Identity parsing -------------------------------------------------------------------------------------------

test('identities are provider-qualified and parsed at the boundary', () => {
  for (const good of ['github:octocat', 'email:a@b.com', 'google:1234567890', 'oidc:https://issuer.example/sub/42', 'x1:a']) {
    assert.ok(parseQualifiedIdentity(good).ok, good);
  }
  const email = unwrap(parseQualifiedIdentity('email:a@b.com'));
  assert.equal(identityProvider(email), 'email');
  assert.equal(identitySubject(email), 'a@b.com');
  for (const bad of ['', 'octocat', ':x', 'Email:a@b.com', 'email:', 'email: a', 'email:a,b', 'email:a\nb', '1x:a', 'em ail:a', 'email:\u0000']) {
    assert.equal(parseQualifiedIdentity(bad).ok, false, JSON.stringify(bad));
  }
  for (const notText of [undefined, 1, {}, ['github:a'], true]) {
    assert.equal(parseQualifiedIdentity(notText).ok, false);
  }
});

test('identity lengths are bounded at the limit and one past it', () => {
  const provider = 'p'.repeat(IDENTITY_LIMITS.providerCharsMax);
  assert.ok(parseProviderId(provider).ok);
  assert.equal(parseProviderId(provider + 'p').ok, false);
  const subject = 's'.repeat(IDENTITY_LIMITS.subjectCharsMax);
  assert.ok(parseQualifiedIdentity(`p:${subject}`).ok);
  assert.equal(parseQualifiedIdentity(`p:${subject}s`).ok, false);
  assert.ok(parseQualifiedIdentity(`${provider}:${subject}`).ok, 'the longest identity fits the overall bound');
  assert.equal(`${provider}:${subject}`.length, IDENTITY_LIMITS.identityCharsMax);
});

test('only GitHub subjects compare case-insensitively, and a bare login is a GitHub login', () => {
  assert.equal(identityKey('Octocat'), 'github:octocat');
  assert.equal(identityKey('github:OctoCat'), 'github:octocat');
  assert.equal(identityKey('email:A@B.com'), 'email:A@B.com');
  assert.notEqual(identityKey('email:a@b.com'), identityKey('email:A@b.com'));
  assert.ok(githubIdentity('octocat').ok);
});

// ---- roles.json -------------------------------------------------------------------------------------------------

const rolesFile = (adminMembers: readonly string[], clientMembers: readonly string[] = []) =>
  parseProjectRoles({
    version: 1,
    defaultRole: 'client',
    roles: [
      { id: 'admin', name: 'Admin', members: adminMembers },
      { id: 'client', name: 'Client', members: clientMembers },
    ],
  });

test('a bare login in roles.json still means github:<login>: no migration', () => {
  const roles = rolesFile(['Owner'], ['guest']);
  for (const same of ['owner', 'Owner', 'github:owner', 'github:OWNER']) {
    assert.equal(memberRole(roles, same)?.id, 'admin', same);
    assert.equal(resolveRole(roles, same, 'default').id, 'admin', same);
  }
  assert.equal(memberRole(roles, 'github:guest')?.id, 'client');
  assert.equal(memberRole(roles, 'email:owner'), undefined, 'another provider cannot borrow a GitHub login');
  assert.equal(memberRole(roles, 'owner')?.id, 'admin', 'a bare lookup is still a GitHub lookup');
});

test('qualified members match their provider only, exactly, and aliases match in the same namespace', () => {
  const roles = rolesFile(['owner', 'email:boss@example.test'], ['google:42']);
  assert.equal(memberRole(roles, 'email:boss@example.test')?.id, 'admin');
  assert.equal(memberRole(roles, 'email:Boss@example.test'), undefined, 'subjects of other providers compare exactly');
  assert.equal(memberRole(roles, 'google:42')?.id, 'client');
  assert.equal(memberRole(roles, 'email:someone@example.test', ['google:42'])?.id, 'client', 'an alias matches');
  assert.equal(resolveRole(roles, 'email:nobody@example.test', 'default', []).id, 'client', 'no member falls back to the default role');
  assert.deepEqual(roles.roles[0]?.members, ['owner', 'email:boss@example.test'], 'a bare login is kept as written');
});

test('roles.json members reject malformed identities and keep the member bound', () => {
  for (const bad of ['email:', ':a', 'Bad:a', 'github:-bad', 'github:a b', 'email:a,b']) {
    assert.throws(() => rolesFile([bad, 'owner']), /./, bad);
  }
  const many = Array.from({ length: ROLE_LIMITS.membersMax + 1 }, (_, index) => `email:u${index}@example.test`);
  assert.throws(() => rolesFile(many));
  assert.ok(rolesFile(many.slice(0, ROLE_LIMITS.membersMax)));
  assert.throws(
    () =>
      memberRole(
        rolesFile(['owner']),
        'owner',
        Array.from({ length: ROLE_LIMITS.aliasesMax + 1 }, (_, i) => `x:${i}`),
      ),
    /bounded number of aliases/,
  );
});

// ---- Output parsing: a provider's answer is untrusted ------------------------------------------------------------

const fakeId = unwrap(parseProviderId('fake'));
const githubId = unwrap(parseProviderId('github'));

test('parsePerson accepts a complete person and keeps only the known fields', () => {
  const person = unwrap(
    parsePerson(
      { identity: 'fake:a', name: ' Ann ', email: 'a@x.test', avatarUrl: 'https://i.test/a.png', admin: true, roles: ['admin'], github: { id: 1, login: 'x' } },
      fakeId,
    ),
  );
  assert.deepEqual(person, { identity: 'fake:a', name: 'Ann', email: 'a@x.test', avatarUrl: 'https://i.test/a.png' });
});

test('parsePerson refuses every hostile or malformed shape', () => {
  const base = { identity: 'fake:a', name: 'Ann' };
  const refused: readonly (readonly [string, unknown])[] = [
    ['no value', undefined],
    ['text', 'fake:a'],
    ['another provider’s namespace', { ...base, identity: 'other:a' }],
    ['an impersonated GitHub person', { ...base, identity: 'github:owner' }],
    ['no identity', { name: 'Ann' }],
    ['unqualified identity', { ...base, identity: 'a' }],
    ['no name', { identity: 'fake:a' }],
    ['blank name', { ...base, name: '   ' }],
    ['control characters in the name', { ...base, name: 'A\u0000b' }],
    ['a name past the bound', { ...base, name: 'n'.repeat(AUTH_LIMITS.personNameCharsMax + 1) }],
    ['a non-text email', { ...base, email: 5 }],
    ['an email past the bound', { ...base, email: 'a'.repeat(AUTH_LIMITS.emailCharsMax) + '@x' }],
    ['an email that is not an address', { ...base, email: 'nope' }],
    ['an http avatar', { ...base, avatarUrl: 'http://i.test/a.png' }],
    ['a javascript avatar', { ...base, avatarUrl: 'javascript:alert(1)' }],
    ['an avatar past the bound', { ...base, avatarUrl: 'https://i.test/' + 'a'.repeat(AUTH_LIMITS.avatarUrlCharsMax) }],
  ];
  for (const [label, input] of refused) {
    assert.equal(parsePerson(input, fakeId).ok, false, label);
  }
});

test('only the GitHub provider names a GitHub person, and the identity must match the profile', () => {
  const good = { identity: 'github:octocat', name: 'octocat', github: { id: 7, login: 'octocat' } };
  assert.deepEqual(unwrap(parsePerson(good, githubId)).github, { id: 7, login: 'octocat' });
  assert.equal(parsePerson({ ...good, github: undefined }, githubId).ok, false, 'a github person needs the numeric id');
  assert.equal(parsePerson({ ...good, github: { id: 7, login: 'other' } }, githubId).ok, false, 'identity and login must agree');
  assert.equal(parsePerson({ ...good, github: { id: 0, login: 'octocat' } }, githubId).ok, false);
  assert.equal(parsePerson(good, fakeId).ok, false, 'a github identity from another provider');
});

test('aliases keep only valid, distinct identities in the provider namespace, at the bound', () => {
  const primary = unwrap(parseQualifiedIdentity('fake:a'));
  const many = Array.from({ length: 40 }, (_, index) => `fake:alias${index}`);
  assert.deepEqual(parseAliases(['fake:b', 'fake:b', 'fake:a', 'github:owner', 'other:x', 7, 'bad', 'fake:c'], fakeId, primary), ['fake:b', 'fake:c']);
  assert.equal(parseAliases(many, fakeId, primary).length, AUTH_LIMITS.aliasesMax);
  assert.deepEqual(parseAliases('fake:b', fakeId, primary), []);
  assert.deepEqual(parseAliases(undefined, fakeId, primary), []);
});

test('refusals are cleaned and bounded', () => {
  const now = Date.now();
  assert.deepEqual(parseRefusal({ problem: 'access' }, now), { problem: 'access' });
  assert.deepEqual(parseRefusal({ problem: 'nope' }, now), { problem: 'unavailable' });
  assert.deepEqual(parseRefusal(undefined, now), { problem: 'unavailable' });
  assert.equal(parseRefusal({ problem: 'expired', reference: '<b>x</b>-1' }, now).reference, 'bxb-1');
  assert.equal(parseRefusal({ problem: 'expired', reference: 'r'.repeat(500) }, now).reference?.length, AUTH_LIMITS.referenceCharsMax);
  assert.equal(parseRefusal({ problem: 'rate-limit', retryAtMs: now + 10 * AUTH_LIMITS.retryWaitMsMax }, now).retryAtMs, now + AUTH_LIMITS.retryWaitMsMax);
  assert.equal(parseRefusal({ problem: 'rate-limit', retryAtMs: 'soon' }, now).retryAtMs, undefined);
});

test('a provider must have the interface, a valid id, and may not take the name github', () => {
  const good = createFakeProvider();
  assert.ok(validateAuthProvider(good, 'custom').ok);
  assert.equal(validateAuthProvider({ ...good, id: 'github' }, 'custom').ok, false, 'github is reserved for the built-in provider');
  assert.ok(validateAuthProvider({ ...good, id: 'github' }, 'built-in').ok);
  for (const [label, broken] of [
    ['no begin', { ...good, begin: undefined }],
    ['no identify', { ...good, identify: 'x' }],
    ['bad id', { ...good, id: 'Fake Login' }],
    ['no display name', { ...good, displayName: '' }],
    ['a long display name', { ...good, displayName: 'n'.repeat(AUTH_LIMITS.displayNameCharsMax + 1) }],
    ['a canEdit that is not a function', { ...good, canEdit: true }],
    ['null', null],
    ['text', 'provider'],
  ] as const) {
    assert.equal(validateAuthProvider(broken, 'custom').ok, false, label);
  }
});

test('the environment a provider sees never holds core credentials', () => {
  const view = providerEnvironment({
    SESSION_SECRET: 's'.repeat(40),
    CONTAINER_TOKEN: 't',
    GITHUB_PRIVATE_KEY: 'k',
    PREVIEW: {},
    DRAFTS: {},
    MY_IDP_SECRET: 'mine',
    STUDIO_ORIGIN: 'https://x',
  });
  assert.deepEqual(Object.keys(view).sort(), ['MY_IDP_SECRET', 'STUDIO_ORIGIN']);
});

// ---- Sessions: core signs, the GitHub payload is unchanged -------------------------------------------------------

test('a GitHub session keeps the payload it always had and verifies both ways', async () => {
  const github = { identity: unwrap(parseQualifiedIdentity('github:octocat')), name: 'octocat', github: { id: 7, login: 'octocat' } };
  const expires = Date.now() + 60_000;
  const token = unwrap(await signPrincipal(github, 'studio', expires, secret));
  assert.equal(token, await signSession({ id: 7, login: 'octocat', expires, audience: 'studio' }, secret), 'byte-identical to the pre-provider token');
  assert.deepEqual(await verifySession(token, secret, 'studio'), { id: 7, login: 'octocat', expires, audience: 'studio' });
  const principal = await verifyPrincipal(token, secret, 'studio');
  assert.equal(principal?.identity, 'github:octocat');
  assert.deepEqual(principal?.github, { id: 7, login: 'octocat' });
  assert.equal(await verifyPrincipal(token, secret, 'preview'), undefined);
});

test('another provider’s session round-trips, and no legacy verifier or other secret accepts it', async () => {
  const person = unwrap(parsePerson({ identity: 'email:a@b.test', name: 'Ann', email: 'a@b.test' }, unwrap(parseProviderId('email'))));
  const expires = Date.now() + 60_000;
  const token = unwrap(await signPrincipal(person, 'studio', expires, secret));
  assert.deepEqual(await verifyPrincipal(token, secret, 'studio'), { ...person, expires });
  assert.equal(await verifySession(token, secret, 'studio'), undefined, 'the GitHub verifier never accepts it');
  assert.equal(await verifyPrincipal(token, secret + 'x', 'studio'), undefined);
  assert.equal(await verifyPrincipal(token + 'x', secret, 'studio'), undefined);
  assert.equal(await verifyPrincipal(token, secret, 'preview'), undefined);
  const expired = unwrap(await signPrincipal(person, 'studio', Date.now() + 5, secret));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await verifyPrincipal(expired, secret, 'studio'), undefined);
});

test('a provider-shaped token can never name a GitHub person, and a GitHub person needs GitHub’s id', async () => {
  const forged = await signClaims({ v: 2, identity: 'github:owner', name: 'owner', audience: 'studio', expires: Date.now() + 60_000 }, secret);
  assert.equal(await verifyPrincipal(forged, secret, 'studio'), undefined);
  const noProfile = await signPrincipal({ identity: unwrap(parseQualifiedIdentity('github:owner')), name: 'owner' }, 'studio', Date.now() + 60_000, secret);
  assert.equal(noProfile.ok, false);
  const wrongVersion = await signClaims({ v: 3, identity: 'email:a@b.test', name: 'A', audience: 'studio', expires: Date.now() + 60_000 }, secret);
  assert.equal(await verifyPrincipal(wrongVersion, secret, 'studio'), undefined);
});

// ---- Runtime policy ---------------------------------------------------------------------------------------------

function fakeRuntime(provider: AuthProvider = createFakeProvider(), editorAccess?: string) {
  return createAuthRuntime({ provider, installed: 'custom', origin: CONFORMANCE.origin, secret, editorAccess });
}
const person = (identity: string): Principal => ({ ...unwrap(parsePerson({ identity, name: 'N' }, fakeId)), expires: Date.now() + 60_000 });

test('the provider’s edit policy decides, and only an exact true counts', async () => {
  const runtime = fakeRuntime();
  assert.equal(await mayEdit(runtime, person('fake:alice'), 'cached'), true);
  assert.equal(await mayEdit(runtime, person('fake:mallory'), 'fresh'), false);
  const sloppy = fakeRuntime({ ...createFakeProvider(), canEdit: () => Promise.resolve(1 as never) });
  assert.equal(await mayEdit(sloppy, person('fake:mallory'), 'cached'), false, 'a truthy non-boolean is not permission');
});

test('a provider with no edit policy admits nobody unless the owner chose authenticated', async () => {
  const { canEdit: _canEdit, ...withoutPolicy } = createFakeProvider();
  assert.equal(await mayEdit(fakeRuntime(withoutPolicy), person('fake:alice'), 'cached'), false);
  assert.equal(
    await mayEdit(fakeRuntime(withoutPolicy, 'repository'), person('fake:alice'), 'cached'),
    false,
    'GitHub’s modes mean nothing to another provider',
  );
  assert.equal(await mayEdit(fakeRuntime(withoutPolicy, 'authenticated'), person('fake:alice'), 'cached'), true);
});

test('managing the instance is the provider’s call and denied by default', async () => {
  assert.equal(await mayManage(fakeRuntime(), person('fake:alice')), true);
  assert.equal(await mayManage(fakeRuntime(), person('fake:bob')), false);
  const { canManage: _canManage, ...withoutManage } = createFakeProvider();
  assert.equal(await mayManage(fakeRuntime(withoutManage), person('fake:alice')), false);
});

test('core asks the provider only about its own people, and a session from a previous provider proves nothing', async () => {
  const runtime = fakeRuntime();
  await assert.rejects(
    () => mayEdit(runtime, { ...person('fake:alice'), identity: unwrap(parseQualifiedIdentity('github:alice')) }, 'cached'),
    /active provider/,
  );
  const githubToken = unwrap(
    await signPrincipal(
      { identity: unwrap(parseQualifiedIdentity('github:octocat')), name: 'o', github: { id: 7, login: 'octocat' } },
      'studio',
      Date.now() + 60_000,
      secret,
    ),
  );
  assert.equal(await principalFromToken(runtime, githubToken, 'studio'), undefined, 'an old GitHub session after switching to another provider');
  const mine = await mintSession(runtime, person('fake:alice'), 'studio', Date.now() + 60_000);
  assert.equal((await principalFromToken(runtime, mine, 'studio'))?.identity, 'fake:alice');
  await assert.rejects(
    () => mintSession(runtime, { ...person('fake:alice'), identity: unwrap(parseQualifiedIdentity('github:alice')) }, 'studio', Date.now() + 60_000),
    /active provider/,
  );
});

test('aliases come only from the provider’s own namespace', () => {
  assert.deepEqual(memberAliases(fakeRuntime(), person('fake:alice')), ['fake:alice-alias']);
  const hostile = fakeRuntime({ ...createFakeProvider(), memberKeys: () => ['github:owner', 'fake:x', 'other:y', 'nonsense'] });
  assert.deepEqual(memberAliases(hostile, person('fake:alice')), ['fake:x'], 'an alias can never reach another provider’s people');
  assert.deepEqual(memberAliases(fakeRuntime({ ...createFakeProvider(), memberKeys: undefined as never }), person('fake:alice')), []);
});

// ---- The container's reading of who is asking -----------------------------------------------------------------

test('the container reads the qualified identity, falls back to the GitHub header, and fails closed', () => {
  const headers = (values: Record<string, string>) => ({ headers: values });
  assert.equal(
    requestPerson(
      headers({ 'x-studio-identity': 'email:a@b.test', 'x-studio-name': encodeURIComponent('Zoë Ann'), 'x-studio-aliases': 'email:b@b.test,github:owner,bad' }),
    ).name,
    'Zoë Ann',
  );
  assert.deepEqual(requestPerson(headers({ 'x-studio-identity': 'email:a@b.test', 'x-studio-aliases': 'email:b@b.test,bad' })).aliases, ['email:b@b.test']);
  assert.equal(requestPerson(headers({ 'x-studio-user': 'Octocat' })).identity, 'github:Octocat');
  assert.equal(
    requestPerson(headers({ 'x-studio-identity': 'github:octocat', 'x-studio-user': 'someone-else' })).identity,
    'github:octocat',
    'the identity header wins',
  );
  for (const bad of [
    {},
    { 'x-studio-user': '' },
    { 'x-studio-user': 'a b' },
    { 'x-studio-identity': 'octocat' },
    { 'x-studio-identity': 'github:a b' },
    { 'x-studio-identity': 'x:' + 's'.repeat(300) },
  ]) {
    assert.throws(() => requestPerson(headers(bad)), /./, JSON.stringify(bad));
  }
});

// ---- The conformance kit: GitHub default, and a swapped-in provider ---------------------------------------------

const githubConfig = {
  GITHUB_CLIENT_ID: 'client',
  GITHUB_CLIENT_SECRET: 'client-secret',
  SESSION_SECRET: secret,
  EDITOR_GITHUB_IDS: '',
  STUDIO_ORIGIN: CONFORMANCE.origin,
  GITHUB_APP_ID: '',
  GITHUB_INSTALLATION_ID: '',
  GITHUB_PRIVATE_KEY: '',
  GITHUB_REPOSITORY: '',
  GITHUB_BRANCH: '',
};

runAuthProviderConformance({
  name: 'built-in GitHub provider',
  installed: 'built-in',
  create: () => createGitHubProvider(githubConfig, () => Promise.resolve(true)),
  acceptedCallback: (state, callbackUrl) => new Request(`${callbackUrl}?state=${state}&code=good`),
  refusedCallback: (state, callbackUrl) => new Request(`${callbackUrl}?state=${state}&code=bad`),
  expectedIdentity: 'github:octocat',
  prepare: (context) => {
    context.mock.method(globalThis, 'fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const target = String(input);
      if (target.endsWith('/login/oauth/access_token')) {
        const body = typeof init?.body === 'string' ? init.body : '';
        return Promise.resolve(body.includes('"code":"good"') ? Response.json({ access_token: 'token' }) : Response.json({ error: 'bad_verification_code' }));
      }
      return Promise.resolve(Response.json({ id: 7, login: 'octocat' }));
    });
  },
});

runAuthProviderConformance({
  name: 'swapped-in fake provider',
  installed: 'custom',
  create: createFakeProvider,
  acceptedCallback: (state, callbackUrl) => new Request(`${callbackUrl}?state=${state}&token=alice`),
  refusedCallback: (state, callbackUrl) => new Request(`${callbackUrl}?state=${state}&token=nobody`),
  expectedIdentity: 'fake:alice',
});

// ---- Hostile providers through the real flow --------------------------------------------------------------------

async function signIn(provider: AuthProvider, query: string, editorAccess?: string) {
  const runtime = createAuthRuntime({ provider, installed: 'custom', origin: CONFORMANCE.origin, secret, editorAccess });
  const attempts = loginAttemptFixture().create();
  const started = await authRoutes(new Request(CONFORMANCE.origin + '/studio/auth/login'), runtime, attempts);
  const cookie =
    started?.headers
      .getSetCookie()
      .find((value) => value.startsWith('__Host-studio-state='))
      ?.split(';')[0] ?? '';
  const claims = await verifySession(cookie.slice('__Host-studio-state='.length), secret, 'login');
  assert.ok(claims, 'a state was issued');
  const response = await authRoutes(
    new Request(`${CONFORMANCE.origin}/studio/auth/callback?state=${claims.login}&${query}`, { headers: { Cookie: cookie } }),
    runtime,
    attempts,
  );
  assert.ok(response);
  const session = response.headers.getSetCookie().find((value) => /^__Host-studio=[^;]/.test(value));
  return { started, response, session };
}

test('a provider that answers with another person’s identity signs nobody in', async (context) => {
  context.mock.method(console, 'error', () => {});
  for (const hostile of ['github:owner', 'other:alice', 'fake:alice\nfake:bob', 'alice', '']) {
    const outcome = await signIn(
      { ...createFakeProvider(), identify: () => Promise.resolve({ ok: true, value: { identity: hostile, name: 'x' } }) },
      'token=alice',
    );
    assert.equal(outcome.session, undefined, JSON.stringify(hostile));
    assert.equal(outcome.response.status, 503);
  }
});

test('a provider that returns the wrong shape, throws, or hangs a getter signs nobody in', async (context) => {
  context.mock.method(console, 'error', () => {});
  const trap = {
    ok: true,
    get value(): never {
      throw new Error('boom');
    },
  };
  const cases: readonly [string, () => Promise<unknown>][] = [
    ['undefined', () => Promise.resolve(undefined)],
    ['text', () => Promise.resolve('ok')],
    ['ok without a value', () => Promise.resolve({ ok: true })],
    ['a throwing getter', () => Promise.resolve(trap)],
    ['a throw', () => Promise.reject(new Error('upstream'))],
    ['a refusal with a bad problem', () => Promise.resolve({ ok: false, error: { problem: 'god-mode' } })],
  ];
  for (const [label, identify] of cases) {
    const outcome = await signIn({ ...createFakeProvider(), identify: identify as AuthProvider['identify'] }, 'token=alice');
    assert.equal(outcome.session, undefined, label);
    assert.ok(outcome.response.status >= 400, label);
    assert.ok((await outcome.response.text()).includes('href="/studio/auth/login"'), label);
  }
});

test('a verified person the provider’s policy rejects gets no session', async () => {
  const outcome = await signIn(createFakeProvider(), 'token=mallory');
  assert.equal(outcome.session, undefined);
  assert.equal(outcome.response.status, 403);
  const open = await signIn({ ...createFakeProvider(), canEdit: undefined as never }, 'token=mallory');
  assert.equal(open.session, undefined, 'no policy and no EDITOR_ACCESS=authenticated admits nobody');
  const allowed = await signIn({ ...createFakeProvider(), canEdit: undefined as never }, 'token=mallory', 'authenticated');
  assert.ok(allowed.session);
});

test('a provider cannot set cookies or redirect somewhere unsafe from begin, and cannot mint the session cookie', async (context) => {
  context.mock.method(console, 'error', () => {});
  const runtime = (begin: AuthProvider['begin']) =>
    createAuthRuntime({ provider: { ...createFakeProvider(), begin }, installed: 'custom', origin: CONFORMANCE.origin, secret, editorAccess: undefined });
  const start = (begin: AuthProvider['begin']) =>
    authRoutes(new Request(CONFORMANCE.origin + '/studio/auth/login'), runtime(begin), loginAttemptFixture().create());
  const sneaky = await start(() => {
    const headers = new Headers({ Location: 'https://idp.example.test/x', 'Cache-Control': 'public, max-age=999' });
    headers.append('Set-Cookie', '__Host-studio=forged; Path=/');
    headers.append('Set-Cookie', 'tracker=1');
    return Promise.resolve(new Response(null, { status: 302, headers }));
  });
  assert.deepEqual(
    sneaky?.headers.getSetCookie().map((value) => value.split('=')[0]),
    ['__Host-studio-state'],
    'the provider’s cookies are dropped',
  );
  assert.equal(sneaky?.headers.get('Cache-Control'), 'no-store');
  for (const location of ['javascript:alert(1)', 'data:text/html,x', 'http://evil.example/']) {
    const unsafe = await start(() => Promise.resolve(new Response(null, { status: 302, headers: { Location: location } })));
    assert.equal(unsafe?.status, 503, location);
    assert.equal(unsafe?.headers.get('Location'), null, location);
  }
  assert.equal((await start(() => Promise.resolve(new Response(null, { status: 101 }))))?.status, 503);
  assert.equal((await start(() => Promise.reject(new Error('down'))))?.status, 503);
  assert.equal((await start(() => Promise.resolve('not a response' as never)))?.status, 503);
});

test('extra provider routes need the Studio origin, a live sign-in state, and cannot set cookies', async () => {
  const handle: NonNullable<AuthProvider['handle']> = (request, flow) =>
    Promise.resolve(new URL(request.url).pathname.endsWith('/send') ? new Response(flow.state, { headers: { 'Set-Cookie': 'x=1' } }) : undefined);
  const runtime = createAuthRuntime({
    provider: { ...createFakeProvider(), handle },
    installed: 'custom',
    origin: CONFORMANCE.origin,
    secret,
    editorAccess: undefined,
  });
  const attempts = loginAttemptFixture().create();
  const started = await authRoutes(new Request(CONFORMANCE.origin + '/studio/auth/login'), runtime, attempts);
  const cookie = started?.headers.getSetCookie()[0]?.split(';')[0] ?? '';
  const url = CONFORMANCE.origin + '/studio/auth/provider/send';
  const crossSite = await authRoutes(new Request(url, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.example' } }), runtime, attempts);
  assert.equal(crossSite?.status, 403);
  const stateless = await authRoutes(new Request(url, { method: 'POST', headers: { Origin: CONFORMANCE.origin } }), runtime, attempts);
  assert.equal(stateless?.status, 403);
  const answered = await authRoutes(new Request(url, { method: 'POST', headers: { Cookie: cookie, Origin: CONFORMANCE.origin } }), runtime, attempts);
  assert.equal(answered?.status, 200);
  assert.deepEqual(answered?.headers.getSetCookie(), []);
  assert.equal((await answered?.text())?.length, 36, 'the provider got the state core issued');
  assert.equal(
    await authRoutes(
      new Request(CONFORMANCE.origin + '/studio/auth/provider/other', { method: 'POST', headers: { Cookie: cookie, Origin: CONFORMANCE.origin } }),
      runtime,
      attempts,
    ),
    undefined,
  );
  const plain = createAuthRuntime({ provider: createFakeProvider(), installed: 'custom', origin: CONFORMANCE.origin, secret, editorAccess: undefined });
  assert.equal(
    await authRoutes(new Request(url, { method: 'POST', headers: { Cookie: cookie, Origin: CONFORMANCE.origin } }), plain, attempts),
    undefined,
    'no handler, no route',
  );
});

// ---- The sign-in page ------------------------------------------------------------------------------------------

test('the sign-in page says GitHub by default and speaks neutrally only for an installed provider', async () => {
  const github = await loginPage('access', 403).text();
  assert.ok(github.includes('Sign in with GitHub'));
  assert.ok(github.includes('Write access to this repository'));
  assert.ok(github.includes('<svg width="20"'), 'the GitHub mark');
  const custom = await loginPage('access', 403, '', 0, undefined, 'Fake Login').text();
  assert.ok(custom.includes('Continue with Fake Login'));
  assert.equal(custom.includes('GitHub'), false, 'no GitHub name or mark on another provider’s page');
  assert.equal(custom.includes('<svg width="20"'), false);
  const hostile = await loginPage(undefined, 200, '', 0, undefined, '<img src=x onerror=alert(1)>').text();
  assert.equal(hostile.includes('<img src=x'), false, 'the provider name is escaped');
  const german = await loginPage(undefined, 200, '', 0, 'de', 'Fake Login').text();
  assert.ok(german.includes('Weiter mit Fake Login'));
});

test('field() reads a property as unknown from untrusted output', () => {
  assert.equal(field({ a: 1 }, 'a'), 1);
  assert.equal(field({}, 'missing'), undefined);
});
