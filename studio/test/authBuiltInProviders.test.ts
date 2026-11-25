// Goal: the Google, SSO (OIDC) and Cloudflare Access providers sign people in correctly and refuse everything else, with
// no real network. Method: each provider runs (1) the shared conformance kit through core's real sign-in flow, and (2) its
// own table: the authorization request it sends (PKCE, nonce, exact redirect URI), the token request it makes, and one
// fault at a time in the identity service's answer (tampered or mis-signed token, wrong issuer, audience, expiry, nonce;
// unverified email; hosted-domain mismatch; discovery for another issuer; a spoofed Access header without a JWT).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleProvider } from '../src/features/auth/providers/google';
import { createOidcProvider, parseDiscovery } from '../src/features/auth/providers/oidc';
import { createAccessProvider } from '../src/features/auth/providers/access';
import { flowValue } from '../src/features/auth/providers/oidcFlow';
import type { AuthProvider, Principal, SignInFlow } from '../src/features/auth/authProvider';
import { parseQualifiedIdentity } from '../vendor/stacki/shared/properties/memberIdentity';
import { runAuthProviderConformance, CONFORMANCE } from './authProviderConformance';
import {
  contextFor,
  fakeNetwork,
  forgedJwt,
  jsonResponse,
  jwksOf,
  makeKey,
  nowSeconds,
  rolesFrom,
  signJwt,
  tamper,
  type FakeNetwork,
  type TestKey,
} from './builtInAuthFixtures';

const callbackBase = `${CONFORMANCE.origin}/studio/auth`;
const flowFor = (provider: string, state = '11111111-1111-4111-8111-111111111111'): SignInFlow => ({
  callbackUrl: `${callbackBase}/${provider}/callback`,
  state,
  languages: undefined,
});
const principalOf = (identity: string, email?: string): Principal => {
  const parsed = parseQualifiedIdentity(identity);
  assert.ok(parsed.ok);
  return { identity: parsed.value, name: 'N', ...(email === undefined ? {} : { email }), expires: Date.now() + 60_000 };
};
const callback = (provider: string, state: string, extra = '') => new Request(`${callbackBase}/${provider}/callback?state=${state}&code=code-${state}${extra}`);

// Keys are made once, up front: the conformance kit builds providers synchronously.
const sharedKeys = { google: await makeKey('RS256', 'g1'), oidc: await makeKey('ES256', 'o1'), access: await makeKey('RS256', 'a1') };

// ---- Google ---------------------------------------------------------------------------------------------------------

const googleEnvironment = {
  GOOGLE_CLIENT_ID: 'g-client',
  GOOGLE_CLIENT_SECRET: 'g-secret',
  AUTH_BOOTSTRAP_ADMIN: 'google:owner@example.com',
  AUTH_ALLOWED_DOMAINS: 'corp.test',
};

async function googleWorld(claimsFor: (state: string) => Record<string, unknown> = () => ({}), keyOverride?: TestKey) {
  const key = keyOverride ?? sharedKeys.google;
  const network = fakeNetwork();
  network.on('https://www.googleapis.com/oauth2/v3/certs', () => jsonResponse(jwksOf(key)));
  network.on('https://oauth2.googleapis.com/token', async ({ init }) => {
    const body = new URLSearchParams(String(init.body));
    const state = (body.get('code') ?? '').slice('code-'.length);
    const nonce = await flowValue({ providerId: 'google', sessionSecret: CONFORMANCE.secret }, 'nonce', state);
    const payload = {
      iss: 'https://accounts.google.com',
      aud: 'g-client',
      sub: '1',
      exp: nowSeconds() + 300,
      iat: nowSeconds(),
      nonce,
      email: 'ann@corp.test',
      email_verified: true,
      hd: 'corp.test',
      name: 'Ann',
      ...claimsFor(state),
    };
    return jsonResponse({ id_token: await signJwt(key, payload), access_token: 'at', token_type: 'Bearer' });
  });
  return { network, key, provider: createGoogleProvider(contextFor(googleEnvironment, network)) };
}
runAuthProviderConformance({
  name: 'google',
  installed: 'built-in',
  create: () => syncProvider(),
  acceptedCallback: (state, callbackUrl) => new Request(`${callbackUrl}?state=${state}&code=code-${state}`),
  refusedCallback: (state, callbackUrl) => new Request(`${callbackUrl}?state=${state}&error=access_denied`),
  expectedIdentity: 'google:ann@corp.test',
});

function syncProvider(): AuthProvider {
  const network = fakeNetwork();
  network.on('https://www.googleapis.com/oauth2/v3/certs', () => jsonResponse(jwksOf(sharedKeys.google)));
  network.on('https://oauth2.googleapis.com/token', async ({ init }) => {
    const state = (new URLSearchParams(String(init.body)).get('code') ?? '').slice(5);
    const nonce = await flowValue({ providerId: 'google', sessionSecret: CONFORMANCE.secret }, 'nonce', state);
    return jsonResponse({
      id_token: await signJwt(sharedKeys.google, {
        iss: 'https://accounts.google.com',
        aud: 'g-client',
        sub: '1',
        exp: nowSeconds() + 300,
        nonce,
        email: 'ann@corp.test',
        email_verified: true,
        hd: 'corp.test',
        name: 'Ann',
      }),
    });
  });
  return createGoogleProvider(contextFor(googleEnvironment, network));
}

test('google: the authorization request carries PKCE, a nonce, the state and the exact redirect URI', async () => {
  const { provider } = await googleWorld();
  const response = await provider.begin(new Request(`${callbackBase}/login`), flowFor('google'));
  const location = new URL(response.headers.get('Location') ?? '');
  assert.equal(location.origin + location.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(location.searchParams.get('redirect_uri'), `${CONFORMANCE.origin}/studio/auth/google/callback`);
  assert.equal(location.searchParams.get('response_type'), 'code');
  assert.equal(location.searchParams.get('client_id'), 'g-client');
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(location.searchParams.get('state'), '11111111-1111-4111-8111-111111111111');
  assert.ok((location.searchParams.get('nonce') ?? '').length >= 43);
  assert.ok((location.searchParams.get('code_challenge') ?? '').length >= 43);
  assert.equal(location.searchParams.get('scope'), 'openid email profile');
});

test('google: the token request sends the code, the verifier whose hash was sent, and the secret', async () => {
  const { provider, network } = await googleWorld();
  const begun = new URL((await provider.begin(new Request(`${callbackBase}/login`), flowFor('google'))).headers.get('Location') ?? '');
  const result = await provider.identify(callback('google', '11111111-1111-4111-8111-111111111111'), flowFor('google'));
  assert.ok(result.ok);
  const body = new URLSearchParams(network.bodies[network.urls.indexOf('https://oauth2.googleapis.com/token')]);
  assert.equal(body.get('redirect_uri'), `${CONFORMANCE.origin}/studio/auth/google/callback`);
  assert.equal(body.get('client_secret'), 'g-secret');
  assert.equal(body.get('grant_type'), 'authorization_code');
  const verifier = body.get('code_verifier') ?? '';
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...digest))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  assert.equal(challenge, begun.searchParams.get('code_challenge'), 'the verifier is the one begin committed to');
});

test('google: every fault in the identity service answer is a refusal, never a person', async () => {
  const faults: readonly (readonly [string, (state: string) => Record<string, unknown>, string])[] = [
    ['unverified email', () => ({ email_verified: false }), 'email'],
    ['no email', () => ({ email: undefined }), 'email'],
    ['malformed email', () => ({ email: 'not an email' }), 'email'],
    ['wrong audience', () => ({ aud: 'other-client' }), 'unavailable'],
    ['wrong issuer', () => ({ iss: 'https://evil.example' }), 'unavailable'],
    ['expired', () => ({ exp: nowSeconds() - 3600 }), 'unavailable'],
    ['wrong nonce', () => ({ nonce: 'someone-elses' }), 'unavailable'],
    ['hd mismatch', () => ({ hd: 'other.test' }), 'access'],
    ['listed domain without hd', () => ({ hd: undefined }), 'access'],
  ];
  for (const [label, claims, problem] of faults) {
    const { provider } = await googleWorld(claims);
    const result = await provider.identify(callback('google', '11111111-1111-4111-8111-111111111111'), flowFor('google'));
    assert.equal(result.ok, false, label);
    assert.equal(result.ok ? '' : result.error.problem, problem, label);
  }
  const { provider: elsewhere } = await googleWorld(() => ({ email: 'bob@gmail.test', hd: undefined }));
  const consumer = await elsewhere.identify(callback('google', '11111111-1111-4111-8111-111111111111'), flowFor('google'));
  assert.ok(consumer.ok, 'a consumer account is a person; roles.json or an allow-list decides whether it may edit');
  assert.equal(consumer.value.identity, 'google:bob@gmail.test');
});

test('google: a tampered token, a foreign key and alg none are refused', async () => {
  const { network, key } = await googleWorld();
  const respond = (token: (state: string) => Promise<string>) =>
    network.on('https://oauth2.googleapis.com/token', async ({ init }) =>
      jsonResponse({ id_token: await token((new URLSearchParams(String(init.body)).get('code') ?? '').slice(5)) }),
    );
  const provider = createGoogleProvider(contextFor(googleEnvironment, network));
  const state = '11111111-1111-4111-8111-111111111111';
  const nonce = await flowValue({ providerId: 'google', sessionSecret: CONFORMANCE.secret }, 'nonce', state);
  const claims = {
    iss: 'https://accounts.google.com',
    aud: 'g-client',
    sub: '1',
    exp: nowSeconds() + 300,
    nonce,
    email: 'ann@corp.test',
    email_verified: true,
    hd: 'corp.test',
  };
  const stranger = await makeKey('RS256', 'g1');
  for (const [label, token] of [
    ['tampered', async () => tamper(await signJwt(key, claims))],
    ['foreign key, same kid', () => signJwt(stranger, claims)],
    ['alg none', () => Promise.resolve(forgedJwt(claims, 'none', 'g1'))],
    ['HS256', () => Promise.resolve(forgedJwt(claims, 'HS256', 'g1'))],
    ['unknown kid', () => signJwt({ ...key, kid: 'nope' }, claims)],
  ] as const) {
    respond(token);
    const result = await provider.identify(callback('google', state), flowFor('google'));
    assert.equal(result.ok, false, label);
  }
  respond(() => Promise.resolve('not.a.jwt'));
  assert.equal((await provider.identify(callback('google', state), flowFor('google'))).ok, false);
});

test('google: token endpoint failures map to a safe refusal and carry no secret', async () => {
  for (const [status, problem] of [
    [400, 'expired'],
    [401, 'configuration'],
    [500, 'unavailable'],
    [429, 'rate-limit'],
  ] as const) {
    const network = fakeNetwork();
    network.on('https://oauth2.googleapis.com/token', () => jsonResponse({ error: 'invalid_grant', error_description: 'g-secret leaked here' }, status));
    const provider = createGoogleProvider(contextFor(googleEnvironment, network));
    const result = await provider.identify(callback('google', '11111111-1111-4111-8111-111111111111'), flowFor('google'));
    assert.equal(result.ok ? '' : result.error.problem, problem, String(status));
    assert.ok(!JSON.stringify(result).includes('g-secret'), 'the answer body never reaches the refusal');
  }
  const network = fakeNetwork();
  const provider = createGoogleProvider(contextFor(googleEnvironment, network));
  for (const query of ['', '&code=', `&code=${'x'.repeat(3000)}`, '&error=server_error']) {
    const result = await provider.identify(new Request(`${callbackBase}/google/callback?state=s${query}`), flowFor('google'));
    assert.equal(result.ok, false, query);
  }
  assert.equal(network.urls.length, 0, 'a bad callback never reaches the network');
});

test('google: edit policy follows roles.json first, then the allow-lists; unknown people may not edit', async () => {
  const network = fakeNetwork();
  const roles = rolesFrom(JSON.stringify({ version: 1, roles: [{ id: 'admin', name: 'Admin', members: ['google:boss@elsewhere.org'] }] }));
  const provider = createGoogleProvider(contextFor(googleEnvironment, network, roles));
  assert.equal(await provider.canEdit?.(principalOf('google:boss@elsewhere.org', 'boss@elsewhere.org'), 'cached'), true);
  assert.equal(await provider.canEdit?.(principalOf('google:ann@corp.test', 'ann@corp.test'), 'cached'), true, 'allow-listed domain');
  assert.equal(await provider.canEdit?.(principalOf('google:eve@evil.test', 'eve@evil.test'), 'cached'), false);
  assert.equal(await provider.canManage?.(principalOf('google:ann@corp.test', 'ann@corp.test')), false);
  assert.equal(await provider.canManage?.(principalOf('google:boss@elsewhere.org')), true);
  assert.throws(() => createGoogleProvider(contextFor({ AUTH_PROVIDER: 'google' }, network)), /misconfigured.*GOOGLE_CLIENT_ID/);
});

test('google: a flood from one address is limited before any network call', async () => {
  const network = fakeNetwork();
  const provider = createGoogleProvider(contextFor(googleEnvironment, network));
  const headers = { 'CF-Connecting-IP': '198.51.100.7' };
  let limited = 0;
  for (let attempt = 0; attempt < 40; attempt++) {
    const result = await provider.identify(new Request(`${callbackBase}/google/callback?state=s`, { headers }), flowFor('google'));
    limited += !result.ok && result.error.problem === 'rate-limit' ? 1 : 0;
  }
  assert.ok(limited >= 15, `limited ${limited}`);
  const begin = await (async () => {
    let last = 200;
    for (let attempt = 0; attempt < 40; attempt++) {
      last = (await provider.begin(new Request(`${callbackBase}/login`, { headers }), flowFor('google'))).status;
    }
    return last;
  })();
  assert.equal(begin, 429);
});

// ---- OIDC -----------------------------------------------------------------------------------------------------------

const oidcEnvironment = {
  OIDC_ISSUER: 'https://idp.example.test/realms/a',
  OIDC_CLIENT_ID: 'o-client',
  OIDC_CLIENT_SECRET: 'o-secret',
  OIDC_NAME: 'Okta',
  AUTH_BOOTSTRAP_ADMIN: 'oidc:owner@example.com',
  AUTH_ALLOWED_DOMAINS: 'corp.test',
};
const discovery = (extra: Record<string, unknown> = {}) => ({
  issuer: 'https://idp.example.test/realms/a',
  authorization_endpoint: 'https://idp.example.test/auth',
  token_endpoint: 'https://idp.example.test/token',
  jwks_uri: 'https://idp.example.test/keys',
  id_token_signing_alg_values_supported: ['RS256', 'ES256'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
  ...extra,
});

function oidcWorld(
  claimsFor: (state: string) => Record<string, unknown> = () => ({}),
  discoveryExtra: Record<string, unknown> = {},
  environment: Record<string, unknown> = oidcEnvironment,
) {
  const network = fakeNetwork();
  const key = sharedKeys.oidc;
  network.on('https://idp.example.test/realms/a/.well-known/openid-configuration', () => jsonResponse(discovery(discoveryExtra)));
  network.on('https://idp.example.test/keys', () => jsonResponse(jwksOf(key)));
  network.on('https://idp.example.test/token', async ({ init }) => {
    const state = (new URLSearchParams(String(init.body)).get('code') ?? '').slice(5);
    const nonce = await flowValue({ providerId: 'oidc', sessionSecret: CONFORMANCE.secret }, 'nonce', state);
    const payload = {
      iss: 'https://idp.example.test/realms/a',
      aud: 'o-client',
      sub: 'u-42',
      exp: nowSeconds() + 300,
      nonce,
      email: 'Ann@Corp.test',
      email_verified: true,
      name: 'Ann',
      ...claimsFor(state),
    };
    return jsonResponse({ id_token: await signJwt(key, payload) });
  });
  return { network, provider: createOidcProvider(contextFor(environment, network)) };
}
const state1 = '11111111-1111-4111-8111-111111111111';

test('oidc: discovery drives the endpoints, the button shows OIDC_NAME, basic auth is used when offered', async () => {
  const { provider, network } = oidcWorld();
  assert.equal(provider.displayName, 'Okta');
  const location = new URL((await provider.begin(new Request(`${callbackBase}/login`), flowFor('oidc'))).headers.get('Location') ?? '');
  assert.equal(location.origin + location.pathname, 'https://idp.example.test/auth');
  assert.equal(location.searchParams.get('redirect_uri'), `${CONFORMANCE.origin}/studio/auth/oidc/callback`);
  const result = await provider.identify(callback('oidc', state1), flowFor('oidc'));
  assert.ok(result.ok);
  assert.equal(result.value.identity, 'oidc:ann@corp.test', 'a verified email, lowercased, names the person');
  assert.equal(network.urls.filter((url) => url.endsWith('openid-configuration')).length, 1, 'discovery is cached');
  assert.equal(network.bodies[network.urls.indexOf('https://idp.example.test/token')]?.includes('client_secret'), false, 'basic, not the body');
});

test('oidc: with no verified email the sub names the person, unless it looks like an email', async () => {
  const fallback = await oidcWorld(() => ({ email_verified: false })).provider.identify(callback('oidc', state1), flowFor('oidc'));
  assert.ok(fallback.ok);
  assert.equal(fallback.value.identity, 'oidc:u-42');
  assert.equal(fallback.value.email, undefined, 'an unverified address is never recorded');
  for (const sub of ['ceo@corp.test', 'a b', 'x,y']) {
    const refused = await oidcWorld(() => ({ email: undefined, sub })).provider.identify(callback('oidc', state1), flowFor('oidc'));
    assert.equal(refused.ok ? '' : refused.error.problem, 'email', sub);
  }
  const tooLong = await oidcWorld(() => ({ email: undefined, sub: 's'.repeat(240) })).provider.identify(callback('oidc', state1), flowFor('oidc'));
  assert.equal(tooLong.ok, false);
});

test('oidc: a public client uses PKCE only; discovery for another issuer or without S256 is refused', async () => {
  const { provider, network } = oidcWorld(
    () => ({}),
    { token_endpoint_auth_methods_supported: ['none'] },
    { ...oidcEnvironment, OIDC_CLIENT_SECRET: undefined },
  );
  assert.ok((await provider.identify(callback('oidc', state1), flowFor('oidc'))).ok);
  const body = new URLSearchParams(network.bodies[network.urls.indexOf('https://idp.example.test/token')]);
  assert.equal(body.get('client_id'), 'o-client');
  assert.equal(body.has('client_secret'), false);
  assert.ok((body.get('code_verifier') ?? '').length >= 43);
  for (const extra of [
    { issuer: 'https://evil.example.test' },
    { code_challenge_methods_supported: ['plain'] },
    { jwks_uri: 'http://idp.example.test/keys' },
    { token_endpoint: 'https://u:p@idp.example.test/t' },
    { id_token_signing_alg_values_supported: ['HS256'] },
    { authorization_endpoint: undefined },
  ]) {
    const result = await oidcWorld(() => ({}), extra).provider.identify(callback('oidc', state1), flowFor('oidc'));
    assert.equal(result.ok, false, JSON.stringify(extra));
    assert.equal(result.ok ? '' : result.error.problem, 'unavailable');
  }
  assert.equal(parseDiscovery('x', 'https://i', true).ok, false);
  const post = parseDiscovery(discovery({ token_endpoint_auth_methods_supported: ['client_secret_post'] }), 'https://idp.example.test/realms/a', true);
  assert.ok(post.ok);
  assert.equal(post.value.tokenAuthMethod, 'post');
  assert.equal(parseDiscovery(discovery({ token_endpoint_auth_methods_supported: ['private_key_jwt'] }), 'https://idp.example.test/realms/a', true).ok, false);
});

test('oidc: faults in the ID token and the answers of a down provider', async () => {
  const faults: readonly (readonly [string, (state: string) => Record<string, unknown>])[] = [
    ['issuer', () => ({ iss: 'https://idp.example.test/realms/b' })],
    ['audience', () => ({ aud: ['o-client', 'x'] })],
    ['expired', () => ({ exp: nowSeconds() - 600 })],
    ['not yet valid', () => ({ nbf: nowSeconds() + 600 })],
    ['nonce', () => ({ nonce: 'replayed' })],
    ['at_hash', () => ({ at_hash: 'AAAAAAAAAAAAAAAAAAAAAA' })],
  ];
  for (const [label, claims] of faults) {
    const { network, provider } = oidcWorld(claims);
    network.on('https://idp.example.test/token', async ({ init }) => {
      const state = (new URLSearchParams(String(init.body)).get('code') ?? '').slice(5);
      const nonce = await flowValue({ providerId: 'oidc', sessionSecret: CONFORMANCE.secret }, 'nonce', state);
      const payload = {
        iss: 'https://idp.example.test/realms/a',
        aud: 'o-client',
        sub: 'u',
        exp: nowSeconds() + 300,
        nonce,
        email: 'a@b.test',
        email_verified: true,
        ...claims(state),
      };
      return jsonResponse({ id_token: await signJwt(sharedKeys.oidc, payload), access_token: 'real-access-token' });
    });
    assert.equal((await provider.identify(callback('oidc', state1), flowFor('oidc'))).ok, false, label);
  }
  const down = fakeNetwork();
  down.on('https://idp.example.test/realms/a/.well-known/openid-configuration', () => new Response('x', { status: 503 }));
  const provider = createOidcProvider(contextFor(oidcEnvironment, down));
  assert.equal((await provider.identify(callback('oidc', state1), flowFor('oidc'))).ok, false);
  await assert.rejects(provider.begin(new Request(`${callbackBase}/login`), flowFor('oidc')), /discovery/);
});

runAuthProviderConformance({
  name: 'oidc',
  installed: 'built-in',
  create: () => oidcWorld().provider,
  acceptedCallback: (state, callbackUrl) => new Request(`${callbackUrl}?state=${state}&code=code-${state}`),
  refusedCallback: (state, callbackUrl) => new Request(`${callbackUrl}?state=${state}&error=access_denied`),
  expectedIdentity: 'oidc:ann@corp.test',
});

// ---- Cloudflare Access ----------------------------------------------------------------------------------------------

const accessEnvironment = {
  ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
  ACCESS_AUD: 'a'.repeat(32),
  AUTH_BOOTSTRAP_ADMIN: 'access:owner@example.com',
  AUTH_ALLOWED_DOMAINS: 'corp.test',
};
const accessClaims = (extra: Record<string, unknown> = {}) => ({
  iss: 'https://team.cloudflareaccess.com',
  aud: ['a'.repeat(32)],
  sub: 'uuid-1',
  email: 'Ann@Corp.test',
  exp: nowSeconds() + 300,
  iat: nowSeconds(),
  ...extra,
});

function accessWorld(key: TestKey = sharedKeys.access): { network: FakeNetwork; provider: AuthProvider } {
  const network = fakeNetwork();
  network.on('https://team.cloudflareaccess.com/cdn-cgi/access/certs', () => jsonResponse({ keys: jwksOf(key).keys, public_cert: [] }));
  return { network, provider: createAccessProvider(contextFor(accessEnvironment, network)) };
}
const withJwt = (token: string | undefined, path = '/studio/auth/access/callback?state=s') =>
  new Request(`${CONFORMANCE.origin}${path}`, { headers: token === undefined ? {} : { 'Cf-Access-Jwt-Assertion': token } });

test('access: a verified JWT names the person; the callback redirect carries core’s state', async () => {
  const { provider } = accessWorld();
  const started = await provider.begin(withJwt(await signJwt(sharedKeys.access, accessClaims()), '/studio/auth/login'), flowFor('access'));
  assert.equal(started.status, 302);
  assert.equal(started.headers.get('Location'), `${callbackBase}/access/callback?state=${state1}`);
  const result = await provider.identify(withJwt(await signJwt(sharedKeys.access, accessClaims())), flowFor('access'));
  assert.ok(result.ok);
  assert.equal(result.value.identity, 'access:ann@corp.test');
  assert.equal(provider.displayName, 'Cloudflare Access');
});

test('access: no JWT, a spoofed email header, and every faulty JWT are refused; the page explains the setup', async () => {
  const { provider } = accessWorld();
  const spoof = new Request(`${CONFORMANCE.origin}/studio/auth/access/callback?state=s`, {
    headers: { 'Cf-Access-Authenticated-User-Email': 'owner@example.com' },
  });
  const spoofed = await provider.identify(spoof, flowFor('access'));
  assert.equal(spoofed.ok, false, 'a plain header proves nothing');
  const page = await provider.begin(
    new Request(`${CONFORMANCE.origin}/studio/auth/login`, { headers: { 'Cf-Access-Authenticated-User-Email': 'owner@example.com' } }),
    flowFor('access'),
  );
  assert.equal(page.status, 503);
  const html = await page.text();
  assert.match(html, /Cloudflare Access did not authenticate this request/);
  assert.ok(!html.includes('href="/studio/auth/login"'), 'no sign-in button that could only loop');
  const good = accessClaims();
  const stranger = await makeKey('RS256', 'a1');
  const faults: readonly (readonly [string, () => Promise<string>])[] = [
    ['tampered', async () => tamper(await signJwt(sharedKeys.access, good))],
    ['foreign key', () => signJwt(stranger, good)],
    ['alg none', () => Promise.resolve(forgedJwt(good, 'none', 'a1'))],
    ['HS256', () => Promise.resolve(forgedJwt(good, 'HS256', 'a1'))],
    ['ES256 token', async () => signJwt(await makeKey('ES256', 'a1'), good)],
    ['wrong audience', () => signJwt(sharedKeys.access, accessClaims({ aud: ['b'.repeat(32)] }))],
    ['wrong issuer', () => signJwt(sharedKeys.access, accessClaims({ iss: 'https://other.cloudflareaccess.com' }))],
    ['expired', () => signJwt(sharedKeys.access, accessClaims({ exp: nowSeconds() - 3600 }))],
    ['not yet valid', () => signJwt(sharedKeys.access, accessClaims({ nbf: nowSeconds() + 3600 }))],
    ['no identity at all', () => signJwt(sharedKeys.access, accessClaims({ email: undefined, common_name: undefined }))],
  ];
  for (const [label, token] of faults) {
    assert.equal((await provider.identify(withJwt(await token()), flowFor('access'))).ok, false, label);
  }
});

test('access: a service token is a service identity that cannot manage; keys rotate with one refetch', async () => {
  const { provider, network } = accessWorld();
  const service = await provider.identify(
    withJwt(await signJwt(sharedKeys.access, accessClaims({ email: undefined, sub: '', common_name: 'Deploy-Bot.1' }))),
    flowFor('access'),
  );
  assert.ok(service.ok);
  assert.equal(service.value.identity, 'access:service-deploy-bot.1');
  assert.equal(await provider.canManage?.(principalOf('access:service-deploy-bot.1')), false);
  const rotated = await makeKey('RS256', 'a2');
  network.on('https://team.cloudflareaccess.com/cdn-cgi/access/certs', () => jsonResponse(jwksOf(sharedKeys.access, rotated)));
  const before = network.urls.length;
  const unknown = await provider.identify(withJwt(await signJwt(rotated, accessClaims())), flowFor('access'));
  assert.equal(unknown.ok, false, 'within the cooldown a new kid is not fetched for yet');
  assert.equal(network.urls.length, before);
  assert.throws(() => createAccessProvider(contextFor({ ...accessEnvironment, ACCESS_TEAM_DOMAIN: 'evil.example.com' }, network)), /cloudflareaccess\.com/);
});

const conformanceToken = await signJwt(sharedKeys.access, accessClaims({ exp: nowSeconds() + 3000 }));
runAuthProviderConformance({
  name: 'access',
  installed: 'built-in',
  create: () => accessWorld().provider,
  acceptedCallback: (state, callbackUrl) => new Request(`${callbackUrl}?state=${state}`, { headers: { 'Cf-Access-Jwt-Assertion': conformanceToken } }),
  expectedIdentity: 'access:ann@corp.test',
});
