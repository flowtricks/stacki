// Goal: Design mode's render route renders a component with the props and slot HTML it is given, through the dev
// server's own module loader and Astro's container, and refuses everything else: another method, a malformed body,
// a path outside the project or a page, a file that is not there. It writes nothing: the test's project folder is
// byte-identical after every request.
//
// Method: the compiled plugin (dist) with a stand-in Vite server whose SSR runner hands back a fake container and
// a fake component, and real Node request and response objects carried over a local socket pair.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { designModeRenderPlugin } from '#dist/electron/previewServer/designMode/designRender.js';

type Handler = (request: http.IncomingMessage, response: http.ServerResponse, next: () => void) => void;

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-design-render-'));
  fs.mkdirSync(path.join(root, 'src', 'components'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'components', 'Card.astro'), '<div class="card"><slot /></div>\n');
  return root;
}

function snapshotOf(root: string): string {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop() ?? root;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else {
        files.push(full + '\n' + fs.readFileSync(full, 'utf8'));
      }
    }
  }
  return files.sort().join('\n---\n');
}

async function serve(root: string): Promise<{ readonly url: string; readonly calls: string[]; readonly close: () => Promise<void> }> {
  const calls: string[] = [];
  let handler: Handler | undefined;
  const fakeComponent = { name: 'Card' };
  const server = {
    middlewares: {
      use: (route: string, use: Handler) => {
        assert.equal(route, '/__avb/design-render');
        handler = use;
      },
    },
    environments: {
      ssr: {
        runner: {
          import: (id: string): Promise<unknown> => {
            calls.push(id);
            if (id === 'astro/container') {
              // A class, as Astro exports it: a function with a static create.
              class Container {
                static create(): Promise<Container> {
                  return Promise.resolve(new Container());
                }
                renderToString(
                  component: unknown,
                  options: { readonly props: Record<string, unknown>; readonly slots: Record<string, string> },
                ): Promise<string> {
                  assert.equal(component, fakeComponent);
                  return Promise.resolve(`<div class="card ${String(options.props['tone'])}">${options.slots['default'] ?? ''}</div>`);
                }
              }
              return Promise.resolve({ experimental_AstroContainer: Container });
            }
            return Promise.resolve({ default: fakeComponent });
          },
        },
      },
    },
  };
  const plugin = designModeRenderPlugin([root]);
  assert.equal(plugin.name, 'stacki-design-mode-render');
  plugin.configureServer?.(server);
  const listener = http.createServer((request, response) => handler?.(request, response, () => response.writeHead(404).end()));
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  assert.ok(typeof address === 'object' && address !== null, 'a TCP listener has an address');
  const port = address.port;
  return { url: `http://127.0.0.1:${String(port)}/__avb/design-render`, calls, close: () => new Promise((resolve) => listener.close(() => resolve())) };
}

test('renders a component with props and slot HTML, and writes nothing', async () => {
  const root = project();
  const before = snapshotOf(root);
  const route = await serve(root);
  try {
    const body = { component: 'src/components/Card.astro', props: { tone: 'dark' }, slots: { default: '<b>Hi</b>' } };
    const answer = await fetch(route.url, { method: 'POST', body: JSON.stringify(body) });
    assert.equal(answer.status, 200);
    assert.equal(await answer.text(), '<div class="card dark"><b>Hi</b></div>');
    assert.deepEqual(route.calls, ['/src/components/Card.astro', 'astro/container']);
    const second = await fetch(route.url, { method: 'POST', body: JSON.stringify({ ...body, props: { tone: 'light' } }) });
    assert.equal(await second.text(), '<div class="card light"><b>Hi</b></div>');
    assert.deepEqual(route.calls, ['/src/components/Card.astro', 'astro/container', '/src/components/Card.astro'], 'one container per server');
  } finally {
    await route.close();
  }
  assert.equal(snapshotOf(root), before, 'the project folder is byte-identical');
  fs.rmSync(root, { recursive: true, force: true });
});

test('refuses other methods, malformed bodies, pages and files that are not there', async () => {
  const root = project();
  const before = snapshotOf(root);
  const route = await serve(root);
  try {
    assert.equal((await fetch(route.url)).status, 405);
    assert.equal((await fetch(route.url, { method: 'POST', body: 'not json' })).status, 400);
    assert.equal((await fetch(route.url, { method: 'POST', body: JSON.stringify({ component: 'src/pages/index.astro', props: {}, slots: {} }) })).status, 400);
    assert.equal(
      (await fetch(route.url, { method: 'POST', body: JSON.stringify({ component: 'src/components/Missing.astro', props: {}, slots: {} }) })).status,
      404,
    );
    assert.deepEqual(route.calls, [], 'nothing refused ever reached the module loader');
  } finally {
    await route.close();
  }
  assert.equal(snapshotOf(root), before);
  fs.rmSync(root, { recursive: true, force: true });
});
