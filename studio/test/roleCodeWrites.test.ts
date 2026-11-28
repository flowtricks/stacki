// Goal: a role without a code permission can never put new code into the site, by any write route or the collaboration
// socket, because the preview server runs the site's code. Everything the editor offers such a role keeps working, and
// roles that edit code (admin, `code:edit`) are not limited.
// Method: serve the real integration from a real Vite server over a throwaway project, with STUDIO_CONTAINER_TOKEN set
// and the Worker's identity headers, as in a deployed Studio. Send the requests and socket messages a browser that
// skips its own checks could send, and read what reached the disk.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createServer as createNetServer } from 'node:net';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Plugin } from 'vite';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import studio, { studioRuntime } from '../src/server/integration';
import { record, string } from '../src/shared/validation';

const TOKEN = 'test-container-token';
const PAGE = 'src/pages/index.astro';
const ENDPOINT = 'src/pages/feed.json.ts';
const COMPONENT = 'src/components/Card.astro';
const STYLES = 'src/styles/site.css';
const PAGE_SOURCE = `---
import Layout from '../layouts/Layout.astro';
import Card from '../components/Card.astro';
const title = 'Welcome';
const items = [{ name: 'One' }, { name: 'Two' }];
---

<Layout>
  <h1>{title}</h1>
  <Card label="Hello" />
  {items.map((item) => (<p>{formatName(item.name)}</p>))}
</Layout>
`;
const ENDPOINT_SOURCE = "export const GET = () => new Response('[]');\n";
const ROLES = {
  version: 1,
  defaultRole: 'client',
  roles: [
    { id: 'admin', name: 'Admin', members: ['owner'] },
    { id: 'client', name: 'Client', members: ['acme'] },
    { id: 'stylist', name: 'Stylist', members: ['sty'], access: ['panel:style', 'panel:pages'] },
    { id: 'coder', name: 'Coder', members: ['dev'], access: ['panel:pages', 'panel:cms', 'page:create', 'page:layout', 'code:edit'] },
  ],
};

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return address.port;
}

async function project() {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-code-writes-'));
  const files: Readonly<Record<string, string>> = {
    'package.json': '{"type":"module"}',
    '.stacki/roles.json': JSON.stringify(ROLES),
    [PAGE]: PAGE_SOURCE,
    [ENDPOINT]: ENDPOINT_SOURCE,
    [COMPONENT]: '---\nconst { label } = Astro.props;\n---\n<article>{label}</article>\n',
    'src/layouts/Layout.astro': '<main><slot /></main>\n',
    [STYLES]: '.card { color: red; }\n',
  };
  for (const [file, source] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), source);
  }
  await mkdir(path.join(root, 'node_modules'));
  await mkdir(path.join(root, 'public'));
  return root;
}

async function serve(context: TestContext) {
  const root = await project();
  const port = await freePort();
  const integration = studio({ root, assets: root, port });
  const hook = (name: string, value: object) => {
    const run: unknown = Reflect.get(integration.hooks, name);
    assert.ok(typeof run === 'function', name);
    return Reflect.apply(run, integration.hooks, [value]) as unknown;
  };
  const plugins: unknown[] = [];
  await hook('astro:config:setup', {
    command: 'dev',
    config: { trailingSlash: 'ignore' },
    addMiddleware: () => {},
    injectRoute: () => {},
    updateConfig: (update: { readonly vite: { readonly plugins: readonly unknown[] } }) => plugins.push(...update.vite.plugins),
  });
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port, strictPort: true },
    plugins: plugins as Plugin[],
  });
  process.env['STUDIO_CONTAINER_TOKEN'] = TOKEN;
  const sockets: WebSocket[] = [];
  context.after(async () => {
    for (const socket of sockets) {
      socket.terminate();
    }
    delete process.env['STUDIO_CONTAINER_TOKEN'];
    await studioRuntime(root).rooms.persist();
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  await server.listen();
  return { root, port, sockets };
}
type Served = Awaited<ReturnType<typeof serve>>;

const identity = (login: string) => ({ 'x-studio-token': TOKEN, 'x-studio-user': login, 'x-studio-user-id': '7' });

async function post(served: Served, login: string, route: string, body: unknown) {
  const response = await fetch(`http://127.0.0.1:${served.port}/studio/api/${route}`, {
    method: 'POST',
    headers: { ...identity(login), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, ok: response.ok, body: record(await response.json()) };
}

async function exists(served: Served, file: string) {
  return access(path.join(served.root, file)).then(
    () => true,
    () => false,
  );
}
const read = (served: Served, file: string) => readFile(path.join(served.root, file), 'utf8');

function message(socket: WebSocket, types: readonly string[]) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Missing ${types.join('/')} reply`)), 10_000);
    const receive = (bytes: Buffer) => {
      const value = record(JSON.parse(bytes.toString()));
      if (types.includes(String(value['type']))) {
        clearTimeout(timer);
        socket.off('message', receive);
        resolve(value);
      }
    };
    socket.on('message', receive);
  });
}

/** Sends the raw CRDT update that turns `file` into `edit(source)`; answers `saved` or `error`. */
async function socketEdit(served: Served, login: string, file: string, edit: (source: string) => string) {
  const socket = new WebSocket(`ws://127.0.0.1:${served.port}/studio/sync?file=${encodeURIComponent(file)}`, { headers: identity(login) });
  served.sockets.push(socket);
  const sync = await message(socket, ['sync']);
  const local = new Y.Doc();
  Y.applyUpdate(local, Buffer.from(string(sync['update'], 4_000_000), 'base64'));
  const text = local.getText('source');
  const next = edit(text.toString());
  local.transact(() => {
    text.delete(0, text.length);
    text.insert(0, next);
  });
  const reply = message(socket, ['saved', 'error']);
  socket.send(JSON.stringify({ type: 'update', epoch: sync['epoch'], update: Buffer.from(Y.encodeStateAsUpdate(local)).toString('base64') }));
  local.destroy();
  const answer = await reply;
  socket.close();
  return String(answer['type']);
}

const replace = (from: string, to: string) => (source: string) => {
  assert.ok(source.includes(from), `The fixture holds ${from}`);
  return source.replace(from, to);
};

test('creating a file never gives a role without code permission new code', async (context) => {
  const served = await serve(context);
  const hostile: readonly (readonly [string, string])[] = [
    ['src/pages/api/run.ts', 'export const GET = () => new Response(JSON.stringify(process.env));\n'],
    ['src/pages/run.js', 'export const GET = () => new Response("x");\n'],
    ['src/data/run.ts', 'export const value = 1;\n'],
    ['src/content/run.mjs', 'export default 1;\n'],
    ['src/pages/run.astro', '---\nconst all = process.env;\n---\n<pre>{JSON.stringify(all)}</pre>\n'],
    ['src/pages/inline.astro', '<main>{process.env.STUDIO_CONTAINER_TOKEN}</main>\n'],
    ['src/pages/script.astro', '<main><script src="https://elsewhere.test/a.js"></script></main>\n'],
    ['src/pages/upper.ASTRO', '<main />\n'],
    ['src/content/blog/post.mdx', "import fs from 'node:fs';\n\n# Post\n"],
    ['src/content/blog/other.mdx', '# Post\n\n{process.env.STUDIO_CONTAINER_TOKEN}\n'],
    ['src/pages/page.mdx', 'export const leak = process.env;\n'],
    ['.stacki/canvas/00000000-0000-0000-0000-000000000000.astro', '<main />\n'],
  ];
  for (const [file, source] of hostile) {
    const answer = await post(served, 'acme', 'create', { file, source });
    assert.equal(answer.ok, false, `${file} must be refused`);
    assert.equal(await exists(served, file), false, `${file} must not exist`);
  }
});

test('a role without code permission still creates what the editor creates', async (context) => {
  const served = await serve(context);
  const allowed: readonly (readonly [string, string])[] = [
    ['src/pages/new.astro', '---\n---\n\n<main>\n\t<h1>New page</h1>\n</main>\n'],
    // Duplicate: the copied page's code is already in the project.
    ['src/pages/copy.astro', PAGE_SOURCE],
    ['src/content/item.json', '{\n\t"title": "New item"\n}\n'],
    ['src/content/item.md', '---\ntitle: New item\n---\n\nWrite your content here.\n'],
    ['src/content/item.mdx', '---\ntitle: New item\n---\n\nWrite your content here.\n'],
  ];
  for (const [file, source] of allowed) {
    const answer = await post(served, 'acme', 'create', { file, source });
    assert.equal(answer.status, 201, `${file}: ${String(answer.body['error'])}`);
  }
  const coded = await post(served, 'dev', 'create', { file: 'src/data/run.ts', source: 'export const value = process.env.X;\n' });
  assert.equal(coded.status, 201, 'A role with Edit code creates code');
});

test('the socket refuses new code from a client, in frontmatter, markup and other files', async (context) => {
  const served = await serve(context);
  const hostile: readonly (readonly [string, (source: string) => string])[] = [
    [PAGE, replace("const title = 'Welcome';", "const title = 'Welcome';\nconst all = process.env;")],
    [PAGE, replace("const title = 'Welcome';", 'const title = process.env.STUDIO_CONTAINER_TOKEN;')],
    [PAGE, replace("const title = 'Welcome';", "const title = 'Welcome';\nawait fetch('https://elsewhere.test');")],
    [PAGE, replace("import Card from '../components/Card.astro';", "import Card from '../components/Card.astro';\nimport fs from 'node:fs';")],
    [PAGE, replace('<h1>{title}</h1>', '<h1>{process.env.HOME}</h1>')],
    [PAGE, replace('<h1>{title}</h1>', '<h1>{title.constructor.constructor("return process")()}</h1>')],
    [PAGE, replace('<Card label="Hello" />', '<Card label={import.meta.env.SECRET} />')],
    [PAGE, replace('<Card label="Hello" />', '<Card {...globalThis.process.env} />')],
    [PAGE, replace('<Card label="Hello" />', '<img src="x" onerror="alert(1)" />')],
    [PAGE, replace('<Card label="Hello" />', '<a href="javascript:alert(1)">x</a>')],
    [PAGE, replace('<Card label="Hello" />', '<script>alert(1)</script>')],
    [ENDPOINT, () => 'export const GET = () => new Response(JSON.stringify(process.env));\n'],
  ];
  for (const [index, [file, edit]] of hostile.entries()) {
    assert.equal(await socketEdit(served, 'acme', file, edit), 'error', `hostile edit ${index} of ${file}`);
  }
  await studioRuntime(served.root).rooms.persist();
  assert.equal(await read(served, PAGE), PAGE_SOURCE);
  assert.equal(await read(served, ENDPOINT), ENDPOINT_SOURCE);
});

test('the socket keeps every edit the editor offers a client, and its undo', async (context) => {
  const served = await serve(context);
  const edits: readonly ((source: string) => string)[] = [
    replace("const title = 'Welcome';", "const title = 'Hello there';"),
    replace("{ name: 'Two' }", "{ name: 'Second' }"),
    replace('<Card label="Hello" />', '<Card label="Changed" />'),
    replace('<Card label="Changed" />', '<Card label="Changed" count={3} open={true} tags={["a", "b"]} />'),
    replace('<h1>{title}</h1>', '<h1 class="big">{title}</h1>\n  <a href="https://example.com">Link</a>'),
    replace("import Card from '../components/Card.astro';", "import Card from '../components/Card.astro';\nimport photo from '../assets/photo.png';"),
    replace('<a href="https://example.com">Link</a>', '<img src={photo.src} alt="A boat" />'),
    // Deleting code and undoing the delete brings the same code back.
    replace('  {items.map((item) => (<p>{formatName(item.name)}</p>))}\n', ''),
    replace('</Layout>', '  {items.map((item) => (<p>{formatName(item.name)}</p>))}\n</Layout>'),
    // Copying existing code is not new code.
    replace('</Layout>', '  <h2>{title}</h2>\n  {items.map((item) => (<p>{formatName(item.name)}</p>))}\n</Layout>'),
  ];
  for (const [index, edit] of edits.entries()) {
    assert.equal(await socketEdit(served, 'acme', PAGE, edit), 'saved', `client edit ${index}`);
  }
  const code = replace("const title = 'Hello there';", 'const title = process.env.HOME;');
  assert.equal(await socketEdit(served, 'dev', PAGE, code), 'saved', 'A role with Edit code writes code');
});

test('the style save writes styles only, for a role without code permission', async (context) => {
  const served = await serve(context);
  const roles = JSON.stringify(ROLES);
  const hostile: readonly (readonly [string, string, string])[] = [
    ['.stacki/roles.json', roles, roles.replace('"members":["owner"]', '"members":["owner","sty"]')],
    [ENDPOINT, ENDPOINT_SOURCE, 'export const GET = () => new Response(JSON.stringify(process.env));\n'],
    [COMPONENT, await read(served, COMPONENT), '---\nconst all = process.env;\n---\n<pre>{all}</pre>\n'],
    [PAGE, PAGE_SOURCE, PAGE_SOURCE.replace('<h1>{title}</h1>', '<h1>{process.env.HOME}</h1>')],
  ];
  for (const [file, base, source] of hostile) {
    const answer = await post(served, 'sty', 'source', { file, base, source });
    assert.equal(answer.ok, false, `${file} must be refused`);
  }
  await studioRuntime(served.root).rooms.persist();
  assert.equal(await read(served, '.stacki/roles.json'), roles);
  assert.equal(await read(served, ENDPOINT), ENDPOINT_SOURCE);
  const css = await post(served, 'sty', 'source', { file: STYLES, base: '.card { color: red; }\n', source: '.card { color: blue; }\n' });
  assert.equal(css.status, 200, String(css.body['error']));
  const base = await read(served, COMPONENT);
  const styled = await post(served, 'sty', 'source', { file: COMPONENT, base, source: `${base}<style is:global>\n.card { gap: 1rem; }\n</style>\n` });
  assert.equal(styled.status, 200, String(styled.body['error']));
});

test('an update that waits for a missing change cannot slip past the check', async (context) => {
  const served = await serve(context);
  const socket = new WebSocket(`ws://127.0.0.1:${served.port}/studio/sync?file=${encodeURIComponent(PAGE)}`, { headers: identity('acme') });
  served.sockets.push(socket);
  const sync = await message(socket, ['sync']);
  const local = new Y.Doc();
  Y.applyUpdate(local, Buffer.from(string(sync['update'], 4_000_000), 'base64'));
  local.getText('source').insert(0, 'a');
  const first = Y.encodeStateVector(local);
  local.getText('source').insert(1, 'b');
  // Only the second change: it changes nothing until the first arrives, perhaps under someone else's name.
  const reply = message(socket, ['saved', 'error']);
  const update = Buffer.from(Y.encodeStateAsUpdate(local, first)).toString('base64');
  socket.send(JSON.stringify({ type: 'update', epoch: sync['epoch'], update }));
  local.destroy();
  assert.equal(String((await reply)['type']), 'error');
  const room = await studioRuntime(served.root).rooms.get(PAGE);
  assert.equal(room.document.store.pendingStructs, null);
});
