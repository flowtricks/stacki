// Goal: each host adapter speaks its host's API exactly — the R2/S3 adapter
// (bucketStore.ts) and the Bunny Storage adapter (bunnyStore.ts) — so the
// panel's operations reach the right addresses, with the right signatures and
// headers, and read the hosts' answers (and refusals) correctly.
// Method: a fake fetch plays each host: it records every request and answers
// from canned S3 XML or Bunny JSON. The tests check the addresses, methods and
// headers sent (SigV4 Authorization, AccessKey, Checksum), how listings become
// folders and files (markers, the order manifest and unnameable keys hidden),
// public URLs, pagination, refusals turned into sentences, and the bounds.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { bucketStore, bucketAddress, objectAddress, xmlValue } from '#dist/electron/content/media/bucketStore.js';
import { bunnyStore, bunnyStorageHost, parseBunnyListing } from '#dist/electron/content/media/bunnyStore.js';
import { storeFor } from '#dist/electron/content/media/mediaStore.js';
import { MediaHostError, exactBuffer, readBounded } from '#dist/electron/content/media/mediaHttp.js';

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: Uint8Array | undefined;
}

type Answer = { readonly status?: number; readonly body?: string | Uint8Array; readonly type?: string };

function fakeFetch(answer: (request: Sent) => Answer) {
  const sent: Sent[] = [];
  const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([name, value]) => [name.toLowerCase(), String(value)]));
    const body = init.body instanceof ArrayBuffer ? new Uint8Array(init.body) : undefined;
    const request = { url, method: init.method ?? 'GET', headers, body };
    sent.push(request);
    const reply = answer(request);
    const status = reply.status ?? 200;
    return new Response(status === 204 ? undefined : responseBody(reply.body), { status, headers: { 'content-type': reply.type ?? 'application/xml' } });
  };
  return { sent, fetcher };
}

function responseBody(body: string | Uint8Array | undefined): string | ArrayBuffer {
  return body instanceof Uint8Array ? exactBuffer(body) : (body ?? '');
}

const KEYS = { accessKeyId: 'AKID', secretAccessKey: 'secret' };
const NOW = () => new Date('2025-02-03T04:05:06Z');
const TARGET = {
  host: 'R2',
  endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
  region: 'auto',
  bucket: 'media',
  addressing: 'path' as const,
  publicBaseUrl: 'https://pub.example.dev',
};

const LISTING = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Name>media</Name><Prefix>images/</Prefix><IsTruncated>false</IsTruncated>
  <Contents><Key>images/</Key><Size>0</Size></Contents>
  <Contents><Key>images/hero &amp; co.png</Key><Size>2048</Size><LastModified>2025-01-01T00:00:00.000Z</LastModified></Contents>
  <Contents><Key>images/.stacki-order.json</Key><Size>40</Size></Contents>
  <Contents><Key>images/bad&#x1;name.png</Key><Size>1</Size></Contents>
  <CommonPrefixes><Prefix>images/2024/</Prefix></CommonPrefixes>
</ListBucketResult>`;

test('R2: a folder lists its files and subfolders; markers, the manifest and unnameable keys are hidden', async () => {
  const host = fakeFetch(() => ({ body: LISTING }));
  const store = bucketStore(TARGET, KEYS, { fetch: host.fetcher, now: NOW });
  const listed = await store.list('images');
  assert.deepEqual(listed.folders, ['2024']);
  assert.deepEqual(
    listed.files.map((file) => file.name),
    ['hero & co.png'],
  );
  assert.equal(listed.files[0]?.sizeBytes, 2048);
  assert.equal(listed.truncated, false);
  const [request] = host.sent;
  const url = new URL(request?.url ?? '');
  assert.equal(url.pathname, '/media');
  assert.equal(url.searchParams.get('list-type'), '2');
  assert.equal(url.searchParams.get('prefix'), 'images/');
  assert.equal(url.searchParams.get('delimiter'), '/');
  assert.match(
    request?.headers['authorization'] ?? '',
    /^AWS4-HMAC-SHA256 Credential=AKID\/20250203\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/,
  );
  assert.equal(request?.headers['host'], undefined, 'fetch sets Host itself');
  assert.equal(store.publicURL('images/hero & co.png'), 'https://pub.example.dev/images/hero%20%26%20co.png');
});

test('R2: listings follow continuation tokens, and stop at the bound', async () => {
  let page = 0;
  const host = fakeFetch(() => {
    page++;
    return {
      body: `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t${page}</NextContinuationToken><Contents><Key>f${page}.png</Key><Size>1</Size></Contents></ListBucketResult>`,
    };
  });
  const listed = await bucketStore(TARGET, KEYS, { fetch: host.fetcher, now: NOW }).list('');
  assert.equal(listed.truncated, true);
  assert.ok(host.sent.length > 1 && host.sent.length <= 8, `pages read: ${host.sent.length}`);
  assert.equal(new URL(host.sent[1]?.url ?? '').searchParams.get('continuation-token'), 't1');
});

test('R2: writes, copies and deletes go to the object, signed over their bodies', async () => {
  const host = fakeFetch((request) => ({ status: request.method === 'DELETE' ? 204 : 200, body: '<CopyObjectResult/>' }));
  const store = bucketStore(TARGET, KEYS, { fetch: host.fetcher, now: NOW });
  const bytes = new TextEncoder().encode('picture');
  await store.write('images/a b.png', bytes, 'image/png');
  await store.copy('images/a b.png', 'images/c.png');
  await store.remove('images/a b.png');
  await store.createFolder('images/new');
  const [put, copy, remove, folder] = host.sent;
  assert.equal(put?.method, 'PUT');
  assert.equal(new URL(put?.url ?? '').pathname, '/media/images/a%20b.png');
  assert.equal(put?.headers['x-amz-content-sha256'], createHash('sha256').update(bytes).digest('hex'));
  assert.equal(put?.headers['content-type'], 'image/png');
  assert.deepEqual([...(put?.body ?? [])], [...bytes]);
  assert.equal(copy?.headers['x-amz-copy-source'], '/media/images/a%20b.png');
  assert.equal(remove?.method, 'DELETE');
  assert.equal(new URL(folder?.url ?? '').pathname, '/media/images/new/', 'an empty folder is a marker object');
});

test('R2: a refusal is a sentence with the host’s own code; a copy refused inside a 200 still fails', async () => {
  const refused = fakeFetch(() => ({ status: 403, body: '<Error><Code>SignatureDoesNotMatch</Code><Message>Bad key</Message></Error>' }));
  await assert.rejects(bucketStore(TARGET, KEYS, { fetch: refused.fetcher, now: NOW }).list(''), (error: unknown) => {
    assert.ok(error instanceof MediaHostError);
    assert.match(error.message, /refused the keys.*R2 said SignatureDoesNotMatch: Bad key/);
    return true;
  });
  const sneaky = fakeFetch(() => ({ body: '<Error><Code>InternalError</Code></Error>' }));
  await assert.rejects(bucketStore(TARGET, KEYS, { fetch: sneaky.fetcher, now: NOW }).copy('a.png', 'b.png'), /InternalError/);
  const offline = await bucketStore(TARGET, KEYS, {
    fetch: () => Promise.reject(new Error('getaddrinfo ENOTFOUND')),
    now: NOW,
  })
    .list('')
    .catch((error: unknown) => error);
  assert.ok(offline instanceof MediaHostError);
  assert.match(offline.message, /Could not reach .*r2\.cloudflarestorage\.com: getaddrinfo ENOTFOUND/);
  const missing = fakeFetch(() => ({ status: 404 }));
  assert.equal(await bucketStore(TARGET, KEYS, { fetch: missing.fetcher, now: NOW }).read('nope.json', 10), undefined);
});

test('S3 addressing: path style and virtual-hosted style', () => {
  assert.equal(
    objectAddress({ endpoint: 'https://s3.us-east-1.amazonaws.com', bucket: 'media', addressing: 'virtual' }, 'a/b c.png').toString(),
    'https://media.s3.us-east-1.amazonaws.com/a/b%20c.png',
  );
  assert.equal(
    objectAddress({ endpoint: 'http://localhost:9000', bucket: 'media', addressing: 'path' }, 'x.png').toString(),
    'http://localhost:9000/media/x.png',
  );
  assert.equal(
    bucketAddress({ endpoint: 'https://s3.example.com', bucket: 'media', addressing: 'virtual' }, { prefix: 'a/' }).toString(),
    'https://media.s3.example.com/?prefix=a%2F',
  );
  assert.equal(xmlValue('<a>&lt;&#65;&gt;</a>', 'a'), '<A>');
  assert.throws(() => objectAddress({ endpoint: 'https://s3.example.com', bucket: 'b', addressing: 'path' }, ''), /Assertion failed: An object has a key/);
});

test('storeFor: R2 targets its account endpoint with region auto; a mismatched key is a programmer error', async () => {
  const host = fakeFetch(() => ({ body: '<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>' }));
  const store = storeFor(
    {
      kind: 'r2',
      id: '00000000-0000-4000-8000-000000000000',
      label: 'R',
      accountId: 'f'.repeat(32),
      bucket: 'media',
      publicBaseUrl: 'https://cdn.example.com',
    },
    { kind: 'keyPair', ...KEYS },
    { fetch: host.fetcher, now: NOW },
  );
  await store.list('');
  assert.equal(new URL(host.sent[0]?.url ?? '').host, `${'f'.repeat(32)}.r2.cloudflarestorage.com`);
  assert.throws(
    () =>
      storeFor(
        {
          kind: 'r2',
          id: '00000000-0000-4000-8000-000000000000',
          label: 'R',
          accountId: 'f'.repeat(32),
          bucket: 'media',
          publicBaseUrl: 'https://cdn.example.com',
        },
        { kind: 'accessKey', accessKey: 'x' },
        { fetch: host.fetcher, now: NOW },
      ),
    /Assertion failed: R2 signs with a key pair/,
  );
});

const BUNNY = { storageZone: 'site-zone', region: 'ny' as const, publicBaseUrl: 'https://site.b-cdn.net' };

test('Bunny: a folder lists as JSON with the zone password; directories, sizes and UTC times read', async () => {
  const host = fakeFetch(() => ({
    type: 'application/json',
    body: JSON.stringify([
      { ObjectName: '2024', IsDirectory: true, Length: 0, LastChanged: '2025-01-01T00:00:00' },
      { ObjectName: 'hero.png', IsDirectory: false, Length: 512, LastChanged: '2025-01-02T03:04:05.000' },
      { ObjectName: '.stacki-order.json', IsDirectory: false, Length: 30 },
    ]),
  }));
  const store = bunnyStore(BUNNY, 'zone-password', host.fetcher);
  const listed = await store.list('images');
  assert.deepEqual(listed.folders, ['2024']);
  assert.deepEqual(listed.files, [{ name: 'hero.png', sizeBytes: 512, modified: '2025-01-02T03:04:05.000Z' }]);
  assert.equal(host.sent[0]?.url, 'https://ny.storage.bunnycdn.com/site-zone/images/');
  assert.equal(host.sent[0]?.headers['accesskey'], 'zone-password');
  assert.equal(bunnyStorageHost('de'), 'storage.bunnycdn.com');
  assert.equal(store.publicURL('images/hero.png'), 'https://site.b-cdn.net/images/hero.png');
  assert.throws(() => parseBunnyListing({ not: 'a list' }), /not a list/);
  assert.throws(() => parseBunnyListing([{ ObjectName: 1 }]), /unreadable/);
});

test('Bunny: uploads carry their SHA-256; a copy is a download and an upload; a folder deletes whole', async () => {
  const bytes = new TextEncoder().encode('song');
  const host = fakeFetch((request) => (request.method === 'GET' ? { body: bytes, type: 'audio/mpeg' } : { status: 201, body: '{}' }));
  const store = bunnyStore(BUNNY, 'zone-password', host.fetcher);
  await store.write('a.mp3', bytes, 'audio/mpeg');
  assert.equal(host.sent[0]?.headers['checksum'], createHash('sha256').update(bytes).digest('hex').toUpperCase());
  await store.copy('a.mp3', 'b.mp3');
  assert.deepEqual(
    host.sent.slice(1).map((request) => `${request.method} ${new URL(request.url).pathname}`),
    ['GET /site-zone/a.mp3', 'PUT /site-zone/b.mp3'],
  );
  await store.removeFolder('old');
  assert.equal(host.sent.at(-1)?.method, 'DELETE');
  assert.equal(host.sent.at(-1)?.url, 'https://ny.storage.bunnycdn.com/site-zone/old/');
});

test('Bunny: a tree walk keeps every entry, nameable or not, and stops at its bound', async () => {
  const host = fakeFetch((request) => ({
    type: 'application/json',
    body: request.url.endsWith('/top/')
      ? JSON.stringify([
          { ObjectName: 'sub', IsDirectory: true },
          { ObjectName: '.stacki-order.json', IsDirectory: false, Length: 2 },
        ])
      : JSON.stringify([{ ObjectName: 'deep.png', IsDirectory: false, Length: 2 }]),
  }));
  const store = bunnyStore(BUNNY, 'zone-password', host.fetcher);
  assert.deepEqual(await store.keysUnder('top', 10), ['sub/', '.stacki-order.json', 'sub/deep.png']);
  await assert.rejects(store.keysUnder('top', 1), /more than 1 files/);
});

test('bodies are refused past their bound while they stream', async () => {
  await assert.rejects(readBounded(new Response('x'.repeat(100)), 10), /more than/);
  assert.equal((await readBounded(new Response('hello'), 10)).length, 5);
});

test('an upload sends exactly its bytes, even from a Buffer that views a shared pool', async () => {
  const host = fakeFetch(() => ({ status: 200 }));
  // Small Buffers are slices of one 8 KB pool; sending `.buffer` would upload the pool.
  const pooled = Buffer.from('pic');
  assert.ok(pooled.buffer.byteLength > pooled.length, 'the Buffer is a view into a pool');
  await bucketStore(TARGET, KEYS, { fetch: host.fetcher, now: NOW }).write('a.png', pooled, 'image/png');
  assert.equal(host.sent[0]?.body?.length, 3);
});
