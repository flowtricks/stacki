// Goal: WebAuthn registration and assertion verification on Web Crypto, with no dependency.
// Scope, stated so it is not mistaken for more: relying-party verification as Level 2 section 7 describes it, for
// attestation `none` and `packed` self attestation (attestation is requested as `none`, so authenticators send those), and
// assertions signed with ES256, RS256 or EdDSA (Ed25519). Attestation statements are NOT trust-checked: Studio asks "is this
// the same key as last time", not "what device is this". Every length is bounded and every field parsed before use.
// The checks, each with its failure code: client data (`type`, `challenge`, exact `origin`, no `crossOrigin`), the
// authenticator data (`rpIdHash`, user-present flag, the attested credential and its COSE key on registration), the signature
// over `authenticatorData || SHA-256(clientDataJSON)`, and a signature counter that never goes back.
import { err, ok, type Result } from '../../../../vendor/stacki/shared/core/result';
import { decodeBase64url, encodeBase64url, sameText, sha256, utf8Bytes } from './base64url';
import { decodeCbor, type CborValue } from './cbor';

export const WEBAUTHN_LIMITS = {
  clientDataBytesMax: 2_048,
  authenticatorDataBytesMax: 4_096,
  attestationBytesMax: 8_192,
  credentialIdBytesMax: 1_023,
  signatureBytesMax: 1_024,
  challengeBytes: 32,
  rsaModulusBytesMin: 256,
  rsaModulusBytesMax: 512,
} as const satisfies Record<string, number>;

export type WebAuthnFailure =
  | 'client-data'
  | 'type'
  | 'challenge'
  | 'origin'
  | 'authenticator-data'
  | 'rp-id-hash'
  | 'user-present'
  | 'attestation'
  | 'attestation-unsupported'
  | 'credential'
  | 'public-key'
  | 'signature'
  | 'counter-rollback';

/** A credential's public key as stored: plain JSON, re-parsed from storage by `parseStoredKey`. */
export type StoredKey =
  | { readonly kind: 'ES256'; readonly x: string; readonly y: string }
  | { readonly kind: 'RS256'; readonly n: string; readonly e: string }
  | { readonly kind: 'EdDSA'; readonly x: string };

export interface RegisteredCredential {
  readonly credentialId: string;
  readonly key: StoredKey;
  readonly signCount: number;
  readonly userVerified: boolean;
}

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_ATTESTED = 0x40;

export interface Expectation {
  /** The challenge Studio issued, as base64url. */
  readonly challenge: string;
  /** The exact origin, such as `https://studio.example.com`. */
  readonly origin: string;
  readonly rpId: string;
}

/** The base64url challenge in a client data JSON, for looking up the single-use record before anything else is trusted. */
export function challengeOf(clientDataJSON: Uint8Array): string | undefined {
  const data = parseClientData(clientDataJSON);
  return data.ok ? data.value.challenge : undefined;
}

interface ClientData {
  readonly type: string;
  readonly challenge: string;
  readonly origin: string;
  readonly crossOrigin: boolean;
}

function parseClientData(bytes: Uint8Array): Result<ClientData, WebAuthnFailure> {
  if (bytes.length === 0 || bytes.length > WEBAUTHN_LIMITS.clientDataBytesMax) {
    return err('client-data');
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return err('client-data');
    }
    const type: unknown = Reflect.get(value, 'type');
    const challenge: unknown = Reflect.get(value, 'challenge');
    const origin: unknown = Reflect.get(value, 'origin');
    const crossOrigin: unknown = Reflect.get(value, 'crossOrigin');
    if (typeof type !== 'string' || typeof challenge !== 'string' || typeof origin !== 'string') {
      return err('client-data');
    }
    return ok({ type, challenge, origin, crossOrigin: crossOrigin === true });
  } catch {
    return err('client-data');
  }
}

function checkClientData(bytes: Uint8Array, type: string, expected: Expectation): Result<void, WebAuthnFailure> {
  const data = parseClientData(bytes);
  if (!data.ok) {
    return data;
  }
  if (data.value.type !== type) {
    return err('type');
  }
  if (!sameText(data.value.challenge, expected.challenge)) {
    return err('challenge');
  }
  if (data.value.origin !== expected.origin || data.value.crossOrigin) {
    return err('origin');
  }
  return ok(undefined);
}

interface AuthenticatorData {
  readonly flags: number;
  readonly signCount: number;
  readonly attested: { readonly credentialId: Uint8Array; readonly keyText: CborValue } | undefined;
}

async function parseAuthenticatorData(bytes: Uint8Array, rpId: string): Promise<Result<AuthenticatorData, WebAuthnFailure>> {
  if (bytes.length < 37 || bytes.length > WEBAUTHN_LIMITS.authenticatorDataBytesMax) {
    return err('authenticator-data');
  }
  const expectedHash = await sha256(utf8Bytes(rpId));
  const actual = bytes.subarray(0, 32);
  if (!sameText(encodeBase64url(actual), encodeBase64url(expectedHash))) {
    return err('rp-id-hash');
  }
  const flags = bytes[32] ?? 0;
  if ((flags & FLAG_USER_PRESENT) === 0) {
    return err('user-present');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signCount = view.getUint32(33, false);
  if ((flags & FLAG_ATTESTED) === 0) {
    return ok({ flags, signCount, attested: undefined });
  }
  if (bytes.length < 55) {
    return err('authenticator-data');
  }
  const idLength = view.getUint16(53, false);
  if (idLength === 0 || idLength > WEBAUTHN_LIMITS.credentialIdBytesMax || 55 + idLength >= bytes.length) {
    return err('credential');
  }
  const credentialId = bytes.slice(55, 55 + idLength);
  const key = decodeCbor(bytes, 55 + idLength);
  if (!key.ok) {
    return err('public-key');
  }
  return ok({ flags, signCount, attested: { credentialId, keyText: key.value.value } });
}

export async function verifyRegistration(
  input: { readonly clientDataJSON: Uint8Array; readonly attestationObject: Uint8Array },
  expected: Expectation,
): Promise<Result<RegisteredCredential, WebAuthnFailure>> {
  const clientData = checkClientData(input.clientDataJSON, 'webauthn.create', expected);
  if (!clientData.ok) {
    return clientData;
  }
  if (input.attestationObject.length > WEBAUTHN_LIMITS.attestationBytesMax) {
    return err('attestation');
  }
  const decoded = decodeCbor(input.attestationObject);
  const object = decoded.ok ? asMap(decoded.value.value) : undefined;
  if (object === undefined) {
    return err('attestation');
  }
  const format = object.get('fmt');
  const statement = asMap(object.get('attStmt'));
  const authData = object.get('authData');
  if (typeof format !== 'string' || statement === undefined || !(authData instanceof Uint8Array)) {
    return err('attestation');
  }
  const parsed = await parseAuthenticatorData(authData, expected.rpId);
  if (!parsed.ok) {
    return parsed;
  }
  if (parsed.value.attested === undefined) {
    return err('credential');
  }
  const key = await parseCoseKey(parsed.value.attested.keyText);
  if (!key.ok) {
    return key;
  }
  const clientHash = await sha256(new Uint8Array(input.clientDataJSON));
  if (format === 'packed') {
    const verified = await verifySelfAttestation(statement, authData, clientHash, key.value);
    if (!verified.ok) {
      return verified;
    }
  } else if (format !== 'none' || statement.size !== 0) {
    return err('attestation-unsupported');
  }
  return ok({
    credentialId: encodeBase64url(parsed.value.attested.credentialId),
    key: key.value,
    signCount: parsed.value.signCount,
    userVerified: (parsed.value.flags & FLAG_USER_VERIFIED) !== 0,
  });
}

// Packed self attestation: no certificate chain, the signature is made by the credential's own key. A statement with `x5c`
// needs a trust decision Studio does not make, so it is refused rather than accepted unchecked.
async function verifySelfAttestation(
  statement: ReadonlyMap<string | number, CborValue>,
  authData: Uint8Array,
  clientHash: Uint8Array,
  key: StoredKey,
): Promise<Result<void, WebAuthnFailure>> {
  const algorithm = statement.get('alg');
  const signature = statement.get('sig');
  if (statement.has('x5c') || statement.has('ecdaaKeyId') || typeof algorithm !== 'number' || !(signature instanceof Uint8Array)) {
    return err('attestation-unsupported');
  }
  if (algorithm !== COSE_ALGORITHM[key.kind]) {
    return err('attestation');
  }
  const signed = concatenate(authData, clientHash);
  return (await verifySignature(key, signature, signed)) ? ok(undefined) : err('signature');
}

export interface AssertionInput {
  readonly clientDataJSON: Uint8Array;
  readonly authenticatorData: Uint8Array;
  readonly signature: Uint8Array;
}

export async function verifyAssertion(
  input: AssertionInput,
  expected: Expectation,
  credential: { readonly key: StoredKey; readonly signCount: number },
): Promise<Result<{ readonly signCount: number; readonly userVerified: boolean }, WebAuthnFailure>> {
  const clientData = checkClientData(input.clientDataJSON, 'webauthn.get', expected);
  if (!clientData.ok) {
    return clientData;
  }
  if (input.signature.length === 0 || input.signature.length > WEBAUTHN_LIMITS.signatureBytesMax) {
    return err('signature');
  }
  const parsed = await parseAuthenticatorData(input.authenticatorData, expected.rpId);
  if (!parsed.ok) {
    return parsed;
  }
  const clientHash = await sha256(new Uint8Array(input.clientDataJSON));
  if (!(await verifySignature(credential.key, input.signature, concatenate(input.authenticatorData, clientHash)))) {
    return err('signature');
  }
  // A counter that does not advance means a cloned authenticator or a replay. Authenticators that keep no counter send 0
  // every time, and that is allowed; a counter that was ever above zero must keep rising.
  const next = parsed.value.signCount;
  if ((next !== 0 || credential.signCount !== 0) && next <= credential.signCount) {
    return err('counter-rollback');
  }
  return ok({ signCount: next, userVerified: (parsed.value.flags & FLAG_USER_VERIFIED) !== 0 });
}

const COSE_ALGORITHM = { ES256: -7, RS256: -257, EdDSA: -8 } as const;

function asMap(value: CborValue): ReadonlyMap<string | number, CborValue> | undefined {
  return value instanceof Map ? new Map<string | number, CborValue>(value) : undefined;
}

async function parseCoseKey(value: CborValue): Promise<Result<StoredKey, WebAuthnFailure>> {
  const input = asMap(value);
  if (input === undefined) {
    return err('public-key');
  }
  const type = input.get(1);
  const algorithm = input.get(3);
  // Labels -1, -2, -3 mean (crv, x, y) for EC2 and OKP keys and (n, e) for RSA; `curve` and `first` are read by key type below.
  const curve = input.get(-1);
  const first = input.get(-2);
  const second = input.get(-3);
  let key: StoredKey | undefined;
  if (
    type === 2 &&
    algorithm === -7 &&
    curve === 1 &&
    first instanceof Uint8Array &&
    second instanceof Uint8Array &&
    first.length === 32 &&
    second.length === 32
  ) {
    key = { kind: 'ES256', x: encodeBase64url(first), y: encodeBase64url(second) };
  } else if (
    type === 3 &&
    algorithm === -257 &&
    curve instanceof Uint8Array &&
    first instanceof Uint8Array &&
    curve.length >= WEBAUTHN_LIMITS.rsaModulusBytesMin &&
    curve.length <= WEBAUTHN_LIMITS.rsaModulusBytesMax &&
    first.length >= 1 &&
    first.length <= 4
  ) {
    key = { kind: 'RS256', n: encodeBase64url(curve), e: encodeBase64url(first) };
  } else if (type === 1 && algorithm === -8 && curve === 6 && first instanceof Uint8Array && first.length === 32) {
    key = { kind: 'EdDSA', x: encodeBase64url(first) };
  }
  if (key === undefined) {
    return err('public-key');
  }
  // Importing proves the point is on the curve and the modulus is well formed.
  return (await importKey(key)) === undefined ? err('public-key') : ok(key);
}

async function importKey(key: StoredKey): Promise<CryptoKey | undefined> {
  try {
    switch (key.kind) {
      case 'ES256':
        return await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: key.x, y: key.y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      case 'RS256':
        return await crypto.subtle.importKey('jwk', { kty: 'RSA', n: key.n, e: key.e, alg: 'RS256' }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, [
          'verify',
        ]);
      case 'EdDSA':
        return await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: key.x }, { name: 'Ed25519' }, false, ['verify']);
    }
  } catch {
    return undefined;
  }
}

async function verifySignature(key: StoredKey, signature: Uint8Array, signed: Uint8Array): Promise<boolean> {
  const imported = await importKey(key);
  if (imported === undefined) {
    return false;
  }
  const data = new Uint8Array(signed);
  try {
    switch (key.kind) {
      case 'ES256': {
        const raw = derToRawSignature(signature);
        return raw !== undefined && (await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, imported, raw, data));
      }
      case 'RS256':
        return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', imported, new Uint8Array(signature), data);
      case 'EdDSA':
        return await crypto.subtle.verify('Ed25519', imported, new Uint8Array(signature), data);
    }
  } catch {
    return false;
  }
}

/** An ECDSA signature from ASN.1 DER (`SEQUENCE { INTEGER r, INTEGER s }`) to the 64-byte r||s Web Crypto verifies. Strict. */
export function derToRawSignature(der: Uint8Array): Uint8Array<ArrayBuffer> | undefined {
  if (der.length < 8 || der.length > 72 || der[0] !== 0x30 || der[1] !== der.length - 2) {
    return undefined;
  }
  const first = readInteger(der, 2);
  if (first === undefined) {
    return undefined;
  }
  const second = readInteger(der, first.end);
  if (second === undefined || second.end !== der.length) {
    return undefined;
  }
  const raw = new Uint8Array(64);
  raw.set(first.value, 32 - first.value.length);
  raw.set(second.value, 64 - second.value.length);
  return raw;
}

function readInteger(der: Uint8Array, offset: number): { readonly value: Uint8Array; readonly end: number } | undefined {
  if (der[offset] !== 0x02) {
    return undefined;
  }
  const length = der[offset + 1];
  if (length === undefined || length === 0 || length > 33 || offset + 2 + length > der.length) {
    return undefined;
  }
  let value = der.subarray(offset + 2, offset + 2 + length);
  // Negative numbers are not valid here, and a leading zero is allowed only to keep the sign bit clear.
  if (((value[0] ?? 0) & 0x80) !== 0) {
    return undefined;
  }
  if (value.length > 1 && value[0] === 0) {
    value = value.subarray(1);
  }
  return value.length > 32 ? undefined : { value, end: offset + 2 + length };
}

function concatenate(first: Uint8Array, second: Uint8Array): Uint8Array<ArrayBuffer> {
  const joined = new Uint8Array(first.length + second.length);
  joined.set(first, 0);
  joined.set(second, first.length);
  return joined;
}

/** A stored key read back from storage, or undefined when it is not one of the three shapes. */
export function parseStoredKey(input: unknown): StoredKey | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  const kind: unknown = Reflect.get(input, 'kind');
  const text = (name: string, bytesMax: number): string | undefined => {
    const value: unknown = Reflect.get(input, name);
    return typeof value === 'string' && decodeBase64url(value, bytesMax) !== undefined ? value : undefined;
  };
  if (kind === 'ES256') {
    const x = text('x', 32);
    const y = text('y', 32);
    return x === undefined || y === undefined ? undefined : { kind, x, y };
  }
  if (kind === 'RS256') {
    const n = text('n', WEBAUTHN_LIMITS.rsaModulusBytesMax);
    const e = text('e', 4);
    return n === undefined || e === undefined ? undefined : { kind, n, e };
  }
  if (kind === 'EdDSA') {
    const x = text('x', 32);
    return x === undefined ? undefined : { kind, x };
  }
  return undefined;
}
