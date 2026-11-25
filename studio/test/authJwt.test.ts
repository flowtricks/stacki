// Goal: ID-token validation refuses everything it should and accepts a genuine token.
// Method: genuine RS256 and ES256 tokens signed with keys generated here, then one fault at a time: a tampered payload, a
// wrong key, `alg: none`, HS256 and unlisted algorithms, wrong issuer, audience (string, list, list without azp), expiry,
// not-before, nonce, `at_hash`, a missing subject; plus strict base64url and JWT-shape table tests (hostile input) and the
// JWKS cache's bounds: cache reuse, one refetch per cooldown for an unknown `kid`, rotation, stale use during an outage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeBase64url, encodeBase64url, sameText, sha256, utf8Bytes } from '../src/features/auth/providers/base64url';
import { JWT_LIMITS, parseJwt, validateIdTokenClaims, verifyJwtSignature } from '../src/features/auth/providers/jwt';
import { createJwksCache, JWKS_LIMITS, parseJwks } from '../src/features/auth/providers/jwks';
import { fakeNetwork, forgedJwt, jsonResponse, jwksOf, makeKey, nowSeconds, signJwt, tamper } from './builtInAuthFixtures';

const base = (extra: Record<string, unknown> = {}) => ({
  iss: 'https://idp.example.test',
  aud: 'client-1',
  sub: 'user-1',
  exp: nowSeconds() + 300,
  iat: nowSeconds() - 5,
  nonce: 'n-1',
  email: 'a@b.test',
  email_verified: true,
  ...extra,
});
const expectation = { issuers: ['https://idp.example.test'], audience: 'client-1', nonce: 'n-1', nowMs: Date.now() };

async function verified(token: string, keys: Awaited<ReturnType<typeof makeKey>>[]) {
  const parsed = parseJwt(token);
  if (!parsed.ok) {
    return parsed.error;
  }
  for (const key of keys) {
    if (await verifyJwtSignature(parsed.value, { kid: key.kid, algorithm: key.algorithm, jwk: key.jwk })) {
      return 'verified';
    }
  }
  return 'signature';
}

test('genuine RS256 and ES256 tokens verify; tampering, another key and a swapped algorithm do not', async () => {
  const rsa = await makeKey('RS256', 'r1');
  const ec = await makeKey('ES256', 'e1');
  const other = await makeKey('RS256', 'r1');
  assert.equal(await verified(await signJwt(rsa, base()), [rsa]), 'verified');
  assert.equal(await verified(await signJwt(ec, base()), [ec]), 'verified');
  assert.equal(await verified(tamper(await signJwt(rsa, base())), [rsa]), 'signature');
  assert.equal(await verified(tamper(await signJwt(ec, base())), [ec]), 'signature');
  assert.equal(await verified(await signJwt(rsa, base()), [other]), 'signature', 'same kid, different key');
  assert.equal(await verified(await signJwt(rsa, base()), [ec]), 'signature', 'an EC key never verifies an RS256 token');
  // A token claiming ES256 but signed by RSA: the algorithm in the header must match the key's.
  assert.equal(await verified(await signJwt(rsa, base(), { alg: 'ES256' }), [rsa]), 'signature');
});

test('algorithms outside the allow-list are refused before any key is consulted', () => {
  for (const alg of ['none', 'None', 'HS256', 'HS512', 'RS512', 'PS256', 'ES384', 'EdDSA', '', 'rs256']) {
    const parsed = parseJwt(forgedJwt(base(), alg));
    assert.equal(parsed.ok, false, alg);
    assert.equal(parsed.ok ? '' : parsed.error, alg === '' ? 'algorithm' : 'algorithm', alg);
  }
});

test('hostile token shapes are malformed, never a crash', () => {
  const huge = 'a'.repeat(JWT_LIMITS.tokenCharsMax + 1);
  const goodHeader = encodeBase64url(utf8Bytes('{"alg":"RS256"}'));
  const cases = [
    '',
    '.',
    '..',
    'a.b',
    'a.b.c.d',
    huge,
    `${goodHeader}.${encodeBase64url(utf8Bytes('[]'))}.AAAA`,
    `${goodHeader}.${encodeBase64url(utf8Bytes('null'))}.AAAA`,
    `${goodHeader}.e30=.AAAA`,
    `${goodHeader}.e30.`,
    `${goodHeader}.${encodeBase64url(new Uint8Array([0xff, 0xfe]))}.AAAA`,
    `${encodeBase64url(utf8Bytes('{"alg":"RS256","kid":7}'))}.e30.AAAA`,
    `${goodHeader}.e30.A+/=`,
  ];
  for (const token of cases) {
    const parsed = parseJwt(token);
    assert.equal(parsed.ok, false, token.slice(0, 30));
  }
});

test('base64url is strict and bounded', () => {
  assert.deepEqual([...(decodeBase64url('aGk', 10) ?? [])], [104, 105]);
  for (const bad of ['aGk=', 'aG k', 'aGk+', 'a', 'aGl', '=', 'a'.repeat(5)]) {
    assert.equal(decodeBase64url(bad, 100), undefined, bad);
  }
  assert.equal(decodeBase64url('aGk', 1), undefined, 'over the byte bound');
  assert.equal(decodeBase64url('', 10)?.length, 0);
  assert.ok(sameText('abc', 'abc'));
  assert.equal(sameText('abc', 'abd'), false);
  assert.equal(sameText('abc', 'abcd'), false);
});

test('claims: issuer, audience, expiry, not-before, nonce, at_hash and subject', async () => {
  const run = (payload: Record<string, unknown>, overrides: Record<string, unknown> = {}) => validateIdTokenClaims(payload, { ...expectation, ...overrides });
  const good = await run(base());
  assert.ok(good.ok);
  assert.equal(good.value.email, 'a@b.test');
  assert.equal(good.value.emailVerified, true);
  const fail = async (payload: Record<string, unknown>, expected: string, overrides: Record<string, unknown> = {}) => {
    const result = await run(payload, overrides);
    assert.equal(result.ok ? 'ok' : result.error, expected, JSON.stringify(payload));
  };
  await fail(base({ iss: 'https://evil.example.test' }), 'issuer');
  await fail(base({ iss: 'https://idp.example.test/' }), 'issuer');
  await fail(base({ iss: undefined }), 'issuer');
  await fail(base({ aud: 'client-2' }), 'audience');
  await fail(base({ aud: ['client-2'] }), 'audience');
  await fail(base({ aud: ['client-1', 'client-2'] }), 'audience');
  await fail(base({ aud: ['client-1', 'client-2'], azp: 'client-2' }), 'audience');
  await fail(base({ aud: [] }), 'audience');
  await fail(base({ aud: 7 }), 'audience');
  assert.ok((await run(base({ aud: ['client-1', 'client-2'], azp: 'client-1' }))).ok);
  await fail(base({ exp: nowSeconds() - 3600 }), 'expired');
  await fail(base({ exp: undefined }), 'claims');
  await fail(base({ exp: 'soon' }), 'claims');
  await fail(base({ exp: Number.POSITIVE_INFINITY }), 'claims');
  assert.ok((await run(base({ exp: nowSeconds() - 30 }))).ok, 'a little clock skew is allowed');
  await fail(base({ nbf: nowSeconds() + 3600 }), 'not-yet-valid');
  await fail(base({ iat: nowSeconds() + 3600 }), 'not-yet-valid');
  await fail(base({ nbf: 'x' }), 'claims');
  await fail(base({ nonce: 'other' }), 'nonce');
  await fail(base({ nonce: undefined }), 'nonce');
  await fail(base({ sub: '' }), 'claims');
  await fail(base({ sub: 'x'.repeat(JWT_LIMITS.subjectCharsMax + 1) }), 'claims');
  const digest = await sha256(utf8Bytes('access-token'));
  const atHash = encodeBase64url(digest.slice(0, 16));
  assert.ok((await run(base({ at_hash: atHash }), { accessToken: 'access-token' })).ok);
  await fail(base({ at_hash: atHash }), 'at-hash', { accessToken: 'another-token' });
  assert.ok((await run(base({ at_hash: 'ignored without an access token' }))).ok);
  const unverified = await run(base({ email_verified: 'false' }));
  assert.ok(unverified.ok);
  assert.equal(unverified.value.emailVerified, false);
  const stringTrue = await run(base({ email_verified: 'true' }));
  assert.ok(stringTrue.ok && stringTrue.value.emailVerified, 'Google has sent the string "true"');
});

test('JWKS parsing keeps only strong signing keys and is bounded', async () => {
  const rsa = await makeKey('RS256', 'r1');
  const ec = await makeKey('ES256', 'e1');
  const parsed = parseJwks({
    keys: [
      rsa.entry,
      ec.entry,
      { kty: 'oct', k: 'AAAA' },
      { ...rsa.entry, use: 'enc' },
      { ...ec.entry, crv: 'P-384' },
      { ...rsa.entry, alg: 'RS512' },
      { kty: 'RSA', n: 'AQAB', e: 'AQAB' },
      'x',
      null,
    ],
  });
  assert.ok(parsed.ok);
  assert.deepEqual(
    parsed.value.map((key) => key.kid),
    ['r1', 'e1'],
  );
  for (const bad of [
    null,
    'x',
    {},
    { keys: 'no' },
    { keys: [] },
    { keys: [{ kty: 'oct' }] },
    { keys: new Array(JWKS_LIMITS.keysMax * 5 + 1).fill(rsa.entry) },
  ]) {
    assert.equal(parseJwks(bad).ok, false);
  }
  const many = parseJwks({ keys: Array.from({ length: JWKS_LIMITS.keysMax + 5 }, (_, index) => ({ ...rsa.entry, kid: `k${index}` })) });
  assert.ok(many.ok);
  assert.equal(many.value.length, JWKS_LIMITS.keysMax);
});

test('JWKS cache: reuse, one refetch per cooldown for unknown kids, rotation, stale use, unavailable', async () => {
  const first = await makeKey('RS256', 'k1');
  const second = await makeKey('RS256', 'k2');
  let now = 10_000_000;
  const network = fakeNetwork();
  let published = [first];
  let down = false;
  network.on('https://idp.example.test/keys', () => (down ? new Response('no', { status: 503 }) : jsonResponse(jwksOf(...published))));
  const cache = createJwksCache({ uri: 'https://idp.example.test/keys', fetcher: network.fetcher, now: () => now });
  assert.ok((await cache.keyFor('k1', 'RS256')).ok);
  assert.ok((await cache.keyFor('k1', 'RS256')).ok);
  assert.equal(network.urls.length, 1, 'cached');
  // Forged kids: the first unknown kid refetches, the next ones within the cooldown do not.
  now += JWKS_LIMITS.refetchCooldownMs + 1;
  assert.equal((await cache.keyFor('forged-1', 'RS256')).ok, false);
  for (let attempt = 0; attempt < 5; attempt++) {
    await cache.keyFor(`forged-${attempt + 2}`, 'RS256');
  }
  assert.equal(network.urls.length, 2, 'one refetch in the cooldown window, not one per forged kid');
  // Rotation: after the cooldown a new kid is found by refetching.
  published = [first, second];
  now += JWKS_LIMITS.refetchCooldownMs + 1;
  assert.ok((await cache.keyFor('k2', 'RS256')).ok);
  assert.equal(network.urls.length, 3);
  // No kid: ambiguous with two keys, so refused rather than guessed.
  const ambiguous = await cache.keyFor(undefined, 'RS256');
  assert.equal(ambiguous.ok ? 'ok' : ambiguous.error, 'key-unknown');
  // An outage: the older set serves for a day, then the cache says unavailable.
  down = true;
  now += JWKS_LIMITS.cacheMs + 1;
  assert.ok((await cache.keyFor('k2', 'RS256')).ok, 'stale keys serve during an outage');
  now += JWKS_LIMITS.staleMs + 1;
  const gone = await cache.keyFor('k2', 'RS256');
  assert.equal(gone.ok ? 'ok' : gone.error, 'unavailable');
});

test('JWKS fetch refuses oversized, non-JSON and redirected answers', async () => {
  const network = fakeNetwork();
  const cache = (uri: string) => createJwksCache({ uri, fetcher: network.fetcher, now: () => 1 });
  network.on('https://x.test/big', () => new Response(' '.repeat(70_000), { status: 200 }));
  network.on('https://x.test/text', () => new Response('<html>', { status: 200 }));
  network.on('https://x.test/redirect', () => {
    throw new TypeError('redirect mode is set to error');
  });
  for (const uri of ['https://x.test/big', 'https://x.test/text', 'https://x.test/redirect']) {
    const result = await cache(uri).keyFor('k', 'RS256');
    assert.equal(result.ok ? 'ok' : result.error, 'unavailable', uri);
  }
});
