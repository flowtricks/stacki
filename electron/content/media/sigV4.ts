// AWS Signature Version 4 for S3-style APIs (Cloudflare R2, AWS S3, and the
// S3-compatible hosts). Hand-rolled on Node's crypto rather than the AWS SDK:
// signing is one small, fully specified algorithm, while the SDK is a large
// dependency tree for the five requests the Assets panel makes. It is checked
// against AWS's published examples (test/electron/content/media/sigV4.test.ts).
//
// Canonical paths are encoded once per segment, as S3 requires (other AWS
// services double-encode; nothing here talks to them).

import { createHash, createHmac } from 'node:crypto';
import { assert } from '../../../shared/core/assert';

export interface SigningKeys {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface SignableRequest {
  readonly method: 'GET' | 'PUT' | 'DELETE' | 'HEAD' | 'POST';
  readonly url: URL;
  /** Headers to sign besides host and the x-amz ones this adds; lower-case names. */
  readonly headers: Readonly<Record<string, string>>;
  /** Hex SHA-256 of the body, or UNSIGNED-PAYLOAD. */
  readonly payloadHash: string;
}

export interface SigningScope {
  readonly region: string;
  readonly service: string;
  /** The signing time; a request is valid for 15 minutes around it. */
  readonly date: Date;
}

// Headers a request carries this many of, at most, including the ones added here.
const SIGNED_HEADERS_MAX = 32;

export const EMPTY_PAYLOAD_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** The request's headers with x-amz-date, x-amz-content-sha256 and Authorization added. */
export function signRequest(request: SignableRequest, keys: SigningKeys, scope: SigningScope): Readonly<Record<string, string>> {
  assert(request.url.protocol === 'https:' || request.url.protocol === 'http:', 'A signed request is http(s)');
  assert(/^[a-f0-9]{64}$|^UNSIGNED-PAYLOAD$/.test(request.payloadHash), 'The payload hash is hex SHA-256');
  const amzDate = amzTime(scope.date);
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...request.headers,
    host: request.url.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': request.payloadHash,
  };
  const names = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
  assert(names.length <= SIGNED_HEADERS_MAX, 'A request signs a bounded set of headers');
  assert(new Set(names).size === names.length, 'Header names are unique ignoring case');
  const signedHeaders = names.join(';');
  const canonical = canonicalRequest(request, headers, names, signedHeaders);
  const credentialScope = `${day}/${scope.region}/${scope.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonical)].join('\n');
  const signingKey = deriveKey(keys.secretAccessKey, day, scope.region, scope.service);
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  assert(signature.length === 64, 'A signature is 32 bytes of hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${keys.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** The canonical request AWS hashes; exported for the published test vectors. */
export function canonicalRequest(
  request: Pick<SignableRequest, 'method' | 'url' | 'payloadHash'>,
  headers: Readonly<Record<string, string>>,
  names: readonly string[],
  signedHeaders: string,
): string {
  const lowered = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  const headerLines = names.map((name) => {
    const value = lowered.get(name);
    assert(value !== undefined, 'Every signed header has a value');
    return `${name}:${value.trim().replace(/\s+/g, ' ')}\n`;
  });
  return [request.method, canonicalPath(request.url.pathname), canonicalQuery(request.url), headerLines.join(''), signedHeaders, request.payloadHash].join(
    '\n',
  );
}

// The path as sent, decoded and re-encoded once per segment so that every
// spelling of the same key signs the same way.
function canonicalPath(pathname: string): string {
  const path = pathname === '' ? '/' : pathname;
  return path
    .split('/')
    .map((segment) => uriEncode(decodeURIComponent(segment)))
    .join('/');
}

function canonicalQuery(url: URL): string {
  const pairs = [...url.searchParams.entries()].map(([name, value]) => [uriEncode(name), uriEncode(value)] as const);
  pairs.sort(([leftName, leftValue], [rightName, rightValue]) => compare(leftName, rightName) || compare(leftValue, rightValue));
  return pairs.map(([name, value]) => `${name}=${value}`).join('&');
}

function compare(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

/** RFC 3986 encoding: everything but A–Z a–z 0–9 - . _ ~ is percent-encoded, in upper case. */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function deriveKey(secret: string, day: string, region: string, service: string): Buffer {
  const dateKey = createHmac('sha256', `AWS4${secret}`).update(day, 'utf8').digest();
  const regionKey = createHmac('sha256', dateKey).update(region, 'utf8').digest();
  const serviceKey = createHmac('sha256', regionKey).update(service, 'utf8').digest();
  return createHmac('sha256', serviceKey).update('aws4_request', 'utf8').digest();
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 20150830T123600Z: the ISO basic format SigV4 dates use. */
export function amzTime(date: Date): string {
  assert(Number.isFinite(date.getTime()), 'A signing time is a real time');
  const time = date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  assert(/^\d{8}T\d{6}Z$/.test(time), 'An AWS time is in ISO basic format');
  return time;
}
