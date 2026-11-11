// Goal: sharing and publishing apps behave as docs/apps.md says. A share of an
// uploaded app creates the repository with the chosen visibility (private by
// default), adds the `stacki-app` topic, commits the bundle (a public one with
// the MIT LICENSE), and releases `v<version>` with the zip, reporting each step
// as it starts; a step that fails stops the share and names exactly what was
// created. The secret scan blocks a share, private too, before any request. An
// uploaded app switches to the release it was shared as, auto-update off; so
// does an app added to the project folder (source `local`), which gets its
// lock entry then and keeps its files.
// Making a repository public is one request whose refusals (scope, admin,
// policy) are values with a link to its settings. "Add MIT license" commits a
// standard LICENSE. A submission posts the release address and `accept` with
// the account's token, only once every check passes, and a marketplace that
// cannot be reached reads as unavailable. App settings keep secrets in a vault
// outside the project, never under `.stacki`. The channels are gated by role.
// Method: temporary projects on a real disk and a fake GitHub (a fetch that
// answers the REST calls a share makes, stores what is uploaded and serves it
// back) whose answers each case changes; every request is recorded.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readAppBundle, writeStoredZip } from '#dist/shared/properties/appBundle.js';
import { createAppService, nodeInflateRaw } from '#dist/electron/project/appService.js';
import { createAppPublishService } from '#dist/electron/project/appPublishService.js';
import { makeRepositoryPublic } from '#dist/electron/project/appGitHubWrite.js';
import { listInstalledApps, readAppsLock } from '#dist/electron/project/appStore.js';
import { readAppSettings, secretVaultFile, writeAppSettings } from '#dist/electron/project/appSettingsStore.js';
import { CHANNEL_ACCESS } from '#dist/electron/handlers/channelAccess.js';
// The running Stacki these tests stand in for: new enough for every fixture bundle.
const STACKI_VERSION = '1.1.0';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const NOW = Date.parse('2026-11-10T00:00:00Z');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const API = 'https://api.github.com';

function project(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-publish-')));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  return root;
}

const HEAT_MAP_MANIFEST = {
  manifestVersion: 1,
  id: 'heat-map',
  name: 'Heat map',
  version: '1.2.0',
  entry: 'index.html',
  settings: [
    { id: 'api-key', label: 'API key', kind: 'secret', required: true },
    { id: 'endpoint', label: 'Endpoint', kind: 'url' },
  ],
};

// The same app added straight to `.stacki/apps/heat-map/`, as a pull or an agent would: no lock entry.
function addToFolder(root: string, script: string): void {
  const folder = path.join(root, '.stacki', 'apps', 'heat-map');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'stacki-app.json'), JSON.stringify(HEAT_MAP_MANIFEST));
  fs.writeFileSync(path.join(folder, 'index.html'), '<p>Heat map</p>');
  fs.writeFileSync(path.join(folder, 'app.js'), script);
}

// An app uploaded from a file, with a secret setting; `script` is its app.js.
function installUploaded(root: string, script: string): void {
  const files = { 'stacki-app.json': JSON.stringify(HEAT_MAP_MANIFEST), 'index.html': '<p>Heat map</p>', 'app.js': script };
  const zip = writeStoredZip(Object.entries(files).map(([filePath, text]) => ({ path: filePath, bytes: encoder.encode(text) })));
  const apps = createAppService({ stackiVersion: STACKI_VERSION, fetch: async () => new Response('', { status: 500 }), now: () => NOW });
  const staged = apps.stageFile(root, zip, 'heat-map.zip');
  assert.ok(staged.ok);
  assert.ok(apps.commit(root, staged.value.token).ok);
}

interface Call {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

interface FakeOptions {
  /** Answers the release upload with this status. */
  uploadStatus?: number;
  /** What GitHub says of the repository's license, for the status read. */
  license?: string | undefined;
  private?: boolean;
  /** The make-public reply. */
  visibility?: { readonly status: number; readonly scopes?: string };
  /** The marketplace's submission reply, or a thrown network error. */
  submission?: { readonly status: number; readonly body: string } | 'offline';
}

function parseJSON(text: string): unknown {
  const value: unknown = JSON.parse(text);
  return value;
}

// One field of a recorded request body, whatever its shape.
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

function treeOf(value: unknown): { path: string; sha: string }[] {
  assert.ok(Array.isArray(value), 'A tree is a list');
  return value.map((entry: unknown) => ({ path: String(field(entry, 'path')), sha: String(field(entry, 'sha')) }));
}

// GitHub and the marketplace as the publish service sees them.
function fakeGitHub(options: FakeOptions = {}) {
  const calls: Call[] = [];
  const trees: { path: string; sha: string }[][] = [];
  const blobs = new Map<string, Uint8Array>();
  let uploaded: Uint8Array | undefined;
  let licensed = options.license;
  const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? parseJSON(init.body) : init.body instanceof Blob ? new Uint8Array(await init.body.arrayBuffer()) : undefined;
    calls.push({ method, url, authorization: new Headers(init.headers).get('authorization') ?? undefined, body });
    const json = (value: unknown, status = 200) => Response.json(value, { status });
    if (method === 'POST' && (url === `${API}/user/repos` || url === `${API}/orgs/acme/repos`)) {
      return json({ default_branch: 'main' }, 201);
    }
    if (url.endsWith('/topics')) {
      return json({ names: method === 'PUT' ? ['stacki-app'] : [] });
    }
    if (url.endsWith('/git/ref/heads/main')) {
      return json({ object: { sha: 'c0' } });
    }
    if (url.endsWith('/git/commits/c0')) {
      return json({ tree: { sha: 't0' } });
    }
    if (url.endsWith('/git/blobs')) {
      const sha = `b${blobs.size}`;
      const content = String(field(body, 'content'));
      blobs.set(sha, new Uint8Array(Buffer.from(content, 'base64')));
      return json({ sha }, 201);
    }
    if (url.endsWith('/git/trees')) {
      trees.push(treeOf(field(body, 'tree')));
      if (trees.at(-1)?.some((entry) => entry.path === 'LICENSE') === true) {
        licensed = 'MIT';
      }
      return json({ sha: 't1' }, 201);
    }
    if (url.endsWith('/git/commits')) {
      return json({ sha: 'c1' }, 201);
    }
    if (method === 'PATCH' && url.endsWith('/git/refs/heads/main')) {
      return json({});
    }
    if (method === 'POST' && url.endsWith('/releases')) {
      return json({ id: 9 }, 201);
    }
    if (url.startsWith('https://uploads.github.com/')) {
      if ((options.uploadStatus ?? 201) >= 300) {
        return json({ message: 'Upload failed' }, options.uploadStatus);
      }
      uploaded = body instanceof Uint8Array ? body : undefined;
      return json({ id: 1 }, 201);
    }
    if (method === 'PATCH' && /\/repos\/[^/]+\/[^/]+$/.test(url)) {
      const reply = options.visibility ?? { status: 200 };
      return new Response('{}', { status: reply.status, headers: reply.scopes === undefined ? {} : { 'x-oauth-scopes': reply.scopes } });
    }
    if (url === `${API}/repos/octocat/heat-map`) {
      return json({
        private: options.private ?? false,
        topics: ['stacki-app'],
        license: licensed === undefined ? undefined : { spdx_id: licensed },
        owner: { login: 'octocat' },
        default_branch: 'main',
      });
    }
    if (url === `${API}/users/octocat` || url === `${API}/users/acme`) {
      return json({ name: url.endsWith('acme') ? 'Acme Inc' : 'The Octocat' });
    }
    if (url.endsWith('/releases/latest') || url.endsWith('/releases/tags/v1.2.0')) {
      if (uploaded === undefined) {
        return json({ message: 'Not Found' }, 404);
      }
      const owner = url.includes('/acme/') ? 'acme' : 'octocat';
      return json({
        tag_name: 'v1.2.0',
        assets: [{ name: 'heat-map.zip', size: uploaded.byteLength, url: `${API}/repos/${owner}/heat-map/releases/assets/1` }],
      });
    }
    if (url.endsWith('/releases/assets/1')) {
      return new Response(uploaded === undefined ? undefined : new Uint8Array(uploaded));
    }
    if (url === 'https://marketplace.test/submissions') {
      if (options.submission === 'offline') {
        throw new TypeError('fetch failed');
      }
      const reply = options.submission ?? { status: 201, body: '{"ok":true,"id":3,"status":"pending"}' };
      return new Response(reply.body, { status: reply.status });
    }
    return json({ message: 'Not Found' }, 404);
  };
  return { fetcher, calls, trees, blobs, uploadedBytes: () => uploaded };
}

function publisher(fetcher: (url: string, init: RequestInit) => Promise<Response>) {
  return createAppPublishService({
    fetch: fetcher,
    now: () => NOW,
    tokenFor: async () => 'token-1',
    inflateRaw: nodeInflateRaw,
    deflateRaw: (data: Uint8Array) => new Uint8Array(deflateRawSync(data)),
    submissionsURL: 'https://marketplace.test/submissions',
    checkURL: 'https://marketplace.test/check',
  });
}

const CLEAN_SCRIPT = 'const settings = await stacki.settings.get();';
const SHARE = { id: 'heat-map', account: 'octocat', owner: 'octocat', ownerKind: 'user', name: 'heat-map' } as const;

test('a private share creates a private repository, tags it, commits the bundle and releases the zip, step by step', async () => {
  const root = project();
  installUploaded(root, CLEAN_SCRIPT);
  const github = fakeGitHub();
  const steps: string[] = [];
  const result = await publisher(github.fetcher).share(root, { ...SHARE, visibility: 'private' }, (step) => steps.push(step));
  assert.ok(result.ok, result.ok ? '' : result.message);
  assert.equal(result.value.kind, 'shared');
  assert.deepEqual(steps, ['create-repository', 'add-topic', 'commit-files', 'create-release']);
  const create = github.calls.find((call) => call.url === `${API}/user/repos`);
  assert.deepEqual(create?.body, { name: 'heat-map', description: 'Heat map, a Stacki app', private: true, auto_init: true });
  assert.deepEqual(
    github.trees[0]?.map((entry) => entry.path).sort(),
    ['app.js', 'index.html', 'stacki-app.json'],
    'A private share commits the bundle and no license',
  );
  const release = github.calls.find((call) => call.method === 'POST' && call.url.endsWith('/releases'));
  assert.equal(field(release?.body, 'tag_name'), 'v1.2.0');
  assert.ok(
    github.calls.every((call) => call.authorization === 'Bearer token-1'),
    'Every write carries the account’s token',
  );
  const upload = github.calls.find((call) => call.url.startsWith('https://uploads.github.com/'));
  assert.equal(upload?.url, 'https://uploads.github.com/repos/octocat/heat-map/releases/9/assets?name=heat-map.zip');
  if (result.value.kind === 'shared') {
    assert.equal(result.value.shared.sha256, sha256(github.uploadedBytes() ?? new Uint8Array()));
    assert.equal(result.value.shared.visibility, 'private');
  }
});

test('a public share under an organization adds the MIT license for its owner', async () => {
  const root = project();
  installUploaded(root, CLEAN_SCRIPT);
  const github = fakeGitHub();
  const result = await publisher(github.fetcher).share(root, { ...SHARE, owner: 'acme', ownerKind: 'organization', visibility: 'public' }, () => undefined);
  assert.ok(result.ok);
  assert.equal(field(github.calls.find((call) => call.url === `${API}/orgs/acme/repos`)?.body, 'private'), false);
  const license = github.trees[0]?.find((entry) => entry.path === 'LICENSE');
  assert.ok(license !== undefined, 'A public share commits a LICENSE');
  const text = decoder.decode(github.blobs.get(license.sha));
  assert.match(text, /^MIT License\n\nCopyright \(c\) 2026 Acme Inc\n/);
});

test('a step that fails stops the share and names exactly what was created', async () => {
  const root = project();
  installUploaded(root, CLEAN_SCRIPT);
  const github = fakeGitHub({ uploadStatus: 500 });
  const result = await publisher(github.fetcher).share(root, { ...SHARE, visibility: 'private' }, () => undefined);
  assert.ok(result.ok);
  assert.equal(result.value.kind, 'failed');
  if (result.value.kind === 'failed') {
    assert.equal(result.value.step, 'create-release');
    assert.match(result.value.message, /GitHub answered 500 when asked to upload the app bundle: Upload failed/);
    assert.deepEqual(result.value.created, [
      'The private repository octocat/heat-map, with a README on main',
      'The stacki-app topic on octocat/heat-map',
      'A commit of 3 files on main',
      'The release v1.2.0, without its asset yet',
    ]);
  }
  assert.equal(readAppsLock(root).apps[0]?.source.kind, 'file', 'A failed share changes nothing in the project');
});

test('the secret scan blocks a private share before any request', async () => {
  const root = project();
  installUploaded(root, `const key = "${'sk-'}${'aB3'.repeat(14)}";`);
  const github = fakeGitHub();
  const result = await publisher(github.fetcher).share(root, { ...SHARE, visibility: 'private' }, () => undefined);
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.message, /secret scan did not pass, so nothing was created on GitHub/);
  assert.deepEqual(github.calls, [], 'Nothing reached GitHub');
  const scan = publisher(github.fetcher).scanInstalled(root, 'heat-map');
  assert.ok(scan.ok);
  assert.equal(scan.value.kind, 'found');
});

test('a shared app switches from its file to the release, auto-update off', async () => {
  const root = project();
  installUploaded(root, CLEAN_SCRIPT);
  const github = fakeGitHub();
  const service = publisher(github.fetcher);
  const shared = await service.share(root, { ...SHARE, visibility: 'private' }, () => undefined);
  assert.ok(shared.ok);
  assert.equal(shared.value.kind, 'shared');
  const source = { kind: 'github', owner: 'octocat', repository: 'heat-map', asset: 'heat-map.zip', account: 'octocat', tag: 'v1.2.0' } as const;
  const switched = await service.switchSource(root, 'heat-map', source);
  assert.ok(switched.ok, switched.ok ? '' : switched.message);
  const entry = readAppsLock(root).apps[0];
  assert.deepEqual(entry?.source, source);
  assert.equal(entry?.autoUpdate, false);
  assert.equal(entry?.sha256, sha256(github.uploadedBytes() ?? new Uint8Array()));
  assert.equal(listInstalledApps(root)[0]?.manifest.version, '1.2.0');
  const again = await service.switchSource(root, 'heat-map', source);
  assert.equal(again.ok, false, 'Only a file-sourced app switches');
});

test('an app added to the project folder shares like an uploaded one, then gets a lock entry for its release', async () => {
  const root = project();
  addToFolder(root, CLEAN_SCRIPT);
  assert.deepEqual(listInstalledApps(root)[0]?.lock.source, { kind: 'local' });
  assert.equal(readAppsLock(root).apps.length, 0, 'a folder app has no lock entry');
  const github = fakeGitHub();
  const service = publisher(github.fetcher);
  const shared = await service.share(root, { ...SHARE, visibility: 'private' }, () => undefined);
  assert.ok(shared.ok, shared.ok ? '' : shared.message);
  assert.equal(shared.value.kind, 'shared');
  const released = releasedPaths(github.uploadedBytes());
  assert.deepEqual(released, ['app.js', 'index.html', 'stacki-app.json'], 'the release holds the folder’s files');
  const before = fs.readFileSync(path.join(root, '.stacki', 'apps', 'heat-map', 'app.js'), 'utf8');
  const source = { kind: 'github', owner: 'octocat', repository: 'heat-map', asset: 'heat-map.zip', account: 'octocat', tag: 'v1.2.0' } as const;
  const switched = await service.switchSource(root, 'heat-map', source);
  assert.ok(switched.ok, switched.ok ? '' : switched.message);
  assert.deepEqual(switched.value.lock.source, source);
  const entries = readAppsLock(root).apps;
  assert.equal(entries.length, 1, 'the switch records the folder app');
  assert.deepEqual(entries[0]?.source, source);
  assert.equal(entries[0]?.autoUpdate, false);
  assert.equal(entries[0]?.sha256, sha256(github.uploadedBytes() ?? new Uint8Array()));
  assert.equal(fs.readFileSync(path.join(root, '.stacki', 'apps', 'heat-map', 'app.js'), 'utf8'), before, 'its files stay as they were');
  const again = await service.switchSource(root, 'heat-map', source);
  assert.equal(again.ok, false, 'a GitHub app does not switch again');
});

/** The paths in a released zip, sorted. */
function releasedPaths(bytes: Uint8Array | undefined): readonly string[] {
  assert.ok(bytes !== undefined, 'a release was uploaded');
  const bundle = readAppBundle(bytes, nodeInflateRaw);
  return bundle.files.map((file) => file.path).sort();
}

test('making a repository public is one request, and each refusal says why', async () => {
  const cases: readonly (readonly [NonNullable<FakeOptions['visibility']>, string, string | undefined])[] = [
    [{ status: 200 }, 'public', undefined],
    [{ status: 403, scopes: 'read:org, workflow' }, 'forbidden', 'scope'],
    [{ status: 403, scopes: 'repo, read:org' }, 'forbidden', 'admin'],
    [{ status: 404 }, 'forbidden', 'admin'],
    [{ status: 422 }, 'forbidden', 'policy'],
  ];
  for (const [visibility, kind, reason] of cases) {
    const github = fakeGitHub({ visibility });
    const outcome = await makeRepositoryPublic(github.fetcher, 'token-1', 'acme', 'tool');
    assert.equal(github.calls.length, 1, 'One request');
    assert.deepEqual(github.calls[0]?.body, { private: false });
    assert.equal(outcome.kind, kind);
    if (outcome.kind === 'forbidden') {
      assert.equal(outcome.reason, reason);
      assert.equal(outcome.settingsURL, 'https://github.com/acme/tool/settings');
    }
  }
});

test('Add MIT license commits a standard LICENSE and the status reads MIT afterwards', async () => {
  const github = fakeGitHub({ license: undefined });
  const result = await publisher(github.fetcher).addLicense('octocat', 'heat-map', 'octocat');
  assert.ok(result.ok, result.ok ? '' : result.message);
  assert.equal(result.value.license, 'MIT');
  assert.deepEqual(
    github.trees[0]?.map((entry) => entry.path),
    ['LICENSE'],
  );
  const license = github.trees[0]?.[0];
  assert.match(decoder.decode(github.blobs.get(license?.sha ?? '')), /Copyright \(c\) 2026 The Octocat/);
});

// A public, tagged, MIT repository whose release is a shared, clean app.
async function readyRepository(options: FakeOptions) {
  const root = project();
  installUploaded(root, CLEAN_SCRIPT);
  const github = fakeGitHub({ license: 'MIT', ...options });
  assert.ok((await publisher(github.fetcher).share(root, { ...SHARE, visibility: 'public' }, () => undefined)).ok);
  return github;
}

const SUBMISSION = { owner: 'octocat', repository: 'heat-map', account: 'octocat', acceptedTerms: true } as const;

test('a ready repository is submitted with the account’s token, its release address and accept', async () => {
  const github = await readyRepository({});
  const result = await publisher(github.fetcher).submit(SUBMISSION);
  assert.ok(result.ok, result.ok ? '' : result.message);
  assert.deepEqual(result.value, { kind: 'submitted', id: 3, updated: false });
  const post = github.calls.find((call) => call.url === 'https://marketplace.test/submissions');
  assert.equal(post?.authorization, 'Bearer token-1');
  assert.deepEqual(post?.body, { repository: 'https://github.com/octocat/heat-map/releases/tag/v1.2.0', accept: true });
});

test('a marketplace that cannot be reached, or is not set up, reads as unavailable', async () => {
  const offline = await readyRepository({ submission: 'offline' });
  const unreachable = await publisher(offline.fetcher).submit(SUBMISSION);
  assert.ok(unreachable.ok);
  assert.equal(unreachable.value.kind, 'unavailable');
  const unconfigured = await readyRepository({ submission: { status: 503, body: '{"ok":false,"code":"unconfigured","message":"Not set up"}' } });
  const answer = await publisher(unconfigured.fetcher).submit(SUBMISSION);
  assert.ok(answer.ok);
  assert.equal(answer.value.kind, 'unavailable');
});

test('a repository that is not MIT licensed is refused before anything is sent', async () => {
  const github = await readyRepository({ license: 'GPL-3.0' });
  // The public share's LICENSE commit makes the fake read MIT; set it back to what GitHub detected.
  const notMIT = fakeGitHub({ license: 'GPL-3.0' });
  const fetcher = async (url: string, init: RequestInit) => (url === `${API}/repos/octocat/heat-map` ? notMIT.fetcher(url, init) : github.fetcher(url, init));
  const result = await publisher(fetcher).submit(SUBMISSION);
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.message, /not ready for the marketplace: license/);
  assert.ok(!github.calls.some((call) => call.url === 'https://marketplace.test/submissions'), 'Nothing was posted');
});

test('secret settings are kept in a vault outside the project, never under .stacki', () => {
  const root = project();
  installUploaded(root, CLEAN_SCRIPT);
  const vaultDirectory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-vault-')));
  const vault = {
    directory: () => vaultDirectory,
    seal: {
      refusal: () => undefined,
      seal: (value: string) => `sealed:${Buffer.from(value).toString('base64')}`,
      open: (sealed: string) => Buffer.from(sealed.slice(7), 'base64').toString(),
    },
  };
  const manifest = listInstalledApps(root)[0]?.manifest;
  assert.ok(manifest !== undefined);
  const secret = 'the-users-own-key-123';
  const written = writeAppSettings(root, vault, manifest, { 'api-key': secret, endpoint: 'https://example.test' });
  assert.deepEqual(written, { 'api-key': secret, endpoint: 'https://example.test' });
  assert.deepEqual(readAppSettings(root, vault, manifest), written);
  const file = secretVaultFile(vault, root);
  assert.ok(path.relative(root, file).startsWith('..'), 'The vault file is not under the project');
  // Nothing under the project holds the secret, sealed or not.
  const stack = [path.join(root, '.stacki')];
  for (let index = 0; index < 100 && stack.length > 0; index += 1) {
    const directory = stack.pop() ?? '';
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else {
        const text = fs.readFileSync(full, 'utf8');
        assert.ok(!text.includes(secret), `${full} holds the secret`);
        assert.ok(!text.includes(Buffer.from(secret).toString('base64')), `${full} holds the sealed secret`);
      }
    }
  }
  assert.match(fs.readFileSync(path.join(root, '.stacki/apps/settings.json'), 'utf8'), /"endpoint": "https:\/\/example.test"/);
  // A vault pointed inside the project is a broken invariant, not a place to write.
  assert.throws(() => secretVaultFile({ directory: () => path.join(root, '.stacki') }, root), /never inside the project/);
  // A host that cannot seal refuses secrets and saves nothing.
  const refusing = { ...vault, seal: { ...vault.seal, refusal: () => 'This computer cannot encrypt secrets.' } };
  assert.throws(() => writeAppSettings(root, refusing, manifest, { 'api-key': 'other' }), /cannot encrypt secrets\. Nothing was saved/);
});

test('sharing and publishing channels are gated by their role features', () => {
  assert.deepEqual(CHANNEL_ACCESS['apps:share'], ['apps:share']);
  assert.deepEqual(CHANNEL_ACCESS['apps:switchSource'], ['apps:share']);
  assert.deepEqual(CHANNEL_ACCESS['apps:makePublic'], ['marketplace:publish']);
  assert.deepEqual(CHANNEL_ACCESS['apps:addLicense'], ['marketplace:publish']);
  assert.deepEqual(CHANNEL_ACCESS['apps:checkMarketplace'], ['marketplace:publish']);
  assert.deepEqual(CHANNEL_ACCESS['apps:submitMarketplace'], ['marketplace:publish']);
  assert.deepEqual(CHANNEL_ACCESS['apps:scanSecrets'], ['apps:share', 'marketplace:publish']);
  assert.deepEqual(CHANNEL_ACCESS['apps:writeSettings'], ['panel:apps']);
});
