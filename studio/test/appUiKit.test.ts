// Goal: Studio serves the Stacki UI kit from inside every app's origin, as
// Desktop does (docs/apps.md, "Look and feel"): `__stacki/ui.css`,
// `__stacki/ui.js` and `__stacki/tokens.css` answer on the app's own file route
// under the app's sandboxing policy, any other reserved path is a 404, every
// HTML page carries the tokens before its head closes, and an upload that ships
// its own `__stacki/` folder is refused with the reason.
// Method: the real route handler (src/features/apps/appsServer.ts) on a local
// HTTP server over a temporary project, driven with fetch; the repository's
// example app, which links the kit, is zipped in memory as the upload.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { appsRoutes } from '../src/features/apps/appsServer';
import { appFrameURL } from '../src/features/apps/appsClient';
import { writeStoredZip } from '../vendor/stacki/shared/properties/appBundle';

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

async function fixtureFiles(): Promise<{ path: string; bytes: Uint8Array }[]> {
  const names = await readdir(FIXTURE);
  return Promise.all(names.map(async (name) => ({ path: name, bytes: new Uint8Array(await readFile(path.join(FIXTURE, name))) })));
}

const json = async (response: Response): Promise<{ ok: boolean; value?: unknown; message?: string }> => (await response.json()) as never;

test('the kit is served on the app file route, and pages carry the tokens', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-app-kit-'));
  delete process.env['STUDIO_CONTAINER_TOKEN']; // A local Studio: the person is admin.
  const { server, base } = await serve(root);
  try {
    const staged = await json(
      await fetch(`${base}/studio/api/apps/upload?name=selection-outline.zip`, { method: 'POST', body: Buffer.from(writeStoredZip(await fixtureFiles())) }),
    );
    assert.equal(staged.ok, true, staged.message);
    const token = (staged.value as { token: string }).token;
    const installed = await json(await fetch(`${base}/studio/api/apps/commit`, { method: 'POST', body: JSON.stringify({ token }) }));
    assert.equal(installed.ok, true, installed.message);

    const css = await fetch(`${base}${appFrameURL('selection-outline', '__stacki/ui.css')}`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type') ?? '', /^text\/css/);
    assert.match(css.headers.get('content-security-policy') ?? '', /^sandbox allow-scripts/);
    const sheet = await css.text();
    assert.match(sheet, /--stacki-accent: #0099ff;/);
    assert.match(sheet, /^@scope \(\.stacki-ui\) \{/m, "the editor's component CSS, scoped to the kit");
    assert.match(sheet, /\.dd-trigger \{/);
    const script = await fetch(`${base}${appFrameURL('selection-outline', '__stacki/ui.js')}`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type') ?? '', /^text\/javascript/);
    assert.match(await script.text(), /stacki-dropdown/, "the editor's components as custom elements");
    assert.equal((await fetch(`${base}${appFrameURL('selection-outline', '__stacki/tokens.css')}`)).status, 200);
    assert.equal((await fetch(`${base}${appFrameURL('selection-outline', '__stacki/absent.css')}`)).status, 404);

    const page = await (await fetch(`${base}${appFrameURL('selection-outline', 'index.html')}`)).text();
    const tokensAt = page.indexOf('<style data-stacki-tokens>');
    assert.ok(tokensAt > page.indexOf('<meta charset="utf-8" />'), 'after the charset');
    assert.ok(tokensAt < page.indexOf('</head>'), 'before the head closes');
    assert.match(page, /<link rel="stylesheet" href="__stacki\/ui\.css" \/>/, 'the example app links the kit');
  } finally {
    server.close();
  }
});

test('an upload with its own __stacki/ folder is refused', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-app-kit-refused-'));
  delete process.env['STUDIO_CONTAINER_TOKEN'];
  const { server, base } = await serve(root);
  try {
    const files = [...(await fixtureFiles()), { path: '__stacki/ui.css', bytes: new TextEncoder().encode('body{}') }];
    const answer = await json(await fetch(`${base}/studio/api/apps/upload?name=x.zip`, { method: 'POST', body: Buffer.from(writeStoredZip(files)) }));
    assert.equal(answer.ok, false);
    assert.match(answer.message ?? '', /__stacki\/ is served by Stacki/);
  } finally {
    server.close();
  }
});
