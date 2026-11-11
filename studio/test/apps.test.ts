// Goal: Studio hosts Stacki Apps from the same `.stacki/apps/` and with the same
// flow as Desktop: an uploaded zip is staged, installed only with its
// confirmation, listed, served to its frame under the sandboxing
// policy (and nothing outside its folder), and removed; installing needs the
// admin role; the client addresses frames on the server's file route. One app
// that fails a cross-field manifest check is a broken row; the others list.
// Method: the real route handler (src/features/apps/appsServer.ts) on a local
// HTTP server over a temporary project, driven with fetch; the example app in
// the repository's test fixtures is zipped in memory as the upload.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { appsRoutes } from '../src/features/apps/appsServer';
import { appFrameURL } from '../src/features/apps/appsClient';
import { writeStoredZip } from '../vendor/stacki/shared/properties/appBundle';
import { joinBrokenRows, parseAppFoldersBroken, parseInstalledAppList } from '../vendor/stacki/shared/properties/appFolders';
import { parseAppsResult } from '../vendor/stacki/shared/properties/apps';

const FIXTURE = path.resolve(import.meta.dirname, '../../test/fixtures/apps/selection-outline');

async function serve(root: string): Promise<{ server: Server; base: string }> {
  const route = appsRoutes(root);
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

async function fixtureZip(): Promise<Uint8Array> {
  const names = await readdir(FIXTURE);
  return writeStoredZip(await Promise.all(names.map(async (name) => ({ path: name, bytes: new Uint8Array(await readFile(path.join(FIXTURE, name))) }))));
}

test('an app installs from an upload, serves sandboxed, and is removed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-apps-'));
  delete process.env['STUDIO_CONTAINER_TOKEN']; // A local Studio: the person is admin.
  const { server, base } = await serve(root);
  try {
    const json = async (response: Response): Promise<{ ok: boolean; value?: unknown; message?: string }> => (await response.json()) as never;
    assert.deepEqual(await json(await fetch(`${base}/studio/api/apps`)), { ok: true, value: [] });
    const staged = await json(
      await fetch(`${base}/studio/api/apps/upload?name=selection-outline.zip`, { method: 'POST', body: Buffer.from(await fixtureZip()) }),
    );
    assert.equal(staged.ok, true, staged.message);
    const token = (staged.value as { token: string }).token;
    const installed = await json(await fetch(`${base}/studio/api/apps/commit`, { method: 'POST', body: JSON.stringify({ token }) }));
    assert.equal(installed.ok, true, installed.message);
    assert.ok(existsSync(path.join(root, '.stacki/apps/selection-outline/app.js')));

    const page = await fetch(`${base}${appFrameURL('selection-outline', 'index.html')}`);
    assert.equal(page.status, 200);
    const policy = page.headers.get('content-security-policy') ?? '';
    assert.match(policy, /^sandbox allow-scripts/);
    assert.doesNotMatch(policy, /allow-same-origin/);
    // The fixture declares no network hosts: it connects only to its own files, and loads no remote code.
    assert.match(policy, /connect-src http:\/\/127\.0\.0\.1:\d+\/studio\/api\/apps\/files\/selection-outline\/;/);
    assert.doesNotMatch(policy, /script-src[^;]*https:/);
    assert.equal((await fetch(`${base}${appFrameURL('selection-outline', 'stacki-sdk.js')}`)).status, 200);
    assert.equal((await fetch(`${base}/studio/api/apps/files/selection-outline/..%2Fapps.json`)).status, 404);
    await mkdir(path.join(root, 'private'), { recursive: true });
    await writeFile(path.join(root, 'private/key.txt'), 'secret');
    assert.equal((await fetch(`${base}/studio/api/apps/files/selection-outline/../../../private/key.txt`)).status, 404);

    const removed = await json(await fetch(`${base}/studio/api/apps/uninstall`, { method: 'POST', body: JSON.stringify({ id: 'selection-outline' }) }));
    assert.deepEqual(removed, { ok: true, value: [] });
  } finally {
    server.close();
  }
});

test('a bad upload installs nothing and says why', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-apps-bad-'));
  delete process.env['STUDIO_CONTAINER_TOKEN'];
  const { server, base } = await serve(root);
  try {
    const answer = (await (await fetch(`${base}/studio/api/apps/upload?name=x.zip`, { method: 'POST', body: 'not a zip' })).json()) as {
      ok: boolean;
      message: string;
    };
    assert.equal(answer.ok, false);
    assert.match(answer.message, /not a zip/);
    assert.equal(existsSync(path.join(root, '.stacki/apps')), false);
  } finally {
    server.close();
  }
});

// Apps added as a folder, as Desktop lists them (docs/apps.md, "Apps added as a folder"): a folder
// copied into .stacki/apps is installed at once as source `local` and served, the stamps the editor
// polls move when it changes, and a folder whose id does not match is a broken row, never served.
test('a folder dropped into .stacki/apps is installed at once; a mismatched one is a broken row', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-apps-folder-'));
  delete process.env['STUDIO_CONTAINER_TOKEN']; // A local Studio: the person is admin.
  const target = path.join(root, '.stacki/apps/selection-outline');
  await mkdir(target, { recursive: true });
  for (const name of await readdir(FIXTURE)) {
    await writeFile(path.join(target, name), await readFile(path.join(FIXTURE, name)));
  }
  await mkdir(path.join(root, '.stacki/apps/wrong-name'), { recursive: true });
  await writeFile(
    path.join(root, '.stacki/apps/wrong-name/stacki-app.json'),
    JSON.stringify({ manifestVersion: 1, id: 'other', name: 'Other', version: '1.0.0', entry: 'index.html' }),
  );
  await writeFile(path.join(root, '.stacki/apps/wrong-name/index.html'), '<p>x</p>');
  const { server, base } = await serve(root);
  try {
    const json = async (response: Response): Promise<{ ok: boolean; value?: unknown; message?: string }> => (await response.json()) as never;
    const listed = (await json(await fetch(`${base}/studio/api/apps`))).value as { manifest: { id: string }; lock: { source: { kind: string } } }[];
    assert.deepEqual(
      listed.map((app) => [app.manifest.id, app.lock.source.kind]),
      [['selection-outline', 'local']],
    );
    assert.equal((await fetch(`${base}${appFrameURL('selection-outline', 'index.html')}`)).status, 200);
    assert.equal(existsSync(path.join(root, '.stacki/apps/apps.json')), false, 'Listing writes no lockfile');

    const folders = await json(await fetch(`${base}/studio/api/apps/folders`));
    assert.equal(folders.ok, true);
    const broken = folders.value as { folder: string; message: string }[];
    assert.equal(broken.length, 1);
    assert.equal(broken[0]?.folder, 'wrong-name');
    assert.match(broken[0]?.message ?? '', /says "id": "other"/);
    assert.equal((await fetch(`${base}${appFrameURL('wrong-name', 'index.html')}`)).status, 404);

    const before = await json(await fetch(`${base}/studio/api/apps/stamps`));
    await writeFile(path.join(target, 'index.html'), '<p>edited by an agent, and longer</p>');
    const after = await json(await fetch(`${base}/studio/api/apps/stamps`));
    assert.notDeepEqual(before, after, 'An edited folder moves the stamps the editor polls');
  } finally {
    server.close();
  }
});

test('three apps, one with an invalid auth/settings link: two good rows and one broken row', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-apps-three-'));
  delete process.env['STUDIO_CONTAINER_TOKEN']; // A local Studio: the person is admin.
  const write = async (fields: Record<string, unknown>): Promise<void> => {
    const directory = path.join(root, '.stacki/apps', String(fields['id']));
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, 'stacki-app.json'),
      JSON.stringify({ manifestVersion: 1, name: `App ${String(fields['id'])}`, version: '1.0.0', entry: 'index.html', ...fields }),
    );
    await writeFile(path.join(directory, 'index.html'), '<p>app</p>');
  };
  await write({ id: 'analytics' });
  // A custom provider whose client id names a setting the manifest does not declare.
  await write({
    id: 'crm',
    auth: [
      { id: 'crm', label: 'CRM', authorizeURL: 'https://crm.example/auth', tokenURL: 'https://crm.example/token', pkce: true, clientIdSetting: 'client-id' },
    ],
  });
  // A Stacki connection: its parsed form must read back in the editor.
  await write({ id: 'hubspot', auth: [{ provider: 'hubspot', scopes: ['oauth', 'forms'] }] });
  const { server, base } = await serve(root);
  try {
    // What the Apps panel reads (appsClient.ts listInstalledAppList, appFoldersClient.ts): each app parsed on its own.
    const list = parseAppsResult(await (await fetch(`${base}/studio/api/apps`)).json(), parseInstalledAppList);
    const folders = parseAppsResult(await (await fetch(`${base}/studio/api/apps/folders`)).json(), parseAppFoldersBroken);
    assert.ok(list.ok);
    assert.ok(folders.ok);
    assert.deepEqual(
      list.value.apps.map((app) => app.manifest.id),
      ['analytics', 'hubspot'],
    );
    const broken = joinBrokenRows(folders.value, list.value.broken);
    assert.equal(broken.length, 1);
    assert.equal(broken[0]?.folder, 'crm');
    assert.match(broken[0]?.message ?? '', /Auth provider crm: clientIdSetting names a text or secret setting the manifest declares/);
  } finally {
    server.close();
  }
});
