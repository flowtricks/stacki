// Goal: validate an OpenID Connect ID token, and nothing else. Parsing is strict (three base64url segments, bounded, JSON
// objects), the signature algorithm comes from an allow-list that the KEY must also match (RS256 with an RSA key, ES256
// with a P-256 key), and every claim core relies on is checked: issuer, audience, expiry, not-before, nonce, `at_hash`.
// Why an allow-list and a key-bound algorithm: `alg: none` and "verify an RS256 token with the public key as an HMAC secret"
// are the classic ways a token check is bypassed. Here the header chooses nothing the key does not already allow.
import { err, ok, type Result } from '../../../../vendor/stacki/shared/core/result';
import { decodeBase64url, encodeBase64url, sameText, sha256, utf8Bytes } from './base64url';

export const JWT_LIMITS = {
  tokenCharsMax: 16_384,
  segmentCharsMax: 8_192,
  /** Allowed difference between the identity service's clock and the Worker's. */
  clockSkewMs: 60_000,
  subjectCharsMax: 255,
  /** An RSA modulus below 2048 bits is too weak to trust; above 8192 it is a denial-of-service shape. */
  rsaModulusBytesMin: 256,
  rsaModulusBytesMax: 1_024,
  signatureBytesMax: 1_024,
} as const satisfies Record<string, number>;

export const JWT_ALGORITHMS = ['RS256', 'ES256'] as const;
export type JwtAlgorithm = (typeof JWT_ALGORITHMS)[number];

export type JwtFailure =
  'malformed' | 'algorithm' | 'key-unknown' | 'signature' | 'issuer' | 'audience' | 'expired' | 'not-yet-valid' | 'nonce' | 'at-hash' | 'claims';

/** A public key the Worker may verify with: its JWK, which algorithm it is for, and its `kid`. */
export interface JwtKey {
  readonly kid: string | undefined;
  readonly algorithm: JwtAlgorithm;
  readonly jwk: JsonWebKey;
}

export interface ParsedJwt {
  readonly algorithm: JwtAlgorithm;
  readonly kid: string | undefined;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly signedBytes: Uint8Array<ArrayBuffer>;
  readonly signature: Uint8Array<ArrayBuffer>;
}

export function parseJwt(token: string): Result<ParsedJwt, JwtFailure> {
  if (token.length === 0 || token.length > JWT_LIMITS.tokenCharsMax) {
    return err('malformed');
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    return err('malformed');
  }
  const [headerText = '', payloadText = '', signatureText = ''] = parts;
  if (headerText.length > JWT_LIMITS.segmentCharsMax || payloadText.length > JWT_LIMITS.segmentCharsMax) {
    return err('malformed');
  }
  const header = jsonSegment(headerText);
  const payload = jsonSegment(payloadText);
  const signature = decodeBase64url(signatureText, JWT_LIMITS.signatureBytesMax);
  if (header === undefined || payload === undefined) {
    return err('malformed');
  }
  const algorithm = header['alg'];
  const algorithmAllowed = JWT_ALGORITHMS.find((allowed) => allowed === algorithm);
  if (algorithmAllowed === undefined) {
    // Includes `none`, HS256 and every algorithm Studio does not verify; refused before the signature is even looked at.
    return err('algorithm');
  }
  if (signature === undefined || signature.length === 0) {
    return err('malformed');
  }
  const kid = header['kid'];
  if (kid !== undefined && (typeof kid !== 'string' || kid.length === 0 || kid.length > 200)) {
    return err('malformed');
  }
  return ok({ algorithm: algorithmAllowed, kid, payload, signedBytes: utf8Bytes(`${headerText}.${payloadText}`), signature });
}

function jsonSegment(text: string): Record<string, unknown> | undefined {
  const bytes = decodeBase64url(text, JWT_LIMITS.segmentCharsMax);
  if (bytes === undefined) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;
  } catch {
    return undefined;
  }
}

/** Whether `key` signed `token`. A key for another algorithm than the token's header never verifies it. */
export async function verifyJwtSignature(token: ParsedJwt, key: JwtKey): Promise<boolean> {
  if (key.algorithm !== token.algorithm) {
    return false;
  }
  try {
    if (token.algorithm === 'RS256') {
      const imported = await crypto.subtle.importKey('jwk', key.jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
      return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', imported, token.signature, token.signedBytes);
    }
    // A JWS ES256 signature is the fixed 64-byte r||s, which is the form Web Crypto verifies.
    if (token.signature.length !== 64) {
      return false;
    }
    const imported = await crypto.subtle.importKey('jwk', key.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, imported, token.signature, token.signedBytes);
  } catch {
    return false;
  }
}

export interface IdTokenExpectation {
  /** Exact `iss` values accepted: one for OIDC, two spellings for Google. */
  readonly issuers: readonly string[];
  readonly audience: string;
  /** The nonce this sign-in sent. Absent only for tokens that carry none (Cloudflare Access). */
  readonly nonce: string | undefined;
  readonly nowMs: number;
  /** The access token returned with the ID token: when both carry `at_hash`, they must agree. */
  readonly accessToken?: string | undefined;
  /** Cloudflare Access service tokens carry an empty `sub`. */
  readonly subjectOptional?: boolean;
}

export interface IdTokenClaims {
  readonly subject: string;
  readonly email: string | undefined;
  readonly emailVerified: boolean;
  readonly name: string | undefined;
  readonly picture: string | undefined;
  readonly hostedDomain: string | undefined;
}

export async function validateIdTokenClaims(
  payload: Readonly<Record<string, unknown>>,
  expected: IdTokenExpectation,
): Promise<Result<IdTokenClaims, JwtFailure>> {
  const issuer = payload['iss'];
  if (typeof issuer !== 'string' || !expected.issuers.includes(issuer)) {
    return err('issuer');
  }
  if (!audienceMatches(payload, expected.audience)) {
    return err('audience');
  }
  const exp = seconds(payload['exp']);
  if (exp === undefined) {
    return err('claims');
  }
  if (expected.nowMs > exp * 1000 + JWT_LIMITS.clockSkewMs) {
    return err('expired');
  }
  for (const name of ['nbf', 'iat']) {
    const present = payload[name];
    if (present !== undefined) {
      const value = seconds(present);
      if (value === undefined) {
        return err('claims');
      }
      if (value * 1000 > expected.nowMs + JWT_LIMITS.clockSkewMs) {
        return err('not-yet-valid');
      }
    }
  }
  const nonce = payload['nonce'];
  if (expected.nonce !== undefined && (typeof nonce !== 'string' || !sameText(nonce, expected.nonce))) {
    return err('nonce');
  }
  const atHash = payload['at_hash'];
  if (atHash !== undefined && expected.accessToken !== undefined) {
    const digest = await sha256(utf8Bytes(expected.accessToken));
    if (typeof atHash !== 'string' || !sameText(atHash, encodeBase64url(digest.slice(0, 16)))) {
      return err('at-hash');
    }
  }
  const subject = payload['sub'];
  const subjectEmpty = typeof subject === 'string' && subject.length === 0 && expected.subjectOptional === true;
  if (typeof subject !== 'string' || (subject.length === 0 && !subjectEmpty) || subject.length > JWT_LIMITS.subjectCharsMax) {
    return err('claims');
  }
  return ok({
    subject,
    email: text(payload['email'], 254),
    emailVerified: payload['email_verified'] === true || payload['email_verified'] === 'true',
    name: text(payload['name'], 200),
    picture: text(payload['picture'], 500),
    hostedDomain: text(payload['hd'], 253),
  });
}

function audienceMatches(payload: Readonly<Record<string, unknown>>, clientId: string): boolean {
  const audience = payload['aud'];
  if (typeof audience === 'string') {
    return audience === clientId;
  }
  if (!Array.isArray(audience) || audience.length === 0 || audience.length > 10) {
    return false;
  }
  const values: readonly unknown[] = audience;
  // With several audiences OIDC Core requires `azp` to name this client, so a token minted for another client is refused.
  return values.includes(clientId) && (audience.length === 1 || payload['azp'] === clientId);
}

function seconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1e11 ? value : undefined;
}

function text(value: unknown, maximum: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : undefined;
}
