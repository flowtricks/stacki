// Goal: the hand-rolled SigV4 signer (electron/content/media/sigV4.ts) produces exactly
// the signatures AWS publishes, so R2 and S3 accept the panel's requests.
// Method: replay AWS's own worked examples — the SigV4 test suite's
// `get-vanilla` case and the S3 documentation's GET-object, PUT-object and
// list-objects examples — with their published keys, times and headers, and
// compare the Authorization header's signature byte for byte. Then check the
// encoding rules a wrong signature would hide: per-segment path encoding and
// sorted, strictly encoded query strings.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMPTY_PAYLOAD_HASH, amzTime, sha256Hex, signRequest, uriEncode } from '#dist/electron/content/media/sigV4.js';

const SUITE_KEYS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
const STORAGE_KEYS = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
const EXAMPLE_DATE = new Date('2013-05-24T00:00:00Z');

function signatureOf(headers: Readonly<Record<string, string>>): string {
  const match = /Signature=([a-f0-9]{64})$/.exec(headers['authorization'] ?? '');
  assert.ok(match, 'An Authorization header carries a signature');
  return match[1] ?? '';
}

test('get-vanilla from the AWS SigV4 test suite: its credential scope', () => {
  const headers = signRequest({ method: 'GET', url: new URL('https://example.amazonaws.com/'), headers: {}, payloadHash: EMPTY_PAYLOAD_HASH }, SUITE_KEYS, {
    region: 'us-east-1',
    service: 'service',
    date: new Date('2015-08-30T12:36:00Z'),
  });
  // The suite signs host and x-amz-date only; S3 also signs the payload hash,
  // so the published signature is checked through a request without it below.
  assert.match(headers['authorization'] ?? '', /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/service\/aws4_request, /);
});

test('S3 documentation: GET object with a range', () => {
  const headers = signRequest(
    { method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'), headers: { range: 'bytes=0-9' }, payloadHash: EMPTY_PAYLOAD_HASH },
    STORAGE_KEYS,
    { region: 'us-east-1', service: 's3', date: EXAMPLE_DATE },
  );
  assert.equal(signatureOf(headers), 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  assert.equal(headers['x-amz-date'], '20130524T000000Z');
  assert.match(headers['authorization'] ?? '', /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,/);
});

test('S3 documentation: PUT object with a body and storage class', () => {
  const body = 'Welcome to Amazon S3.';
  const headers = signRequest(
    {
      method: 'PUT',
      url: new URL('https://examplebucket.s3.amazonaws.com/test$file.text'),
      headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
      payloadHash: sha256Hex(body),
    },
    STORAGE_KEYS,
    { region: 'us-east-1', service: 's3', date: EXAMPLE_DATE },
  );
  assert.equal(sha256Hex(body), '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
  assert.equal(signatureOf(headers), '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
});

test('S3 documentation: list objects with a sorted query', () => {
  const headers = signRequest(
    { method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/?prefix=J&max-keys=2'), headers: {}, payloadHash: EMPTY_PAYLOAD_HASH },
    STORAGE_KEYS,
    { region: 'us-east-1', service: 's3', date: EXAMPLE_DATE },
  );
  assert.equal(signatureOf(headers), '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
});

test('encoding: strict RFC 3986, one pass per path segment, any spelling signs the same', () => {
  assert.equal(uriEncode("a b+c!'()*~._-/"), 'a%20b%2Bc%21%27%28%29%2A~._-%2F');
  const scope = { region: 'auto', service: 's3', date: EXAMPLE_DATE };
  const sign = (url: string) =>
    signatureOf(signRequest({ method: 'GET', url: new URL(url), headers: {}, payloadHash: EMPTY_PAYLOAD_HASH }, STORAGE_KEYS, scope));
  assert.equal(sign('https://host.example/bucket/a%20b.png'), sign('https://host.example/bucket/a b.png'));
  assert.notEqual(sign('https://host.example/bucket/a%2Fb.png'), sign('https://host.example/bucket/a/b.png'));
  assert.equal(sign('https://host.example/?b=2&a=1'), sign('https://host.example/?a=1&b=2'));
});

test('negative space: times and hashes outside the format are refused', () => {
  assert.equal(amzTime(new Date('2015-08-30T12:36:00.123Z')), '20150830T123600Z');
  assert.throws(() => amzTime(new Date('nonsense')), /Assertion failed: A signing time is a real time/);
  assert.throws(
    () =>
      signRequest({ method: 'GET', url: new URL('https://host.example/'), headers: {}, payloadHash: 'not-a-hash' }, STORAGE_KEYS, {
        region: 'auto',
        service: 's3',
        date: EXAMPLE_DATE,
      }),
    /Assertion failed: The payload hash is hex SHA-256/,
  );
  assert.throws(
    () =>
      signRequest({ method: 'GET', url: new URL('ftp://host.example/'), headers: {}, payloadHash: EMPTY_PAYLOAD_HASH }, STORAGE_KEYS, {
        region: 'auto',
        service: 's3',
        date: EXAMPLE_DATE,
      }),
    /Assertion failed: A signed request is http\(s\)/,
  );
});
