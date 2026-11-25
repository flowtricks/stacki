// Goal: the built-in providers' configuration contract and edit policy behave as documented, including on hostile input.
// Method: table tests of AUTH_PROVIDER and each provider's variables (valid, missing, malformed, over the bound); the edit
// policy against a fake roles source for every precedence rule (roles file, allow-lists, bootstrap admin, EDITOR_ACCESS);
// the roles source's cache, stale answer and fail-closed behaviour; and the rate limiter's window and ceiling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  authConfigProblems,
  parseAuthProviderId,
  parseGoogleConfig,
  parseOidcConfig,
  parsePasskeyConfig,
  AUTH_CONFIG_LIMITS,
} from '../src/features/auth/providers/authConfig';
import { createEditorPolicy } from '../src/features/auth/providers/editorPolicy';
import { createRolesSource, parseRolesState, ROLES_SOURCE_LIMITS, type RolesSource, type RolesState } from '../src/features/auth/providers/rolesSource';
import { createRateLimiter, RATE_LIMITS, clientKey } from '../src/features/auth/providers/rateLimit';
import { parseQualifiedIdentity } from '../vendor/stacki/shared/properties/memberIdentity';
import type { Principal } from '../src/features/auth/authProvider';

const google = { GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'secret', AUTH_BOOTSTRAP_ADMIN: 'google:Me@Example.com' };
const oidc = { OIDC_ISSUER: 'https://idp.example.test/realms/a', OIDC_CLIENT_ID: 'studio', AUTH_BOOTSTRAP_ADMIN: 'oidc:me@example.com' };

test('AUTH_PROVIDER defaults to github and rejects unknown values loudly', () => {
  for (const absent of [undefined, '']) {
    const parsed = parseAuthProviderId(absent);
    assert.ok(parsed.ok);
    assert.equal(parsed.value, 'github');
  }
  for (const id of ['google', 'oidc', 'passkey', 'github']) {
    assert.ok(parseAuthProviderId(id).ok, id);
  }
  for (const bad of ['Google', 'saml', 'google ', 7, null, {}]) {
    const parsed = parseAuthProviderId(bad);
    assert.equal(parsed.ok, false, String(bad));
  }
  assert.match(authConfigProblems({ AUTH_PROVIDER: 'saml' })[0] ?? '', /unknown/);
  assert.deepEqual(authConfigProblems({}), [], 'GitHub needs nothing here');
});

test('google configuration: required variables, normalised lists, namespace of the bootstrap admin', () => {
  const parsed = parseGoogleConfig({ ...google, AUTH_ALLOWED_EMAILS: ' A@B.com, a@b.com ,c@d.org', AUTH_ALLOWED_DOMAINS: 'Example.com' });
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value.policy.allowedEmails, ['a@b.com', 'c@d.org']);
  assert.deepEqual(parsed.value.policy.allowedDomains, ['example.com']);
  assert.equal(parsed.value.policy.bootstrapAdmin, 'google:me@example.com');
  const cases: readonly (readonly [Record<string, unknown>, RegExp])[] = [
    [{ ...google, GOOGLE_CLIENT_ID: '' }, /GOOGLE_CLIENT_ID/],
    [{ ...google, GOOGLE_CLIENT_SECRET: undefined }, /GOOGLE_CLIENT_SECRET/],
    [{ ...google, AUTH_BOOTSTRAP_ADMIN: undefined }, /AUTH_BOOTSTRAP_ADMIN is required/],
    [{ ...google, AUTH_BOOTSTRAP_ADMIN: 'github:me' }, /must start with "google:"/],
    [{ ...google, AUTH_BOOTSTRAP_ADMIN: 'me@example.com' }, /not an identity/],
    [{ ...google, AUTH_ALLOWED_EMAILS: 'not-an-email' }, /AUTH_ALLOWED_EMAILS/],
    [{ ...google, AUTH_ALLOWED_DOMAINS: 'localhost' }, /AUTH_ALLOWED_DOMAINS/],
    [
      { ...google, AUTH_ALLOWED_DOMAINS: Array.from({ length: AUTH_CONFIG_LIMITS.allowedDomainsMax + 1 }, (_, index) => `d${index}.example.com`).join(',') },
      /more than/,
    ],
    [{ ...google, GOOGLE_CLIENT_ID: 'has space' }, /GOOGLE_CLIENT_ID/],
  ];
  for (const [environment, expected] of cases) {
    const result = parseGoogleConfig(environment);
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error.join(' '), expected);
  }
});

test('oidc configuration: https issuer, scopes include openid, public clients allowed, label bounded', () => {
  const parsed = parseOidcConfig(oidc);
  assert.ok(parsed.ok);
  assert.equal(parsed.value.scopes, 'openid email profile');
  assert.equal(parsed.value.buttonName, 'SSO');
  assert.equal(parsed.value.clientSecret, undefined, 'no secret means a public client with PKCE');
  const cases: readonly (readonly [Record<string, unknown>, RegExp])[] = [
    [{ ...oidc, OIDC_ISSUER: undefined }, /OIDC_ISSUER is required/],
    [{ ...oidc, OIDC_ISSUER: 'http://idp.example.test' }, /https/],
    [{ ...oidc, OIDC_ISSUER: 'https://idp.example.test/?x=1' }, /query/],
    [{ ...oidc, OIDC_ISSUER: 'https://user:pw@idp.example.test' }, /credentials/],
    [{ ...oidc, OIDC_ISSUER: 'not a url' }, /https URL/],
    [{ ...oidc, OIDC_CLIENT_ID: '' }, /OIDC_CLIENT_ID/],
    [{ ...oidc, OIDC_SCOPES: 'email profile' }, /openid/],
    [{ ...oidc, OIDC_SCOPES: 'openid "bad"' }, /OIDC_SCOPES/],
    [{ ...oidc, OIDC_NAME: 'x'.repeat(AUTH_CONFIG_LIMITS.buttonNameCharsMax + 1) }, /OIDC_NAME/],
    [{ ...oidc, OIDC_NAME: 'bad\nname' }, /OIDC_NAME/],
    [{ ...oidc, AUTH_BOOTSTRAP_ADMIN: 'google:me@example.com' }, /must start with "oidc:"/],
  ];
  for (const [environment, expected] of cases) {
    const result = parseOidcConfig(environment);
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error.join(' '), expected);
  }
  const named = parseOidcConfig({ ...oidc, OIDC_NAME: 'Okta', OIDC_CLIENT_SECRET: 's', OIDC_SCOPES: 'openid groups' });
  assert.ok(named.ok);
  assert.equal(named.value.buttonName, 'Okta');
});

test('passkey configuration needs only a bootstrap admin in its own namespace', () => {
  const code = 'a-setup-code-of-sixteen-plus';
  assert.ok(parsePasskeyConfig({ AUTH_BOOTSTRAP_ADMIN: 'passkey:owner', AUTH_SETUP_CODE: code }).ok);
  assert.equal(parsePasskeyConfig({ AUTH_BOOTSTRAP_ADMIN: 'passkey:owner' }).ok, false, 'the setup code is required');
  for (const bad of ['short', 'has a space 123456789', 'x'.repeat(201)]) {
    assert.equal(parsePasskeyConfig({ AUTH_BOOTSTRAP_ADMIN: 'passkey:owner', AUTH_SETUP_CODE: bad }).ok, false, bad.slice(0, 10));
  }
  assert.equal(parsePasskeyConfig({ AUTH_BOOTSTRAP_ADMIN: 'passkey:Not Valid', AUTH_SETUP_CODE: code }).ok, false);
  assert.equal(parsePasskeyConfig({ AUTH_SETUP_CODE: code }).ok, false);
  assert.equal(parsePasskeyConfig({ AUTH_BOOTSTRAP_ADMIN: 'google:me@example.com', AUTH_SETUP_CODE: code }).ok, false);
  assert.deepEqual(authConfigProblems({ AUTH_PROVIDER: 'passkey', AUTH_BOOTSTRAP_ADMIN: 'passkey:owner', AUTH_SETUP_CODE: code }), []);
  assert.ok(authConfigProblems({ AUTH_PROVIDER: 'google' }).length >= 3, 'every missing google variable is reported');
});

function principal(identity: string, email?: string): Principal {
  const parsed = parseQualifiedIdentity(identity);
  assert.ok(parsed.ok);
  return { identity: parsed.value, name: 'N', ...(email === undefined ? {} : { email }), expires: Date.now() + 60_000 };
}

function source(state: RolesState): RolesSource {
  return { read: () => Promise.resolve(state) };
}

const rolesFile = (admin: readonly string[], editor: readonly string[]) =>
  parseRolesState(
    JSON.stringify({
      version: 1,
      roles: [
        { id: 'admin', name: 'Admin', members: admin },
        { id: 'client', name: 'Client', members: editor },
      ],
    }),
  );

test('edit policy: roles.json is the authority, allow-lists add default-role editors, bootstrap is a fallback', async () => {
  const bootstrap = principal('google:me@example.com', 'me@example.com');
  const policy = { bootstrapAdmin: bootstrap.identity, editorAccess: 'repository', allowedEmails: ['friend@x.org'], allowedDomains: ['corp.test'] };
  const withFile = createEditorPolicy({ policy, roles: source(rolesFile(['google:boss@corp.test'], ['google:ed@elsewhere.org'])) });
  assert.equal(await withFile.canEdit(principal('google:boss@corp.test'), 'fresh'), true, 'an admin member');
  assert.equal(await withFile.canEdit(principal('google:ed@elsewhere.org'), 'cached'), true, 'a client member');
  assert.equal(await withFile.canEdit(principal('google:friend@x.org', 'friend@x.org'), 'cached'), true, 'an allow-listed email');
  assert.equal(await withFile.canEdit(principal('google:x@corp.test', 'x@corp.test'), 'cached'), true, 'an allow-listed domain');
  assert.equal(await withFile.canEdit(principal('google:stranger@x.org', 'stranger@x.org'), 'cached'), false);
  assert.equal(await withFile.canEdit(principal('google:corp.test'), 'cached'), false, 'a subject is not an email');
  assert.equal(await withFile.canEdit(bootstrap, 'cached'), false, 'once roles.json lists admins, the bootstrap admin is just a person');
  assert.equal(await withFile.canManage(principal('google:boss@corp.test')), true);
  assert.equal(await withFile.canManage(principal('google:ed@elsewhere.org')), false, 'only the admin role manages');
  assert.equal(await withFile.canManage(principal('google:x@corp.test', 'x@corp.test')), false, 'allow-lists never manage');
  for (const state of [{ kind: 'none' }, { kind: 'invalid' }] as const) {
    const open = createEditorPolicy({ policy, roles: source(state) });
    assert.equal(await open.canEdit(bootstrap, 'cached'), true, state.kind);
    assert.equal(await open.canManage(bootstrap), true, state.kind);
    assert.equal(await open.canManage(principal('google:x@corp.test', 'x@corp.test')), false);
    assert.equal(await open.canEdit(principal('google:x@corp.test', 'x@corp.test'), 'cached'), true, 'allow-lists work without a file');
  }
});

// Unclaimed: a valid file with no member anywhere (a framework's shipped roles) decides as no file does, so the bootstrap
// admin keeps the instance; a file with a member but no admin is invalid and still makes that member nobody.
test('edit policy: an unclaimed file keeps the bootstrap admin, and an admin-less file with members grants nobody', async () => {
  const bootstrap = principal('google:me@example.com', 'me@example.com');
  const policy = { bootstrapAdmin: bootstrap.identity, editorAccess: 'repository', allowedEmails: ['friend@x.org'], allowedDomains: [] };
  const unclaimedState = rolesFile([], []);
  assert.equal(unclaimedState.kind, 'roles');
  const unclaimed = createEditorPolicy({ policy, roles: source(unclaimedState) });
  const none = createEditorPolicy({ policy, roles: source({ kind: 'none' }) });
  const people = [bootstrap, principal('google:friend@x.org', 'friend@x.org'), principal('google:stranger@x.org', 'stranger@x.org')];
  for (const person of people) {
    assert.equal(await unclaimed.canEdit(person, 'fresh'), await none.canEdit(person, 'fresh'), `edit as with no file: ${person.identity}`);
    assert.equal(await unclaimed.canManage(person), await none.canManage(person), `manage as with no file: ${person.identity}`);
  }
  assert.equal(await unclaimed.canManage(bootstrap), true, 'the bootstrap admin manages an unclaimed file');
  assert.equal(await unclaimed.canEdit(principal('google:stranger@x.org', 'stranger@x.org'), 'cached'), false, 'it opens nothing to strangers');
  const strict = createEditorPolicy({ policy: { ...policy, editorAccess: 'roles' }, roles: source(unclaimedState) });
  assert.equal(await strict.canEdit(principal('google:friend@x.org', 'friend@x.org'), 'cached'), false, 'EDITOR_ACCESS=roles still holds');
  assert.equal(await strict.canEdit(bootstrap, 'cached'), true);
  // Claimed by its first admin: the file takes over completely, as for any file that lists someone.
  const claimed = createEditorPolicy({ policy, roles: source(rolesFile(['google:boss@x.org'], [])) });
  assert.equal(await claimed.canManage(bootstrap), false);
  assert.equal(await claimed.canManage(principal('google:boss@x.org')), true);
  // A member with no admin does not parse: invalid, so that member gets nothing.
  const orphanState = rolesFile([], ['google:ed@x.org']);
  assert.equal(orphanState.kind, 'invalid');
  const orphan = createEditorPolicy({ policy: { ...policy, allowedEmails: [] }, roles: source(orphanState) });
  assert.equal(await orphan.canEdit(principal('google:ed@x.org', 'ed@x.org'), 'fresh'), false, 'an invalid file names no member');
  assert.equal(await orphan.canManage(principal('google:ed@x.org')), false);
  assert.equal(await orphan.canManage(bootstrap), true, 'the bootstrap admin can still fix it');
});

test('edit policy: EDITOR_ACCESS roles switches allow-lists off, authenticated admits any verified person', async () => {
  const base = { bootstrapAdmin: principal('google:me@example.com').identity, allowedEmails: ['friend@x.org'], allowedDomains: [] };
  const rolesOnly = createEditorPolicy({ policy: { ...base, editorAccess: 'roles' }, roles: source({ kind: 'none' }) });
  assert.equal(await rolesOnly.canEdit(principal('google:friend@x.org', 'friend@x.org'), 'cached'), false);
  const anyone = createEditorPolicy({ policy: { ...base, editorAccess: 'authenticated' }, roles: source({ kind: 'none' }) });
  assert.equal(await anyone.canEdit(principal('google:stranger@x.org', 'stranger@x.org'), 'cached'), true);
  assert.equal(await anyone.canManage(principal('google:stranger@x.org')), false, 'authenticated never manages');
  const gated = createEditorPolicy({
    policy: { ...base, editorAccess: 'authenticated' },
    roles: source({ kind: 'none' }),
    active: () => Promise.resolve(false),
  });
  assert.equal(await gated.canEdit(principal('google:stranger@x.org'), 'cached'), false, 'the extra gate comes first');
});

test('roles source: parses, caches, serves a stale answer during an outage, and fails closed without one', async () => {
  let now = 1_000_000;
  let calls = 0;
  let broken = false;
  const file = JSON.stringify({ version: 1, roles: [{ id: 'admin', name: 'Admin', members: ['google:a@b.test'] }] });
  const rolesSource = createRolesSource(
    () => {
      calls++;
      return broken ? Promise.reject(new Error('down')) : Promise.resolve(file);
    },
    () => now,
  );
  assert.equal((await rolesSource.read('cached')).kind, 'roles');
  await rolesSource.read('cached');
  assert.equal(calls, 1, 'cached reads reuse the answer');
  await rolesSource.read('fresh');
  assert.equal(calls, 2, 'fresh reads ask again');
  broken = true;
  now += ROLES_SOURCE_LIMITS.cacheMs + 1;
  assert.equal((await rolesSource.read('cached')).kind, 'roles', 'a stale answer serves while the source is down');
  now += ROLES_SOURCE_LIMITS.staleMs + 1;
  await assert.rejects(rolesSource.read('cached'), /down/);
  await assert.rejects(createRolesSource(() => Promise.reject(new Error('never answered'))).read('fresh'), /never answered/);
  const orphan = JSON.stringify({ version: 1, roles: [{ id: 'client', members: ['google:a@b.test'] }] });
  for (const text of ['{', '[]', '{"version":2,"roles":[]}', 'x'.repeat(200_000), orphan]) {
    assert.equal(parseRolesState(text).kind, 'invalid', text.slice(0, 20));
  }
  assert.equal(parseRolesState(JSON.stringify({ version: 1, roles: [] })).kind, 'roles', 'an unclaimed file is valid');
  assert.equal(parseRolesState(undefined).kind, 'none');
});

test('rate limiter: a window, a ceiling on tracked keys, and a safe client key', () => {
  let now = 0;
  const limiter = createRateLimiter({ attemptsMax: 3, windowMs: 1_000, now: () => now });
  assert.deepEqual([limiter.take('a'), limiter.take('a'), limiter.take('a')], [0, 0, 0]);
  assert.ok(limiter.take('a') > 0, 'the fourth use waits');
  assert.equal(limiter.take('b'), 0, 'another key is separate');
  now += 1_001;
  assert.equal(limiter.take('a'), 0, 'the window reopens');
  const many = createRateLimiter({ attemptsMax: 1, now: () => now });
  for (let index = 0; index < RATE_LIMITS.entriesMax + 10; index++) {
    many.take(`key-${index}`);
  }
  assert.equal(many.take('key-0'), 0, 'the map starts over at its ceiling instead of growing');
  assert.equal(clientKey(new Request('https://x.test', { headers: { 'CF-Connecting-IP': '203.0.113.9' } })), '203.0.113.9');
  assert.equal(clientKey(new Request('https://x.test', { headers: { 'CF-Connecting-IP': 'x'.repeat(100) } })), 'unknown');
  assert.equal(clientKey(new Request('https://x.test')), 'unknown');
});
