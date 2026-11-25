// Goal: Studio hosts media connections as Desktop does without ever exposing a
// key — the Worker stores keys encrypted and hands the container a target for
// one media call only, never one a client sent; a local Studio keeps its own
// private file; the container believes a target only on a request carrying the
// container token; and the panel's operations (list, upload, replace) run on
// the server with Desktop's own adapters and signer.
// Method: the connection book's rules are checked directly; the Worker's
// forwarding runs against an in-memory R2; the container's routes run over real
// HTTP with R2 played by an injected fetch, in local and deployed modes.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MEDIA_TARGET_HEADER, parseMediaTarget, publicMediaList, secretText, withMediaConnection } from '../src/features/assets/mediaConnectionBook';
import { mediaForwarded, storedMediaConnections } from '../src/features/assets/mediaConnectionVault';
import { CmsUnavailable, sealCmsSecret, type Vault } from '../src/features/cms/cmsConnectionVault';
import { mediaHostingRoutes } from '../src/features/assets/mediaHostingServer';

const SECRET = { kind: 'keyPair' as const, accessKeyId: 'AKID', secretAccessKey: 'r2-secret-key' };
const DRAFT = {
  kind: 'r2' as const,
  label: 'Site media',
  accountId: 'a'.repeat(32),
  bucket: 'media',
  publicBaseUrl: 'https://cdn.example.com',
  secret: SECRET,
};

test('one connection per bucket, never more than the limit, and no key in the list', () => {
  const first = withMediaConnection([], DRAFT, { id: '00000000-0000-4000-8000-000000000001', secret: 'sealed-1' });
  const second = withMediaConnection(first, { ...DRAFT, label: 'Again' }, { id: '00000000-0000-4000-8000-000000000002', secret: 'sealed-2' });
  assert.equal(second.length, 1, 'the same account and bucket replaces the old one');
  assert.equal(second[0]?.connection.label, 'Again');
  assert.equal(JSON.stringify(publicMediaList(second)).includes('sealed'), false, 'keys never listed');
  assert.throws(() => parseMediaTarget({ connection: second[0]?.connection, secret: { kind: 'keyPair', accessKeyId: '', secretAccessKey: 'x' } }), /Paste/);
});

function fakeVault(sessionSecret = 'session-secret'): Vault & { objects: Map<string, string> } {
  const objects = new Map<string, string>();
  return {
    sessionSecret,
    objects,
    store: {
      get: async (key) => {
        const value = objects.get(key);
        return value === undefined ? null : { text: async () => value };
      },
      put: async (key, value) => objects.set(key, value),
    },
  };
}

test('the Worker removes a client target and adds its own, decrypted, for media calls only', async () => {
  const vault = fakeVault();
  const id = '00000000-0000-4000-8000-000000000003';
  const sealed = await sealCmsSecret(vault, secretText(SECRET));
  assert.equal(sealed.includes(SECRET.secretAccessKey), false, 'the stored keys are ciphertext');
  vault.objects.set('media/connections.json', JSON.stringify(withMediaConnection([], DRAFT, { id, secret: sealed })));
  assert.equal((await storedMediaConnections(vault)).length, 1);
  const forged = {
    [MEDIA_TARGET_HEADER]: JSON.stringify({ connection: { ...DRAFT, id }, secret: { kind: 'keyPair', accessKeyId: 'EVIL', secretAccessKey: 'x' } }),
  };
  const page = new Request('https://studio.test/studio/api/pages', { headers: forged });
  assert.equal((await mediaForwarded(page, new URL(page.url), vault)).headers.get(MEDIA_TARGET_HEADER), null, 'a client target never passes');
  const call = new Request('https://studio.test/studio/api/media-hosting/list', {
    method: 'POST',
    headers: { ...forged, 'x-stacki-media-connection': id },
    body: '{"folder":""}',
  });
  const forwarded = await mediaForwarded(call, new URL(call.url), vault);
  const target = parseMediaTarget(JSON.parse(forwarded.headers.get(MEDIA_TARGET_HEADER) ?? '{}'));
  assert.deepEqual(target.secret, SECRET);
  assert.equal(target.connection.kind === 'r2' ? target.connection.bucket : '', 'media');
  const rotated = fakeVault('another-secret');
  rotated.objects.set('media/connections.json', vault.objects.get('media/connections.json') ?? '');
  const again = new Request(call.url, { method: 'POST', headers: { 'x-stacki-media-connection': id }, body: '{}' });
  await assert.rejects(() => mediaForwarded(again, new URL(again.url), rotated), CmsUnavailable);
  const removed = new Request(call.url, { method: 'POST', headers: { 'x-stacki-media-connection': '00000000-0000-4000-8000-00000000000f' }, body: '{}' });
  await assert.rejects(() => mediaForwarded(removed, new URL(removed.url), vault), /was removed/);
});

const LISTING = `<ListBucketResult><IsTruncated>false</IsTruncated>
  <Contents><Key>hero.png</Key><Size>3</Size><LastModified>2025-01-01T00:00:00.000Z</LastModified></Contents>
  <CommonPrefixes><Prefix>press/</Prefix></CommonPrefixes></ListBucketResult>`;

// R2 as the injected fetch sees it: listings, and puts recorded with their bodies.
function fakeR2() {
  const calls: { method: string; url: string; authorization: string; bytes: number }[] = [];
  const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    const bytes = init.body instanceof ArrayBuffer ? init.body.byteLength : 0;
    calls.push({ method: init.method ?? 'GET', url, authorization: headers.get('authorization') ?? '', bytes });
    if (init.method === 'GET' && url.includes('list-type=2')) {
      return new Response(LISTING, { headers: { 'content-type': 'application/xml' } });
    }
    return new Response('', { status: 200 });
  };
  return { calls, fetcher };
}

async function serve(root: string, options: Parameters<typeof mediaHostingRoutes>[1]): Promise<{ server: Server; base: string }> {
  const route = mediaHostingRoutes(root, options);
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://studio').pathname;
    const readBody = async () => {
      let body = '';
      for await (const chunk of request) {
        body += String(chunk);
      }
      return body;
    };
    void route(request, response, pathname, readBody).then((handled) => {
      if (!handled) {
        response.writeHead(404).end();
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { server, base: `http://127.0.0.1:${address.port}` };
}

test('a local Studio tries, keeps and uses its connections privately, with Desktop’s R2 adapter', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-media-'));
  const home = await mkdtemp(path.join(tmpdir(), 'studio-media-home-'));
  delete process.env['STUDIO_CONTAINER_TOKEN'];
  const r2 = fakeR2();
  const { server, base } = await serve(root, { fetch: r2.fetcher, home });
  try {
    const post = (url: string, body: BodyInit, headers: Record<string, string> = {}) =>
      fetch(base + url, { method: 'POST', body, headers }).then((response) => response.json() as Promise<Record<string, unknown>>);
    const saved = await post('/studio/api/media-connections/save', JSON.stringify({ draft: DRAFT }));
    assert.equal(saved['ok'], true, JSON.stringify(saved));
    assert.equal(JSON.stringify(saved).includes(SECRET.secretAccessKey), false, 'the keys are not returned');
    assert.match(r2.calls[0]?.authorization ?? '', /^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/auto\/s3\/aws4_request/, 'the connection was tried, signed');
    const kept = path.join(home, '.stacki', 'studio-media');
    const [file = ''] = await readdir(kept);
    if (process.platform !== 'win32') {
      assert.equal((await stat(path.join(kept, file))).mode & 0o777, 0o600, 'private to this user');
    }
    assert.deepEqual(await readdir(root), [], 'nothing is written into the project');
    const listed: unknown = await fetch(`${base}/studio/api/media-connections`).then((response) => response.json());
    const id = String((listed as { connections: { id: string }[] }).connections[0]?.id);
    const listing = await post('/studio/api/media-hosting/list', JSON.stringify({ folder: '' }), { 'x-stacki-media-connection': id });
    assert.equal(listing['ok'], true, JSON.stringify(listing));
    assert.deepEqual(
      (listing['value'] as { files: { url: string }[]; folders: { path: string }[] }).files.map((entry) => entry.url),
      ['https://cdn.example.com/hero.png'],
    );
    const uploaded = await post('/studio/api/media-hosting/upload?folder=press&filename=new.png', new Uint8Array([1, 2, 3, 4]), {
      'x-stacki-media-connection': id,
    });
    assert.equal(uploaded['ok'], true, JSON.stringify(uploaded));
    const put = r2.calls.find((call) => call.method === 'PUT');
    assert.equal(new URL(put?.url ?? 'http://x').pathname, '/media/press/new.png');
    assert.equal(put?.bytes, 4);
    const refused = await post('/studio/api/media-hosting/replace?folder=&name=hero.png&filename=clip.mp4', new Uint8Array([1]), {
      'x-stacki-media-connection': id,
    });
    assert.equal(refused['ok'], false);
    assert.match(String(refused['message']), /not a video/);
    const traversal = await post('/studio/api/media-hosting/list', JSON.stringify({ folder: '../x' }), { 'x-stacki-media-connection': id });
    assert.equal(traversal['ok'], false);
    const unknown = await post('/studio/api/media-hosting/list', JSON.stringify({ folder: '' }), {
      'x-stacki-media-connection': '00000000-0000-4000-8000-00000000000f',
    });
    assert.match(String(unknown['message']), /was removed/);
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('a deployed container believes a media target only with the container token', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-media-deployed-'));
  process.env['STUDIO_CONTAINER_TOKEN'] = 'container-token';
  const r2 = fakeR2();
  const { server, base } = await serve(root, { fetch: r2.fetcher });
  try {
    const target = JSON.stringify({ connection: { ...DRAFT, id: '00000000-0000-4000-8000-000000000003' }, secret: SECRET });
    const forged = await fetch(`${base}/studio/api/media-hosting/list`, {
      method: 'POST',
      headers: { [MEDIA_TARGET_HEADER]: target },
      body: '{"folder":""}',
    }).then((response) => response.json() as Promise<Record<string, unknown>>);
    assert.equal(forged['ok'], false);
    assert.match(String(forged['message']), /did not come through Studio/);
    assert.equal(r2.calls.length, 0, 'nothing reached the host');
    const trusted = await fetch(`${base}/studio/api/media-hosting/list`, {
      method: 'POST',
      headers: { [MEDIA_TARGET_HEADER]: target, 'x-studio-token': 'container-token' },
      body: '{"folder":""}',
    }).then((response) => response.json() as Promise<Record<string, unknown>>);
    assert.equal(trusted['ok'], true, JSON.stringify(trusted));
    const local = await fetch(`${base}/studio/api/media-connections`);
    assert.equal(local.status, 404, 'a deployed container keeps no connections of its own');
  } finally {
    delete process.env['STUDIO_CONTAINER_TOKEN'];
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
