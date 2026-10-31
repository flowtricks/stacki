// Goal: Studio keeps CMS connections without ever exposing a key — the Worker stores keys
// encrypted and hands the container a target for one request only, never one a client sent;
// a local Studio keeps its own private file; and the container believes a target only on a
// request carrying the container token.
// Method: the connection book's rules are checked directly; the Worker's forwarding runs
// against an in-memory R2; the container's route runs over real HTTP with Sanity played by a
// stubbed fetch, in local and deployed modes.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readdir, rm, stat, readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  CMS_TARGET_HEADER,
  parseSanityTarget,
  publicList,
  withConnection,
} from '../src/features/cms/cmsConnectionBook';
import {
  CmsUnavailable,
  cmsForwarded,
  sealCmsSecret,
  type Vault,
} from '../src/features/cms/cmsConnectionVault';
import { cmsRemoteRoutes } from '../src/features/cms/cmsRemoteServer';

const DRAFT = {
  kind: 'sanity' as const,
  label: 'Site',
  projectId: 'abc123',
  dataset: 'production',
  secret: 'sk-editor',
};

test('one connection per target, never more than the limit, and no key in the list', () => {
  const first = withConnection([], DRAFT, {
    id: '00000000-0000-4000-8000-000000000001',
    secret: 'x',
  });
  const second = withConnection(
    first,
    { ...DRAFT, label: 'Again' },
    {
      id: '00000000-0000-4000-8000-000000000002',
      secret: 'y',
    },
  );
  assert.equal(second.length, 1, 'the same project and dataset replaces the old one');
  assert.equal(second[0]?.connection.label, 'Again');
  assert.equal(
    JSON.stringify(publicList(second)).includes('sealed-key'),
    false,
    'keys never listed',
  );
  assert.throws(() => parseSanityTarget({ projectId: 'ABC!', dataset: 'x', token: 't' }));
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

test('the Worker removes a client target and adds its own, decrypted, for CMS calls only', async () => {
  const environment = fakeVault();
  const id = '00000000-0000-4000-8000-000000000003';
  const sealed = await sealCmsSecret(environment, DRAFT.secret);
  assert.equal(sealed.includes(DRAFT.secret), false, 'the stored key is ciphertext');
  environment.objects.set(
    'cms/connections.json',
    JSON.stringify(withConnection([], DRAFT, { id, secret: sealed })),
  );
  const forged = { [CMS_TARGET_HEADER]: '{"projectId":"evil","dataset":"x","token":"t"}' };
  const page = new Request('https://studio.test/studio/api/pages', { headers: forged });
  const plain = await cmsForwarded(page, new URL(page.url), environment);
  assert.equal(plain.headers.get(CMS_TARGET_HEADER), null, 'a client target never passes');
  const call = new Request('https://studio.test/studio/api/cms-remote/collections', {
    method: 'POST',
    headers: { ...forged, 'x-stacki-cms-connection': id },
    body: '{}',
  });
  const forwarded = await cmsForwarded(call, new URL(call.url), environment);
  const target = parseSanityTarget(JSON.parse(forwarded.headers.get(CMS_TARGET_HEADER) ?? '{}'));
  assert.deepEqual(target, { projectId: 'abc123', dataset: 'production', token: 'sk-editor' });
  const rotated = fakeVault('another-secret');
  rotated.objects.set(
    'cms/connections.json',
    environment.objects.get('cms/connections.json') ?? '',
  );
  const again = new Request(call.url, {
    method: 'POST',
    headers: { 'x-stacki-cms-connection': id },
    body: '{}',
  });
  await assert.rejects(() => cmsForwarded(again, new URL(again.url), rotated), CmsUnavailable);
});

async function serve(root: string): Promise<{ server: Server; base: string }> {
  const route = cmsRemoteRoutes(root);
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

test('a local Studio keeps its connections privately and uses them for CMS calls', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-cms-connections-'));
  const home = await mkdtemp(path.join(tmpdir(), 'studio-cms-home-'));
  const realHome = process.env['HOME'];
  process.env['HOME'] = home;
  delete process.env['STUDIO_CONTAINER_TOKEN'];
  const realFetch = globalThis.fetch;
  const { server, base } = await serve(root);
  const sanityCalls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(base)) {
      return realFetch(input, init);
    }
    sanityCalls.push(`${url} ${new Headers(init?.headers).get('Authorization')}`);
    return Response.json({ result: [] });
  };
  try {
    const post = (url: string, body: object, headers: Record<string, string> = {}) =>
      fetch(base + url, { method: 'POST', body: JSON.stringify(body), headers }).then(
        (response) => response.json() as Promise<Record<string, unknown>>,
      );
    const saved = await post('/studio/api/cms-connections/save', { draft: DRAFT });
    assert.equal(saved['ok'], true);
    assert.equal(JSON.stringify(saved).includes(DRAFT.secret), false, 'the key is not returned');
    const kept = path.join(home, '.stacki', 'studio-cms');
    const [file = ''] = await readdir(kept);
    assert.equal((await stat(path.join(kept, file))).mode & 0o777, 0o600, 'private to this user');
    assert.ok((await readFile(path.join(kept, file), 'utf8')).includes('abc123'));
    assert.deepEqual(await readdir(root), [], 'nothing is written into the project');
    const listed: unknown = await fetch(`${base}/studio/api/cms-connections`).then((r) => r.json());
    const id = String((listed as { connections: { id: string }[] }).connections[0]?.id);
    const collections = await post(
      '/studio/api/cms-remote/collections',
      {},
      {
        'x-stacki-cms-connection': id,
      },
    );
    assert.deepEqual(collections, { ok: true, value: [] });
    assert.match(sanityCalls[0] ?? '', /abc123\.api\.sanity\.io.* Bearer sk-editor$/);
    const unknown = await post(
      '/studio/api/cms-remote/collections',
      {},
      {
        'x-stacki-cms-connection': '00000000-0000-4000-8000-00000000000f',
      },
    );
    assert.equal(unknown['ok'], false);
  } finally {
    globalThis.fetch = realFetch;
    process.env['HOME'] = realHome;
    server.close();
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('a deployed container believes a target only with the container token', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-cms-deployed-'));
  process.env['STUDIO_CONTAINER_TOKEN'] = 'container-token';
  const { server, base } = await serve(root);
  try {
    const target = JSON.stringify({ projectId: 'abc123', dataset: 'production', token: 't' });
    const answer = await fetch(`${base}/studio/api/cms-remote/collections`, {
      method: 'POST',
      headers: { [CMS_TARGET_HEADER]: target },
      body: '{}',
    }).then((response) => response.json() as Promise<Record<string, unknown>>);
    assert.equal(answer['ok'], false);
    assert.match(String(answer['message']), /did not come through Studio/);
    const local = await fetch(`${base}/studio/api/cms-connections`);
    assert.equal(local.status, 404, 'a deployed container keeps no connections of its own');
  } finally {
    delete process.env['STUDIO_CONTAINER_TOKEN'];
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
