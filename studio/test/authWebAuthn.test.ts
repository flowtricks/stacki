// Goal: the WebAuthn verifier accepts what real authenticators send and refuses every deviation, and the CBOR reader and
// DER signature reader refuse hostile bytes.
// Method: a software authenticator (softAuthenticator.ts) makes genuine registrations and assertions for ES256, RS256 and
// EdDSA; each negative case changes exactly one thing (origin, RP ID hash, challenge, type, user-present flag, signature,
// attestation format, counter). Table tests feed truncated, nested, oversized and malformed CBOR and DER.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeCbor, CBOR_LIMITS } from '../src/features/auth/providers/cbor';
import { challengeOf, derToRawSignature, parseStoredKey, verifyAssertion, verifyRegistration } from '../src/features/auth/providers/webauthn';
import { cbor, softAuthenticator } from './softAuthenticator';

const origin = 'https://studio.example.test';
const expected = (challenge: string) => ({ challenge, origin, rpId: 'studio.example.test' });
const challenge = 'Y2hhbGxlbmdlLWNoYWxsZW5nZS1jaGFsbGVuZ2UtMTI';

test('registration verifies for ES256, RS256 and EdDSA, with attestation none and packed self attestation', async () => {
  for (const algorithm of ['ES256', 'RS256', 'EdDSA'] as const) {
    for (const format of ['none', 'packed'] as const) {
      const device = await softAuthenticator({ origin, rpId: 'studio.example.test', algorithm, format });
      const made = await device.create(challenge);
      const result = await verifyRegistration(made, expected(challenge));
      assert.ok(result.ok, `${algorithm} ${format}: ${result.ok ? '' : result.error}`);
      assert.equal(result.value.credentialId, device.credentialId);
      assert.equal(result.value.key.kind, algorithm);
      assert.equal(result.value.userVerified, true);
      assert.deepEqual(parseStoredKey(result.value.key), result.value.key, 'a stored key reads back unchanged');
    }
  }
});

test('registration refuses each deviation by its own code', async () => {
  const device = await softAuthenticator({ origin, rpId: 'studio.example.test' });
  const cases: readonly (readonly [string, Parameters<typeof device.create>[1], string])[] = [
    ['wrong origin', { origin: 'https://evil.example.test' }, 'origin'],
    ['a sibling subdomain origin', { origin: 'https://x.studio.example.test' }, 'origin'],
    ['wrong RP ID hash', { rpId: 'evil.example.test' }, 'rp-id-hash'],
    ['another challenge', { challenge: 'b3RoZXI' }, 'challenge'],
    ['an assertion type', { type: 'webauthn.get' }, 'type'],
    ['user not present', { userPresent: false }, 'user-present'],
    ['an unknown attestation format', { attestationFormat: 'tpm' }, 'attestation-unsupported'],
    ['packed with a certificate chain', { attestationFormat: 'packed-x5c' }, 'attestation-unsupported'],
  ];
  for (const [label, bad, code] of cases) {
    const result = await verifyRegistration(await device.create(challenge, bad), expected(challenge));
    assert.equal(result.ok ? 'ok' : result.error, code, label);
  }
  const forged = await softAuthenticator({ origin, rpId: 'studio.example.test', format: 'packed' });
  const badSignature = await verifyRegistration(await forged.create(challenge, { corruptSignature: true }), expected(challenge));
  assert.equal(badSignature.ok ? 'ok' : badSignature.error, 'signature');
});

test('assertions verify, and every deviation or rollback is refused', async () => {
  for (const algorithm of ['ES256', 'RS256', 'EdDSA'] as const) {
    const device = await softAuthenticator({ origin, rpId: 'studio.example.test', algorithm });
    const registered = await verifyRegistration(await device.create(challenge), expected(challenge));
    assert.ok(registered.ok);
    const credential = { key: registered.value.key, signCount: 0 };
    const first = await verifyAssertion(await device.get(challenge), expected(challenge), credential);
    assert.ok(first.ok, `${algorithm}: ${first.ok ? '' : first.error}`);
    assert.equal(first.value.signCount, 1);
    const cases: readonly (readonly [string, Parameters<typeof device.get>[1], string])[] = [
      ['wrong origin', { origin: 'https://evil.example.test', signCount: 5 }, 'origin'],
      ['wrong RP', { rpId: 'evil.example.test', signCount: 5 }, 'rp-id-hash'],
      ['another challenge', { challenge: 'b3RoZXI', signCount: 5 }, 'challenge'],
      ['creation type', { type: 'webauthn.create', signCount: 5 }, 'type'],
      ['user not present', { userPresent: false, signCount: 5 }, 'user-present'],
      ['corrupt signature', { corruptSignature: true, signCount: 5 }, 'signature'],
      ['counter equal to the stored one', { signCount: 3 }, 'counter-rollback'],
      ['counter below the stored one', { signCount: 2 }, 'counter-rollback'],
    ];
    for (const [label, bad, code] of cases) {
      const result = await verifyAssertion(await device.get(challenge, bad), expected(challenge), { key: credential.key, signCount: 3 });
      assert.equal(result.ok ? 'ok' : result.error, code, `${algorithm} ${label}`);
    }
  }
});

test('a signature from another key never verifies, and a counter of zero is allowed only while it stays zero', async () => {
  const device = await softAuthenticator({ origin, rpId: 'studio.example.test' });
  const other = await softAuthenticator({ origin, rpId: 'studio.example.test' });
  const registered = await verifyRegistration(await device.create(challenge), expected(challenge));
  assert.ok(registered.ok);
  const stranger = await verifyAssertion(await other.get(challenge), expected(challenge), { key: registered.value.key, signCount: 0 });
  assert.equal(stranger.ok ? 'ok' : stranger.error, 'signature');
  const noCounter = await verifyAssertion(await device.get(challenge, { signCount: 0 }), expected(challenge), { key: registered.value.key, signCount: 0 });
  assert.ok(noCounter.ok, 'authenticators without a counter send zero');
  const wentToZero = await verifyAssertion(await device.get(challenge, { signCount: 0 }), expected(challenge), { key: registered.value.key, signCount: 9 });
  assert.equal(wentToZero.ok ? 'ok' : wentToZero.error, 'counter-rollback');
  assert.equal(challengeOf(new TextEncoder().encode('{"type":"webauthn.get","challenge":"abc","origin":"https://x.test"}')), 'abc');
  for (const bad of ['', 'not json', '[]', '{"challenge":5}', '\u0000']) {
    assert.equal(challengeOf(new TextEncoder().encode(bad)), undefined, bad);
  }
});

test('hostile CBOR is refused with a code, never a crash or an unbounded allocation', () => {
  const huge = Uint8Array.from([0x5a, 0xff, 0xff, 0xff, 0xff]);
  const nested = Uint8Array.from({ length: CBOR_LIMITS.depthMax + 3 }, () => 0x81);
  const cases: readonly (readonly [string, Uint8Array])[] = [
    ['empty', new Uint8Array(0)],
    ['truncated string', Uint8Array.from([0x45, 1, 2])],
    ['a 4 GiB byte string', huge],
    ['indefinite array', Uint8Array.from([0x9f, 0x01, 0xff])],
    ['a tag', Uint8Array.from([0xc1, 0x01])],
    ['a float', Uint8Array.from([0xf9, 0x3c, 0x00])],
    ['a 64-bit integer past 2^53', Uint8Array.from([0x1b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])],
    ['too deeply nested', nested],
    ['a duplicate map key', Uint8Array.from([0xa2, 0x01, 0x01, 0x01, 0x02])],
    ['a map key that is bytes', Uint8Array.from([0xa1, 0x41, 0x01, 0x01])],
    ['invalid UTF-8 text', Uint8Array.from([0x62, 0xff, 0xfe])],
    ['too many items', Uint8Array.from([0x98, 0xff])],
    ['reserved length', Uint8Array.from([0x1c])],
    ['oversized input', new Uint8Array(CBOR_LIMITS.inputBytesMax + 1)],
  ];
  for (const [label, bytes] of cases) {
    assert.equal(decodeCbor(bytes).ok, false, label);
  }
  const good = decodeCbor(
    cbor(
      new Map<string | number, unknown>([
        ['a', 1],
        [-1, new Uint8Array([1, 2])],
      ]),
    ),
  );
  assert.ok(good.ok);
  assert.ok(good.value.value instanceof Map);
});

test('DER signatures: only well-formed ECDSA encodings convert', () => {
  const raw = (length: number) => Uint8Array.from({ length }, (_, index) => index + 1);
  const good = Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02]);
  assert.equal(derToRawSignature(good)?.length, 64);
  void raw;
  const bad: readonly Uint8Array[] = [
    new Uint8Array(0),
    Uint8Array.from([0x30, 0x00]),
    Uint8Array.from([0x31, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02]),
    Uint8Array.from([0x30, 0x07, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02]),
    Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x81, 0x02, 0x01, 0x02]),
    Uint8Array.from([0x30, 0x06, 0x02, 0x00, 0x02, 0x01, 0x02, 0x00]),
    Uint8Array.from([0x30, 0x08, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02, 0x00, 0x00]),
    new Uint8Array(100).fill(0x30),
  ];
  for (const der of bad) {
    assert.equal(derToRawSignature(der), undefined);
  }
  assert.equal(parseStoredKey({ kind: 'ES256', x: '!!', y: 'AA' }), undefined);
  assert.equal(parseStoredKey({ kind: 'HS256' }), undefined);
  assert.equal(parseStoredKey(null), undefined);
});
