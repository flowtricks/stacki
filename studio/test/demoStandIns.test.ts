// Goal: the stand-ins answer Studio the way its server does, from the snapshot alone,
// and refuse what a static page cannot do with a reason instead of an odd failure.
// Method: each route through the fetch stand-in, the room through its message protocol
// with a real Yjs client document, and the pure helpers against known answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import type { BakeSnapshot } from '../src/features/bake/bakeSnapshot';
import { BAKE_PROTOCOL } from '../src/features/bake/bakeProtocol';
import { record } from '../src/shared/validation';
import { parseProject } from '../src/features/project/projectClient';
import { eventSourceStandIn } from '../demo/eventSourceStandIn';
import { fetchStandIn } from '../demo/fetchStandIn';
import { sha256Hex } from '../demo/nodeCrypto';
import { DemoFiles } from '../demo/projectFiles';
import { DemoRooms, seedUpdate, type RoomHost } from '../demo/room';
import { DEMO_PUBLISH_SOURCE, DemoPublish } from '../demo/publish';
import { demoRoutes, FEATURE_REASON } from '../demo/routes';
import { scopeStyles } from '../demo/scopeStyles';
import { renderSection, styleBlock } from '../demo/styleSections';

const PAGE = '<main>\n  <h1>Heading</h1>\n  <p>Body</p>\n</main>\n';
const SNAPSHOT: BakeSnapshot = {
  protocol: BAKE_PROTOCOL,
  id: 'b'.repeat(32),
  studioVersion: '1.0.0',
  base: '/demo/site/',
  project: { name: 'Site', pages: ['src/pages/index.astro'], collections: [], assets: [], components: [], classes: [] },
  assets: { files: [] },
  variables: { versions: {} },
  sources: {
    'src/pages/index.astro': PAGE,
    'src/styles/a.css': '.a {}\n',
    'src/components/Card.astro': '<div>Card</div>\n',
    '.stacki/guide.json': '{"version":1}',
  },
  pages: [
    { file: 'src/pages/index.astro', route: '/', document: 'index.html' },
    { file: 'src/pages/features.astro', route: '/features', document: 'features/index.html' },
  ],
  sections: [],
  components: { templates: [], instances: {} },
  content: undefined,
};

interface Recorded {
  readonly host: RoomHost;
  readonly refused: string[];
  readonly saved: string[];
  readonly selected: string[];
}

function recordingHost(refusal: string | undefined = undefined): Recorded {
  const refused: string[] = [];
  const saved: string[] = [];
  const selected: string[] = [];
  return {
    refused,
    saved,
    selected,
    host: {
      snapshotId: SNAPSHOT.id,
      baked: (file) => SNAPSHOT.sources[file],
      refusal: () => refusal,
      save: (file) => saved.push(file),
      changed: () => undefined,
      refused: (reason) => refused.push(reason),
      selected: (_file, _source, selection) => selected.push(selection),
    },
  };
}

function routeFetch(rooms = new DemoRooms(recordingHost().host, new Map())) {
  const unknown: string[] = [];
  const files = new DemoFiles({ texts: new Map(), blobs: new Map() }, () => undefined);
  const publish = new DemoPublish({ siteURL: `${ORIGIN}/demo/site/`, saved: undefined, persist: () => undefined, finished: () => undefined });
  const routes = demoRoutes({ snapshot: SNAPSHOT, rooms, files, publish, workspace: 'demo-x', unknownRoute: (route) => unknown.push(route) });
  const passed: string[] = [];
  const native: typeof fetch = async (input) => {
    passed.push(String(input));
    return new Response('native');
  };
  return { call: fetchStandIn(routes, native), unknown, passed, rooms };
}

const ORIGIN = 'http://demo.test';

test.before(() => {
  Object.defineProperty(globalThis, 'location', { configurable: true, value: new URL(`${ORIGIN}/demo/`) });
});

async function read(call: typeof fetch, path: string): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const response = await call(`${ORIGIN}${path}`);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/, 'The client refuses anything but JSON');
  const body: unknown = await response.json();
  assert.ok(typeof body === 'object' && body !== null);
  return { status: response.status, body: { ...body } };
}

test('session edits a draft, which shows the simulated Publish button', async () => {
  const { call } = routeFetch();
  assert.deepEqual((await read(call, '/studio/api/session')).body, { kind: 'local', editing: 'draft' });
});

test('project passes the client’s own parser and carries the bake’s workspace', async () => {
  const { call } = routeFetch();
  const project = parseProject((await read(call, '/studio/api/project')).body);
  assert.equal(project.workspaceId, 'demo-x');
  assert.deepEqual(project.pages, ['src/pages/index.astro']);
});

test('preview-url points at the baked document in design mode', async () => {
  const { call } = routeFetch();
  assert.deepEqual((await read(call, '/studio/api/preview-url?page=%2Ffeatures')).body, { url: '/demo/site/features/#avb-design', origin: ORIGIN });
  assert.equal((await read(call, '/studio/api/preview-url?page=%2Fnone')).status, 400);
});

test('file reads follow edits and refuse what the snapshot lacks', async () => {
  const { call } = routeFetch();
  assert.equal((await read(call, '/studio/api/file?file=src%2Fpages%2Findex.astro')).body['source'], PAGE);
  assert.equal((await read(call, '/studio/api/file?file=src%2Fpages%2Fnope.astro')).status, 404);
  assert.equal((await read(call, '/studio/api/file?file=..%2Fsecret.css')).status, 400);
});

test('assets, variables, styles and metadata come from the snapshot and the edits', async () => {
  const { call } = routeFetch();
  assert.deepEqual((await read(call, '/studio/api/assets')).body, { files: [], entries: [] });
  assert.deepEqual(Object.keys(record((await read(call, '/studio/api/variables')).body['versions'])), [
    'src/pages/index.astro',
    'src/styles/a.css',
    'src/components/Card.astro',
  ]);
  assert.deepEqual((await read(call, '/studio/api/styles')).body['files'], [{ rel: 'src/styles/a.css', path: 'src/styles/a.css', name: 'a.css', size: 6 }]);
  assert.deepEqual((await read(call, '/studio/api/metadata?kind=guide')).body, { source: '{"version":1}' });
  assert.deepEqual((await read(call, '/studio/api/metadata?kind=publish')).body, { source: DEMO_PUBLISH_SOURCE });
  assert.equal((await read(call, '/studio/api/metadata?kind=nope')).status, 400);
});

test('the style panel saves through the room and rejects a stale base', async () => {
  const { call, rooms } = routeFetch();
  const save = (source: string, base: string) =>
    call(`${ORIGIN}/studio/api/source`, { method: 'POST', body: JSON.stringify({ file: 'src/styles/a.css', source, base }) });
  assert.equal((await save('.b {}\n', '.a {}\n')).status, 200);
  assert.equal(rooms.read('src/styles/a.css'), '.b {}\n');
  assert.equal((await save('.c {}\n', '.a {}\n')).status, 400);
  assert.deepEqual([...rooms.edited().keys()], ['src/styles/a.css']);
});

test('sync reports nothing to do, and server features refuse with a reason', async () => {
  const { call, unknown } = routeFetch();
  const sync = await call(`${ORIGIN}/studio/api/sync`, { method: 'POST' });
  assert.deepEqual(await sync.json(), { kind: 'idle' });
  for (const route of ['/studio/api/publish', '/studio/api/git/status', '/studio/api/cms', '/studio/api/ai/models', '/studio/api/history/log']) {
    const answer = await read(call, route);
    assert.equal(answer.status, 403);
    assert.equal(answer.body['error'], FEATURE_REASON);
  }
  assert.equal(unknown.length, 5);
});

test('fetch leaves everything outside Studio to the network', async () => {
  const { call, passed } = routeFetch();
  await call(`${ORIGIN}/demo/site/index.html`);
  await call('https://api.github.com/studio/api/project');
  assert.equal(passed.length, 2);
});

test('the event stream opens once and stays silent', async () => {
  class NativeSource {
    constructor(readonly url: string) {}
  }
  const Stand = eventSourceStandIn(NativeSource as unknown as typeof EventSource);
  const events = new Stand('/studio/api/astro-events');
  const opened = new Promise<void>((resolve) => {
    events.onopen = () => resolve();
  });
  await opened;
  events.close();
  assert.equal(events.readyState, 2);
  assert.ok(new Stand('/other') instanceof NativeSource, 'Other streams are real');
});

function encodeUpdate(update: Uint8Array): string {
  return Buffer.from(update).toString('base64');
}

function connect(rooms: DemoRooms, file: string) {
  const messages: Record<string, unknown>[] = [];
  const room = rooms.get(file);
  const link = room.attach({
    deliver: (text) => {
      const value: unknown = JSON.parse(text);
      assert.ok(typeof value === 'object' && value !== null);
      messages.push({ ...value });
    },
  });
  return { room, link, messages, send: (message: unknown) => link.receive(JSON.stringify(message)) };
}

test('a room syncs with the bake as its epoch, identically on every visit', () => {
  const first = seedUpdate(PAGE, SNAPSHOT.id);
  assert.deepEqual(first, seedUpdate(PAGE, SNAPSHOT.id), 'CRDT ids must not change between visits');
  const { messages } = connect(new DemoRooms(recordingHost().host, new Map()), 'src/pages/index.astro');
  assert.equal(messages[0]?.['type'], 'sync');
  assert.equal(messages[0]?.['epoch'], SNAPSHOT.id);
  assert.equal(messages[1]?.['type'], 'presence');
});

test('a replayed client document merges with the seed instead of doubling it', () => {
  const recorded = recordingHost();
  const { room, send } = connect(new DemoRooms(recorded.host, new Map()), 'src/pages/index.astro');
  const client = new Y.Doc();
  Y.applyUpdate(client, seedUpdate(PAGE, SNAPSHOT.id));
  client.getText('source').insert(PAGE.indexOf('Heading'), 'Big ');
  send({ type: 'update', epoch: SNAPSHOT.id, save: 1, update: encodeUpdate(Y.encodeStateAsUpdate(client)) });
  assert.equal(room.text.toString(), PAGE.replace('Heading', 'Big Heading'));
});

test('an update from another bake is refused as an error message', () => {
  const { messages, send } = connect(new DemoRooms(recordingHost().host, new Map()), 'src/pages/index.astro');
  send({ type: 'update', epoch: 'old', save: 1, update: '' });
  assert.equal(messages.at(-1)?.['type'], 'error');
});

test('a saved document comes back on the next visit', () => {
  const edited = new Y.Doc();
  Y.applyUpdate(edited, seedUpdate(PAGE, SNAPSHOT.id));
  edited.getText('source').insert(0, 'X');
  const rooms = new DemoRooms(recordingHost().host, new Map([['src/pages/index.astro', Y.encodeStateAsUpdate(edited)]]));
  assert.equal(rooms.read('src/pages/index.astro'), `X${PAGE}`);
  assert.deepEqual([...rooms.edited().keys()], ['src/pages/index.astro']);
});

test('selection is echoed, shared with the host, and reported in presence', () => {
  const recorded = recordingHost();
  const { messages, send } = connect(new DemoRooms(recorded.host, new Map()), 'src/pages/index.astro');
  send({ type: 'presence', name: 'You', selection: 'n0.0', page: 'src/pages/index.astro', occurrence: 0, selectionRequest: 3 });
  assert.deepEqual(recorded.selected, ['n0.0']);
  assert.ok(messages.some((message) => message['type'] === 'selection' && message['selection'] === 'n0.0' && message['selectionRequest'] === 3));
});

test('actions the page cannot show are refused, acknowledged and change nothing', () => {
  // An insertion is planned like any edit; the host refuses it when no template renders it.
  const recorded = recordingHost('A new component needs Astro to render it.');
  const { room, messages, send } = connect(new DemoRooms(recorded.host, new Map()), 'src/pages/index.astro');
  send({ type: 'action', epoch: SNAPSHOT.id, save: 1, action: { kind: 'insert', target: 'n0', name: 'Card', importPath: '../x.astro', paired: false } });
  assert.deepEqual(recorded.refused, ['A new component needs Astro to render it.']);
  assert.equal(room.text.toString(), PAGE);
  assert.ok(
    messages.some((message) => message['type'] === 'saved' && message['save'] === 1),
    'The client stops waiting',
  );
});

test('the host can refuse an action on what it would produce', () => {
  const recorded = recordingHost('Not on this page.');
  const { room, send } = connect(new DemoRooms(recorded.host, new Map()), 'src/pages/index.astro');
  send({ type: 'action', epoch: SNAPSHOT.id, save: 1, action: { kind: 'delete', node: 'n0.1' } });
  assert.deepEqual(recorded.refused, ['Not on this page.']);
  assert.equal(room.text.toString(), PAGE);
});

test('a plain delete edits the source and tells the client it was structural', () => {
  const recorded = recordingHost();
  const { room, messages, send } = connect(new DemoRooms(recorded.host, new Map()), 'src/pages/index.astro');
  send({ type: 'action', epoch: SNAPSHOT.id, save: 1, action: { kind: 'delete', node: 'n0.1' } });
  assert.doesNotMatch(room.text.toString(), /Body/);
  const update = messages.find((message) => message['type'] === 'update');
  assert.equal(update?.['ownAction'], true);
  assert.equal(update?.['structural'], true);
  assert.ok(messages.some((message) => message['type'] === 'source-written'));
  assert.deepEqual(recorded.saved, ['src/pages/index.astro']);
});

test('the browser SHA-256 matches Node for the planner', () => {
  for (const text of ['', 'abc', 'é'.repeat(100), 'x'.repeat(1000)]) {
    assert.equal(sha256Hex(text), createHash('sha256').update(text).digest('hex'));
  }
});

test('scoping matches the shapes Astro writes', () => {
  const scoped = (css: string) => scopeStyles(css, 'abc').replace(/\s+/g, ' ').trim();
  assert.equal(scoped('.a { color: red; }'), '.a[data-astro-cid-abc] { color: red; }');
  assert.equal(scoped('.a.b:hover { }'), '.a[data-astro-cid-abc].b:hover { }');
  assert.equal(scoped('a > .b { }'), 'a[data-astro-cid-abc] > .b[data-astro-cid-abc] { }');
  assert.equal(scoped('.a::before { }'), '.a[data-astro-cid-abc]::before { }');
  assert.equal(scoped('html { } :root { }'), 'html { } :root { }');
  assert.equal(scoped(':global(.x) { }'), '.x { }');
  assert.equal(scoped('@layer c { .a { } }'), '@layer c { .a[data-astro-cid-abc] { } }');
  assert.equal(scoped('@keyframes k { from { top: 0; } }'), '@keyframes k { from { top: 0; } }');
  assert.equal(scoped('.a { & .b { } }'), '.a[data-astro-cid-abc] { & .b[data-astro-cid-abc] { } }');
});

test('style blocks count from the last, as Astro compiles them, and skip inline ones', () => {
  const source = '<style>.a{}</style><style is:inline>.b{}</style><style>.c{}</style>';
  assert.equal(styleBlock(source, 0), '.c{}');
  assert.equal(styleBlock(source, 1), '.a{}');
  assert.equal(styleBlock(source, 2), undefined);
});

test('a section is rebuilt whole: imports inlined, layers kept, URLs the build’s', () => {
  const sources = { 'src/styles/global.css': '@import "./base.css" layer(base);\n.top {}\n', 'src/styles/base.css': '.b { mask: url("../x.svg"); }\n' };
  const css = renderSection({ id: 'src/styles/global.css', file: 'src/styles/global.css', scope: undefined, urls: { '../x.svg': '/built.svg' } }, sources);
  assert.match(css ?? '', /@layer base \{\n\.b \{ mask: url\("\/built\.svg"\); \}/);
  assert.match(css ?? '', /\.top/);
  assert.equal(renderSection({ id: 'src/none.css', file: 'src/none.css', scope: undefined, urls: {} }, sources), undefined);
});
