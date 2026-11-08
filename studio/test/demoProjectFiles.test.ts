// Goal: the demo saves what Studio writes beyond page source in the browser, the way
// it saves page edits: project settings under `.stacki/` (the column guide), CSS
// variables, and uploads. Each change reads back, survives a reload, and is gone after
// Reset. Publish runs Studio's real flow against a short script and touches nothing
// outside the page.
// Method: drive the fetch stand-in as the client does, persist through a recording
// store, then build a fresh page state from what was recorded (a reload) and from
// nothing (a reset). The in-page stand-ins for `node:path` and AsyncLocalStorage are
// checked against Node's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage as NodeAsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import type { BakeSnapshot } from '../src/features/bake/bakeSnapshot';
import { BAKE_PROTOCOL } from '../src/features/bake/bakeProtocol';
import type { PublishState } from '../src/features/publishing/publish';
import { parsePublishState } from '../src/features/publishing/publishClient';
import { parseMetadataFile } from '../vendor/stacki/shared/properties/projectMetadata';
import { parsePublishAvailability } from '../vendor/stacki/shared/properties/publishState';
import { record } from '../src/shared/validation';
import { AsyncLocalStorage } from '../demo/asyncLocalStorage';
import { assetSiteURL, publicAssetResolver } from '../demo/assetURLs';
import { fetchStandIn } from '../demo/fetchStandIn';
import { sha256Hex } from '../demo/nodeCrypto';
import * as posix from '../demo/posixPath';
import { DemoFiles, UPLOAD_LIMITS } from '../demo/projectFiles';
import { CONNECTIONS_REASON } from '../demo/publishConnections';
import { DEMO_CLOUDFLARE_PROJECT, DEMO_PUBLISH_STATE_FILE, DEMO_REPOSITORY, DemoPublish, PUBLISH_NOTE } from '../demo/publish';
import { parsePublishSource } from '../vendor/stacki/shared/properties/publishConfig';
import { parsePublishDiscovery } from '../vendor/stacki/shared/properties/publishDiscovery';
import { parseRepositoryResult } from '../vendor/stacki/shared/ipc/publishRepository';
import { parseAccountState } from '../vendor/stacki/shared/ipc/publishAccount';
import { DemoRooms, type RoomHost } from '../demo/room';
import { ASSET_CHANGE_REASON, demoRoutes, SETTINGS_CONFLICT, UPLOAD_FOLDER_REASON } from '../demo/routes';
import { VARIABLE_CONFLICT } from '../demo/variables';

const ORIGIN = 'http://demo.test';
/** Longer than the room's save delay for style-only changes. */
const ROOM_SAVE_WAIT_MS = 400;
const GUIDE = '{"version":1,"settings":{"visible":false,"columns":{"kind":"automatic"},"color":"rgb(146, 146, 146)","opacity":0.2,"numbers":true}}\n';
const CSS = ':root {\n  --brand: #9c75f7;\n}\n';
const SNAPSHOT: BakeSnapshot = {
  protocol: BAKE_PROTOCOL,
  id: 'c'.repeat(32),
  studioVersion: '1.0.0',
  base: '/demo/site/',
  project: { name: 'Site', pages: ['src/pages/index.astro'], collections: [], assets: [], components: [], classes: [] },
  assets: { entries: [{ rel: 'public/og.png', abs: 'public/og.png', name: 'og.png', parent: 'public', root: 'public', isDir: false, size: 3 }] },
  variables: { versions: {} },
  sources: { 'src/pages/index.astro': '<main><h1>Hi</h1></main>\n', 'src/styles/base.css': CSS, '.stacki/guide.json': GUIDE },
  pages: [{ file: 'src/pages/index.astro', route: '/', document: 'index.html' }],
  sections: [],
  components: { templates: [], instances: {} },
  content: undefined,
};

/** What IndexedDB would hold: room updates and saved files, by key. */
interface Storage {
  readonly rooms: Map<string, Uint8Array>;
  readonly texts: Map<string, string>;
  readonly blobs: Map<string, Blob>;
}

function emptyStorage(): Storage {
  return { rooms: new Map(), texts: new Map(), blobs: new Map() };
}

// One page load against `storage`: the same objects main.ts builds, minus the DOM.
function openPage(storage: Storage) {
  const notes: string[] = [];
  const passed: string[] = [];
  const host: RoomHost = {
    snapshotId: SNAPSHOT.id,
    baked: (file) => SNAPSHOT.sources[file],
    refusal: () => undefined,
    save: (file, update) => storage.rooms.set(file, update),
    changed: () => undefined,
    refused: () => undefined,
    selected: () => undefined,
  };
  const rooms = new DemoRooms(host, new Map(storage.rooms));
  const files = new DemoFiles({ texts: new Map(storage.texts), blobs: new Map(storage.blobs) }, (file, value) => {
    if (typeof value === 'string') {
      storage.texts.set(file, value);
    } else {
      storage.blobs.set(file, value);
    }
  });
  const publish = new DemoPublish({
    siteURL: `${ORIGIN}/demo/site/`,
    saved: storage.texts.get(DEMO_PUBLISH_STATE_FILE),
    persist: (text) => storage.texts.set(DEMO_PUBLISH_STATE_FILE, text),
    finished: () => notes.push(PUBLISH_NOTE),
  });
  rooms.onText(() => publish.edit());
  const routes = demoRoutes({ snapshot: SNAPSHOT, rooms, files, publish, workspace: 'demo-x', unknownRoute: () => undefined });
  const native: typeof fetch = async (input) => {
    passed.push(String(input));
    return new Response('native');
  };
  return { call: fetchStandIn(routes, native), rooms, files, notes, passed, publish };
}

async function answer(call: typeof fetch, route: string, init?: RequestInit): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const response = await call(`${ORIGIN}${route}`, init);
  const body: unknown = await response.json();
  return { status: response.status, body: record(body) };
}

function post(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function readGuide(call: typeof fetch): Promise<string | undefined> {
  return parseMetadataFile((await answer(call, '/studio/api/metadata?kind=guide')).body).source;
}

test.before(() => {
  Object.defineProperty(globalThis, 'location', { configurable: true, value: new URL(`${ORIGIN}/demo/`) });
});

test('a guide change round-trips, survives a reload and is cleared by Reset', async () => {
  const storage = emptyStorage();
  const first = openPage(storage);
  assert.equal(await readGuide(first.call), GUIDE, 'The baked guide is the starting point');
  const visible = GUIDE.replace('"visible":false', '"visible":true');
  const saved = await answer(first.call, '/studio/api/metadata', post({ kind: 'guide', source: visible, base: GUIDE }));
  assert.equal(saved.status, 200);
  assert.equal(saved.body['source'], visible, 'The save answers with what is now stored');
  assert.equal(await readGuide(first.call), visible);
  assert.ok(storage.rooms.has('.stacki/guide.json'), 'A baked settings file is saved through its room');

  const reloaded = openPage(storage);
  assert.equal(await readGuide(reloaded.call), visible, 'The guide survives a reload');

  const reset = openPage(emptyStorage());
  assert.equal(await readGuide(reset.call), GUIDE, 'Reset brings back the baked guide');
  assert.deepEqual([...first.passed, ...reloaded.passed, ...reset.passed], [], 'Nothing reaches the network');
});

test('settings saves refuse a stale base, an unknown kind and invalid content', async () => {
  const { call } = openPage(emptyStorage());
  const stale = await answer(call, '/studio/api/metadata', post({ kind: 'guide', source: GUIDE, base: 'old' }));
  assert.equal(stale.status, 400);
  assert.equal(stale.body['error'], SETTINGS_CONFLICT);
  assert.equal((await answer(call, '/studio/api/metadata', post({ kind: 'secrets', source: '{}' }))).status, 400);
  assert.equal((await answer(call, '/studio/api/metadata', post({ kind: 'guide', source: 'not json', base: GUIDE }))).status, 400);
  assert.equal(await readGuide(call), GUIDE, 'A refused save changes nothing');
});

test('a settings file the bake lacked is created, kept, and gone after Reset', async () => {
  const storage = emptyStorage();
  const first = openPage(storage);
  assert.deepEqual((await answer(first.call, '/studio/api/metadata?kind=pages')).body, {});
  const pages = '{"version":1,"entries":[]}\n';
  const created = await answer(first.call, '/studio/api/metadata', post({ kind: 'pages', source: pages }));
  assert.equal(created.status, 200);
  assert.equal(storage.texts.get('.stacki/pages.json'), pages, 'A new settings file is saved beside the rooms');
  const reloaded = openPage(storage);
  assert.deepEqual((await answer(reloaded.call, '/studio/api/metadata?kind=pages')).body, { source: pages });
  assert.deepEqual((await answer(openPage(emptyStorage()).call, '/studio/api/metadata?kind=pages')).body, {});
  const invalid = await answer(reloaded.call, '/studio/api/metadata', post({ kind: 'pages', source: '{"version":2}', base: pages }));
  assert.equal(invalid.status, 400, 'Content is checked by the same validator as the server');
  assert.equal(storage.texts.get('.stacki/pages.json'), pages);
});

test('a variable edit writes the stylesheet through its room and survives a reload', async () => {
  const storage = emptyStorage();
  const { call, rooms } = openPage(storage);
  const read = await answer(call, '/studio/api/variables');
  const versions = record(read.body['versions']);
  assert.equal(versions['src/styles/base.css'], sha256Hex(CSS), 'Versions are the same digest the server sends');
  const valueStart = CSS.indexOf('#9c75f7');
  const payload = { projectPath: '/studio', file: '/studio/src/styles/base.css', valueStart, valueEnd: valueStart + 7, expect: '#9c75f7', value: '#ff0000' };
  const edited = await answer(call, '/studio/api/variables', post({ operation: 'setCssVariable', payload, versions }));
  assert.deepEqual(edited.body, { ok: true });
  assert.match(rooms.read('src/styles/base.css') ?? '', /--brand: #ff0000;/);
  // A style-only change is saved after the room's short classify delay, as a typed one is.
  await new Promise((resolve) => setTimeout(resolve, ROOM_SAVE_WAIT_MS));
  assert.match(openPage(storage).rooms.read('src/styles/base.css') ?? '', /--brand: #ff0000;/, 'The edit survives a reload');
  const stale = await answer(
    call,
    '/studio/api/variables',
    post({ operation: 'setCssVariable', payload: { ...payload, expect: '#ff0000', value: '#00ff00' }, versions }),
  );
  assert.deepEqual(stale.body, { ok: false, error: VARIABLE_CONFLICT }, 'An edit against an old version is refused');
  assert.match(rooms.read('src/styles/base.css') ?? '', /--brand: #ff0000;/);
});

test('an upload is listed, served from the browser, kept across a reload, and gone after Reset', async () => {
  const storage = emptyStorage();
  const first = openPage(storage);
  const bytes = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
  const uploaded = await answer(first.call, '/studio/api/upload?file=public%2Fnew.png', { method: 'POST', body: bytes });
  assert.equal(uploaded.status, 201);
  assert.deepEqual(uploaded.body, { file: 'public/new.png' });
  const entries = (await answer(first.call, '/studio/api/assets')).body['entries'];
  assert.ok(Array.isArray(entries));
  assert.deepEqual(
    entries.map((entry: unknown) => record(entry)['rel']),
    ['public/og.png', 'public/new.png'],
  );
  const url = first.files.uploadURL('public/new.png');
  assert.ok(url?.startsWith('blob:'), 'An upload loads from the browser');
  const resolve = (file: string) => first.files.uploadURL(file) ?? publicAssetResolver(SNAPSHOT.base)(file);
  assert.equal(assetSiteURL('/studio/api/asset?file=public%2Fnew.png', ORIGIN, resolve), url);
  assert.equal(assetSiteURL('/studio/api/asset?file=public%2Fog.png', ORIGIN, resolve), '/demo/site/og.png');

  const reloaded = openPage(storage);
  assert.equal(reloaded.files.hasUpload('public/new.png'), true, 'The upload survives a reload');
  assert.equal(openPage(emptyStorage()).files.hasUpload('public/new.png'), false, 'Reset forgets it');
});

test('uploads refuse other folders, duplicates, other types and the count limit', async () => {
  const { call, files } = openPage(emptyStorage());
  const send = (file: string) => answer(call, `/studio/api/upload?file=${encodeURIComponent(file)}`, { method: 'POST', body: new Blob(['x']) });
  const elsewhere = await send('src/assets/a.png');
  assert.equal(elsewhere.status, 400);
  assert.equal(elsewhere.body['error'], UPLOAD_FOLDER_REASON);
  assert.equal((await send('public/og.png')).status, 400, 'A baked file is never replaced');
  assert.equal((await send('public/notes.txt')).status, 400, 'Only media types are assets');
  assert.equal((await send('public/../secret.png')).status, 400);
  for (let index = 0; index < UPLOAD_LIMITS.filesMax; index++) {
    assert.equal((await send(`public/${index}.png`)).status, 201);
  }
  assert.equal((await send('public/one-more.png')).status, 400, 'The count limit holds');
  assert.equal((await send('public/0.png')).status, 400, 'A second upload of a name is refused');
  assert.equal(files.uploadCount(), UPLOAD_LIMITS.filesMax);
  const change = await answer(call, '/studio/api/assets', post({ operation: 'delete', file: 'public/0.png' }));
  assert.equal(change.status, 403);
  assert.equal(change.body['error'], ASSET_CHANGE_REASON);
});

/** Runs one publish through the stand-in the way the client does: POST, then poll. */
async function runPublish(
  call: typeof fetch,
  target: 'all' | 'github' | 'hosting',
): Promise<{ readonly stages: readonly string[]; readonly state: PublishState }> {
  const started = parsePublishState((await answer(call, `/studio/api/publish?target=${target}`, { method: 'POST' })).body);
  assert.equal(started.kind, 'building');
  const stages: string[] = [started.kind === 'building' ? (started.stage ?? '') : ''];
  let state: PublishState = started;
  for (let poll = 0; poll < 10 && state.kind === 'building'; poll++) {
    state = parsePublishState((await answer(call, '/studio/api/status')).body['publishing']);
    stages.push(state.kind === 'building' ? (state.stage ?? '') : state.kind);
  }
  return { stages, state };
}

async function availabilityOf(call: typeof fetch) {
  return parsePublishAvailability((await answer(call, '/studio/api/publish/availability')).body);
}

test('the menu starts connected: 3 commits to push and changes to deploy to Cloudflare', async () => {
  const { call } = openPage(emptyStorage());
  assert.deepEqual((await answer(call, '/studio/api/session')).body, { kind: 'local', editing: 'draft' });
  const availability = await availabilityOf(call);
  assert.equal(availability.github, 'pending');
  assert.equal(availability.githubPush?.commits, 3, 'The menu reads "3 commits to push"');
  assert.equal(availability.githubPush?.repositoryUrl, `https://github.com/${DEMO_REPOSITORY}`);
  assert.equal(availability.hosting, 'pending', 'The menu reads "Changes to deploy"');
  const config = parsePublishSource(parseMetadataFile((await answer(call, '/studio/api/metadata?kind=publish')).body).source);
  assert.equal(config.hosting.provider, 'cloudflare-workers', 'Hosting is a connected Cloudflare Worker');
  assert.equal(config.hosting.provider === 'cloudflare-workers' ? config.hosting.project : '', DEMO_CLOUDFLARE_PROJECT);
  assert.equal(config.defaultTarget, 'all');
});

test('a push clears the commits and disables Push until an edit adds one again', async () => {
  const storage = emptyStorage();
  const { call, rooms, notes, passed } = openPage(storage);
  const push = await runPublish(call, 'github');
  assert.deepEqual(push.stages, ['preparing', 'committing', 'committed']);
  assert.equal(push.state.kind === 'committed' ? push.state.deployment : 'none', undefined, 'A push alone deploys nothing');
  let availability = await availabilityOf(call);
  assert.equal(availability.github, 'current', 'Push to GitHub is disabled: nothing to push');
  assert.equal(availability.githubPush?.commits, 0);
  assert.equal(availability.hosting, 'pending', 'The push left the deploy waiting');
  assert.equal((await availabilityOf(openPage(storage).call)).github, 'current', 'The push survives a reload');

  rooms.get('src/styles/base.css').setSource(CSS.replace('#9c75f7', '#00ff00'));
  rooms.get('src/styles/base.css').setSource(CSS.replace('#9c75f7', '#0000ff'));
  availability = await availabilityOf(call);
  assert.equal(availability.github, 'pending', 'An edit enables Push again');
  assert.equal(availability.githubPush?.commits, 1, 'A batch of edits is one commit');
  assert.equal((await availabilityOf(call)).githubPush?.commits, 1, 'Reading again adds nothing');
  assert.deepEqual(notes, [PUBLISH_NOTE]);
  assert.deepEqual(passed, [], 'No git or network call happens');
  assert.equal((await availabilityOf(openPage(emptyStorage()).call)).githubPush?.commits, 3, 'Reset starts again from 3 commits');
});

test('a deploy runs Cloudflare steps to a live result on the demo site itself', async () => {
  const { call, notes } = openPage(emptyStorage());
  const deploy = await runPublish(call, 'hosting');
  assert.deepEqual(deploy.stages, ['preparing', 'building', 'deploying', 'committed']);
  assert.equal(deploy.state.kind, 'committed');
  if (deploy.state.kind === 'committed') {
    assert.equal(deploy.state.deployment, 'live');
    assert.equal(deploy.state.github, 'skipped', 'Deploying alone leaves GitHub as it was');
    assert.equal(deploy.state.url, `${ORIGIN}/demo/site/`, 'The result points at the demo itself, never a fake deploy');
  }
  const availability = await availabilityOf(call);
  assert.equal(availability.hosting, 'current', 'Deploy to hosting is up to date');
  assert.equal(availability.githubPush?.commits, 3, 'The commits still wait for a push');
  const all = await runPublish(call, 'all');
  assert.deepEqual(all.stages, ['preparing', 'building', 'committing', 'deploying', 'committed']);
  assert.deepEqual(await availabilityOf(call), {
    github: 'current',
    hosting: 'current',
    githubPush: { commits: 0, repositoryUrl: `https://github.com/${DEMO_REPOSITORY}` },
  });
  assert.equal(notes.length, 2);
});

test('publish settings show the connected accounts and never start a sign-in', async () => {
  const { call } = openPage(emptyStorage());
  const discover = async (provider: string) =>
    parsePublishDiscovery((await answer(call, '/studio/api/publish/discover', post({ provider, account: '' }))).body);
  const cloudflare = await discover('cloudflare');
  assert.equal(cloudflare.kind === 'ready' ? cloudflare.projects[0]?.name : '', DEMO_CLOUDFLARE_PROJECT);
  const github = await discover('github');
  assert.equal(github.kind === 'ready' ? github.accounts.length : 0, 1);
  assert.equal((await discover('vercel')).kind, 'failed');
  const repositories = parseRepositoryResult((await answer(call, '/studio/api/publish/repository', post({ action: 'list', account: 'stacki-demo' }))).body);
  assert.equal(repositories.ok ? repositories.value.connected : '', DEMO_REPOSITORY);
  const create = parseRepositoryResult(
    (await answer(call, '/studio/api/publish/repository', post({ action: 'create', account: 'stacki-demo', name: 'x', private: true }))).body,
  );
  assert.deepEqual(create, { ok: false, error: CONNECTIONS_REASON });
  const signIn = parseAccountState(
    (await answer(call, '/studio/api/publish/account', post({ action: 'start', id: '00000000-0000-4000-8000-000000000000', provider: 'github' }))).body,
  );
  assert.deepEqual(signIn, { kind: 'failed', message: CONNECTIONS_REASON });
  assert.deepEqual((await answer(call, '/studio/api/publish/site-url')).body, {}, 'No domain is invented for the demo');
});

test('a second Publish starts a new run, and a click mid-run joins it', () => {
  const publish = new DemoPublish({ siteURL: 'https://x.test/', saved: undefined, persist: () => undefined, finished: () => undefined });
  assert.deepEqual(publish.poll(), { kind: 'idle' }, 'Nothing runs before a click');
  const first = publish.start('all');
  assert.deepEqual(publish.start('github'), first, 'A click while running joins the run');
  for (let poll = 0; poll < 4; poll++) {
    publish.poll();
  }
  const second = publish.start('all');
  assert.equal(second.kind, 'building');
  assert.notEqual('id' in second ? second.id : '', 'id' in first ? first.id : '');
  const idle = new DemoPublish({ siteURL: 'https://x.test/', saved: undefined, persist: () => undefined, finished: () => undefined });
  assert.throws(() => idle.start('everything'), /Choose all, github, or hosting/);
});

test('the page stand-in for node:path agrees with POSIX node:path on the engine calls', () => {
  const cases: readonly (readonly string[])[] = [
    ['/studio', 'src/styles/a.css'],
    ['/studio', 'src/../public/b.css'],
    ['/studio/src', '/studio/public'],
  ];
  for (const parts of cases) {
    assert.equal(posix.resolve(...parts), path.posix.resolve(...parts));
    assert.equal(posix.join(...parts), path.posix.join(...parts));
  }
  assert.equal(posix.relative('/studio', '/studio/src/a.css'), path.posix.relative('/studio', '/studio/src/a.css'));
  assert.equal(posix.relative('/studio/src', '/studio/public/x'), path.posix.relative('/studio/src', '/studio/public/x'));
  assert.equal(posix.relative('/studio', '/studio'), '');
  assert.equal(posix.basename('/studio/src/a.css'), 'a.css');
  assert.equal(posix.sep, '/');
  assert.throws(() => posix.resolve('relative'), /absolute root/);
});

test('the page stand-in for AsyncLocalStorage scopes a store to its run, as Node does', () => {
  for (const Storage of [AsyncLocalStorage, NodeAsyncLocalStorage]) {
    const storage = new Storage<string>();
    assert.equal(storage.getStore(), undefined);
    const seen = storage.run('outer', () => [storage.getStore(), storage.run('inner', () => storage.getStore()), storage.getStore()]);
    assert.deepEqual(seen, ['outer', 'inner', 'outer']);
    assert.throws(
      () =>
        storage.run('x', () => {
          throw new Error('boom');
        }),
      /boom/,
    );
    assert.equal(storage.getStore(), undefined, 'A throwing run still restores the store');
  }
});
