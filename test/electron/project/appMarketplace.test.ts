// Goal: the update policy and the marketplace install hold as docs/apps.md and
// docs/marketplace.md say. A marketplace install writes only bytes whose SHA-256
// the index approved, and records `source: marketplace`; a release swapped after
// review installs nothing. With auto-update off (every app's default) an update
// check installs nothing: it records the update for a person to choose. With it
// on, a marketplace app installs only the newest approved version (never a newer
// unapproved release) and a GitHub app installs the release it checked. A
// withdrawn approval stops a waiting update. The index is read from
// stacki.build; a refusal (a 404) or a reply that is not an index fails with a
// short technical reason the panel shows as its small print. Only a development
// build reads another index, and only admin switches auto-update; both marketplace channels
// are gated by their role features in main.
// Method: temporary projects on a real disk; a fake network that serves an
// index and a GitHub repository whose releases, digests and bytes each case sets.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeStoredZip } from '#dist/shared/properties/appBundle.js';
import { MARKETPLACE_INDEX_URL } from '#dist/shared/properties/appMarketplace.js';
import { carriedAutoUpdate, createAppService } from '#dist/electron/project/appService.js';
import { MARKETPLACE_INDEX_URL_VARIABLE, fetchMarketplaceIndex, marketplaceIndexURL } from '#dist/electron/project/appMarketplace.js';
import { readAppsLock } from '#dist/electron/project/appStore.js';
import { CHANNEL_ACCESS } from '#dist/electron/handlers/channelAccess.js';
// The running Stacki these tests stand in for: new enough for every fixture bundle.
const STACKI_VERSION = '1.1.0';

const encoder = new TextEncoder();
const INDEX_URL = 'https://index.test/apps.json';

function project(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-marketplace-')));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  return root;
}

function appZip(version: string, extra = '', hosts: readonly string[] = []): Uint8Array {
  const network = hosts.map((host) => ({ host, purpose: 'Data for the map' }));
  const manifest = { manifestVersion: 1, id: 'heat-map', name: 'Heat map', version, entry: 'index.html', ...(network.length > 0 ? { network } : {}) };
  return writeStoredZip([
    { path: 'stacki-app.json', bytes: encoder.encode(JSON.stringify(manifest)) },
    { path: 'index.html', bytes: encoder.encode(`<p>v${version}${extra}</p>`) },
  ]);
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

interface World {
  /** Release bytes by tag, as GitHub serves them, oldest first. */
  releases: Map<string, Uint8Array>;
  /** Approved versions in the index: version, tag, digest. */
  approved: { version: string; tag: string; sha256: string }[];
  calls: string[];
}

function world(): World {
  return { releases: new Map(), approved: [], calls: [] };
}

function release(state: World, version: string, options: { approve: boolean; hosts?: readonly string[] }): Uint8Array {
  const bytes = appZip(version, '', options.hosts ?? []);
  state.releases.set(`v${version}`, bytes);
  if (options.approve) {
    state.approved.push({ version, tag: `v${version}`, sha256: sha256(bytes) });
  }
  return bytes;
}

function fetcher(state: World) {
  return async (url: string): Promise<Response> => {
    state.calls.push(url);
    if (url === INDEX_URL) {
      return Response.json({
        version: 1,
        apps: [
          {
            id: 'heat-map',
            name: 'Heat map',
            description: 'Clicks over the canvas.',
            author: 'octocat',
            icon: 'https://stacki.build/api/marketplace/icons/heat-map.png',
            categories: ['analytics'],
            source: { owner: 'octocat', repository: 'heat-map', asset: 'heat-map.zip' },
            versions: state.approved,
          },
        ],
      });
    }
    const prefix = 'https://api.github.com/repos/octocat/heat-map/releases/';
    if (url.startsWith(prefix)) {
      const which = url.slice(prefix.length);
      if (which.startsWith('assets/')) {
        const bytes = state.releases.get(decodeURIComponent(which.slice('assets/'.length)));
        return bytes === undefined ? new Response('', { status: 404 }) : new Response(new Uint8Array(bytes));
      }
      // The newest release is the last one added; replacing a release's bytes keeps its place.
      const tag = which === 'latest' ? ([...state.releases.keys()].at(-1) ?? '') : decodeURIComponent(which.slice('tags/'.length));
      const bytes = state.releases.get(tag);
      if (bytes === undefined) {
        return new Response('', { status: 404 });
      }
      return Response.json({ tag_name: tag, assets: [{ name: 'heat-map.zip', size: bytes.byteLength, url: `${prefix}assets/${tag}` }] });
    }
    return new Response('', { status: 404 });
  };
}

function service(state: World) {
  return createAppService({
    stackiVersion: STACKI_VERSION,
    fetch: fetcher(state),
    now: () => Date.parse('2026-11-10T00:00:00Z'),
    marketplaceIndexURL: INDEX_URL,
  });
}

test('a marketplace install writes the approved bytes and records its source; a mismatched digest installs nothing', async () => {
  const root = project();
  const state = world();
  const bytes = release(state, '1.0.0', { approve: true });
  const apps = service(state);

  const browsed = await apps.marketplace('cached');
  assert.ok(browsed.ok, browsed.ok ? '' : browsed.message);
  assert.equal(browsed.value.apps[0]?.id, 'heat-map');

  // The release was swapped after review: same tag, other bytes.
  state.releases.set('v1.0.0', appZip('1.0.0', ' swapped'));
  const refused = await apps.installMarketplace(root, 'heat-map', '1.0.0');
  assert.match(refused.ok ? '' : refused.message, /does not match the SHA-256 the marketplace approved; nothing was installed/);
  assert.equal(fs.existsSync(path.join(root, '.stacki/apps')), false);

  state.releases.set('v1.0.0', bytes);
  const unapproved = await apps.installMarketplace(root, 'heat-map', '9.0.0');
  assert.match(unapproved.ok ? '' : unapproved.message, /not an approved version/);

  const installed = await apps.installMarketplace(root, 'heat-map', '1.0.0');
  assert.ok(installed.ok, installed.ok ? '' : installed.message);
  const entry = readAppsLock(root).apps[0];
  assert.deepEqual(entry?.source, { kind: 'marketplace', id: 'heat-map', version: '1.0.0' });
  assert.equal(entry?.sha256, sha256(bytes));
  assert.equal(entry?.autoUpdate, false, 'auto-update starts off');
  assert.ok(state.calls.every((url) => !url.includes('token')));

  const again = await apps.installMarketplace(root, 'heat-map', '1.0.0');
  assert.match(again.ok ? '' : again.message, /already installed/);
});

test('a marketplace install never replaces an app of the same id from elsewhere', async () => {
  const root = project();
  const state = world();
  release(state, '1.0.0', { approve: true });
  const apps = service(state);
  const staged = apps.stageFile(root, appZip('0.9.0'), 'heat-map.zip');
  assert.ok(staged.ok);
  assert.ok(apps.commit(root, staged.value.token).ok);
  const refused = await apps.installMarketplace(root, 'heat-map', '1.0.0');
  assert.match(refused.ok ? '' : refused.message, /already installed from elsewhere/);
  assert.equal(readAppsLock(root).apps[0]?.version, '0.9.0');
});

test('auto-update off: a check records the approved update and installs nothing', async () => {
  const root = project();
  const state = world();
  release(state, '1.0.0', { approve: true });
  const apps = service(state);
  assert.ok((await apps.installMarketplace(root, 'heat-map', '1.0.0')).ok);
  const second = release(state, '1.1.0', { approve: true });
  const checked = await apps.checkUpdates(root, true);
  assert.deepEqual(checked.ok ? checked.value : checked.message, [{ kind: 'available', id: 'heat-map', version: '1.1.0' }]);
  const entry = readAppsLock(root).apps[0];
  assert.equal(entry?.version, '1.0.0', 'nothing new was installed');
  assert.deepEqual(entry?.update, { version: '1.1.0', tag: 'v1.1.0', sha256: sha256(second), additions: [] });
  assert.equal(fs.readFileSync(path.join(root, '.stacki/apps/heat-map/index.html'), 'utf8'), '<p>v1.0.0</p>');

  // Update installs it, a person's choice.
  const updated = await apps.applyUpdate(root, 'heat-map');
  assert.ok(updated.ok, updated.ok ? '' : updated.message);
  assert.deepEqual(readAppsLock(root).apps[0]?.source, { kind: 'marketplace', id: 'heat-map', version: '1.1.0' });
});

test('a withdrawn approval stops a waiting update', async () => {
  const root = project();
  const state = world();
  release(state, '1.0.0', { approve: true });
  const apps = service(state);
  assert.ok((await apps.installMarketplace(root, 'heat-map', '1.0.0')).ok);
  release(state, '1.1.0', { approve: true });
  assert.ok((await apps.checkUpdates(root, true)).ok);
  state.approved = state.approved.filter((entry) => entry.version !== '1.1.0');
  const refused = await apps.applyUpdate(root, 'heat-map');
  assert.match(refused.ok ? '' : refused.message, /no longer approves this version/);
  assert.equal(readAppsLock(root).apps[0]?.version, '1.0.0');
});

test('auto-update on: a marketplace app installs only approved versions', async () => {
  const root = project();
  const state = world();
  release(state, '1.0.0', { approve: true });
  const apps = service(state);
  assert.ok((await apps.installMarketplace(root, 'heat-map', '1.0.0')).ok);
  const switched = apps.setAutoUpdate(root, 'heat-map', { autoUpdate: true });
  assert.ok(switched.ok, switched.ok ? '' : switched.message);

  // A newer release that the owner has not approved is never installed.
  release(state, '2.0.0', { approve: false });
  const unapproved = await apps.checkUpdates(root, true);
  assert.deepEqual(unapproved.ok ? unapproved.value : unapproved.message, [{ kind: 'current', id: 'heat-map' }]);
  assert.equal(readAppsLock(root).apps[0]?.version, '1.0.0');

  // Once approved, the check installs it, with its approved digest.
  const approved = state.releases.get('v2.0.0');
  assert.ok(approved);
  state.approved.push({ version: '2.0.0', tag: 'v2.0.0', sha256: sha256(approved) });
  const installed = await apps.checkUpdates(root, true);
  assert.deepEqual(installed.ok ? installed.value : installed.message, [{ kind: 'updated', id: 'heat-map', version: '2.0.0' }]);
  const entry = readAppsLock(root).apps[0];
  assert.equal(entry?.version, '2.0.0');
  assert.equal(entry?.sha256, sha256(approved));
  assert.equal(entry?.autoUpdate, true, 'the switch survives the update');

  // An approved digest the release no longer matches installs nothing.
  const third = release(state, '3.0.0', { approve: true });
  state.releases.set('v3.0.0', appZip('3.0.0', ' swapped'));
  const mismatch = await apps.checkUpdates(root, true);
  assert.equal(mismatch.ok ? mismatch.value[0]?.kind : mismatch.message, 'failed');
  assert.equal(readAppsLock(root).apps[0]?.version, '2.0.0');
  assert.notEqual(sha256(third), readAppsLock(root).apps[0]?.sha256);
});

test('GitHub apps: auto-update off records the release; on installs the release it checked', async () => {
  const root = project();
  const state = world();
  release(state, '1.0.0', { approve: false });
  const apps = service(state);
  const source = { kind: 'github' as const, owner: 'octocat', repository: 'heat-map', asset: 'heat-map.zip' };
  const staged = await apps.stageGitHub(root, source, undefined);
  assert.ok(staged.ok, staged.ok ? '' : staged.message);
  assert.ok(apps.commit(root, staged.value.token).ok);
  assert.equal(readAppsLock(root).apps[0]?.autoUpdate, false);

  release(state, '1.1.0', { approve: false });
  const recorded = await apps.checkUpdates(root, true);
  assert.deepEqual(recorded.ok ? recorded.value : recorded.message, [{ kind: 'available', id: 'heat-map', version: '1.1.0' }]);
  assert.equal(readAppsLock(root).apps[0]?.version, '1.0.0', 'off installs nothing');
  assert.ok(!state.calls.includes(INDEX_URL), 'a GitHub app never reads the marketplace');

  assert.ok(apps.setAutoUpdate(root, 'heat-map', { autoUpdate: true }).ok);
  const third = release(state, '1.2.0', { approve: false });
  const updated = await apps.checkUpdates(root, true);
  assert.deepEqual(updated.ok ? updated.value : updated.message, [{ kind: 'updated', id: 'heat-map', version: '1.2.0' }]);
  const entry = readAppsLock(root).apps[0];
  assert.equal(entry?.version, '1.2.0');
  assert.equal(entry?.sha256, sha256(third), 'the digest recorded is the one checked');
  assert.equal(entry?.update, undefined);
});

test('auto-update on: a marketplace version that asks for a new host waits for a person’s OK; nothing else is held', async () => {
  const root = project();
  const state = world();
  release(state, '1.0.0', { approve: true, hosts: ['tiles.example.com'] });
  const apps = service(state);
  assert.ok((await apps.installMarketplace(root, 'heat-map', '1.0.0')).ok);
  assert.ok(apps.setAutoUpdate(root, 'heat-map', { autoUpdate: true }).ok);

  // Keeping its host and dropping none installs by itself; this is the ordinary auto-update.
  release(state, '1.1.0', { approve: true, hosts: ['tiles.example.com'] });
  const quiet = await apps.checkUpdates(root, true);
  assert.deepEqual(quiet.ok ? quiet.value : quiet.message, [{ kind: 'updated', id: 'heat-map', version: '1.1.0' }]);

  // A new host: held. The installed version stays, the lock records what is new, the outcome says it needs OK.
  const held = release(state, '1.2.0', { approve: true, hosts: ['tiles.example.com', 'api.example.com'] });
  const checked = await apps.checkUpdates(root, true);
  assert.deepEqual(checked.ok ? checked.value : checked.message, [
    { kind: 'needs-approval', id: 'heat-map', version: '1.2.0', additions: ['reaches api.example.com'] },
  ]);
  let entry = readAppsLock(root).apps[0];
  assert.equal(entry?.version, '1.1.0', 'auto-update did not install it');
  assert.deepEqual(entry?.update, { version: '1.2.0', tag: 'v1.2.0', sha256: sha256(held), additions: ['reaches api.example.com'] });
  assert.equal(entry?.autoUpdate, true);

  // A later check keeps it held without downloading the bundle again.
  const before = state.calls.length;
  const again = await apps.checkUpdates(root, true);
  assert.equal(again.ok ? again.value[0]?.kind : again.message, 'needs-approval');
  assert.ok(!state.calls.slice(before).some((url) => url.includes('/assets/')), 'the held bundle is not downloaded again');
  assert.equal(readAppsLock(root).apps[0]?.version, '1.1.0');

  // A person's Update installs it and clears the hold; the switch survives.
  const updated = await apps.applyUpdate(root, 'heat-map');
  assert.ok(updated.ok, updated.ok ? '' : updated.message);
  entry = readAppsLock(root).apps[0];
  assert.equal(entry?.version, '1.2.0');
  assert.equal(entry?.update, undefined);
  assert.equal(entry?.autoUpdate, true);
});

test('auto-update off records what a version adds; switching it on later installs a version that adds nothing', async () => {
  const root = project();
  const state = world();
  release(state, '1.0.0', { approve: true });
  const apps = service(state);
  assert.ok((await apps.installMarketplace(root, 'heat-map', '1.0.0')).ok);
  release(state, '1.1.0', { approve: true, hosts: ['api.example.com'] });
  const off = await apps.checkUpdates(root, true);
  assert.deepEqual(off.ok ? off.value : off.message, [{ kind: 'available', id: 'heat-map', version: '1.1.0' }], 'off: simply available');
  assert.deepEqual(readAppsLock(root).apps[0]?.update?.additions, ['reaches api.example.com'], 'but the lock says what it adds');

  // Turning the switch on does not wave an update that adds a host through.
  assert.ok(apps.setAutoUpdate(root, 'heat-map', { autoUpdate: true }).ok);
  const held = await apps.checkUpdates(root, true);
  assert.equal(held.ok ? held.value[0]?.kind : held.message, 'needs-approval');
  assert.equal(readAppsLock(root).apps[0]?.version, '1.0.0');

  // An update recorded with nothing new, then the switch on: the next check installs it.
  assert.ok((await apps.applyUpdate(root, 'heat-map')).ok);
  assert.ok(apps.setAutoUpdate(root, 'heat-map', { autoUpdate: false }).ok);
  release(state, '1.2.0', { approve: true, hosts: ['api.example.com'] });
  assert.equal((await apps.checkUpdates(root, true)).ok, true);
  assert.equal(readAppsLock(root).apps[0]?.update?.version, '1.2.0');
  assert.deepEqual(readAppsLock(root).apps[0]?.update?.additions, []);
  assert.ok(apps.setAutoUpdate(root, 'heat-map', { autoUpdate: true }).ok);
  const installed = await apps.checkUpdates(root, true);
  assert.deepEqual(installed.ok ? installed.value : installed.message, [{ kind: 'updated', id: 'heat-map', version: '1.2.0' }]);
});

test('GitHub apps: auto-update on holds a release that adds a host, and installs one that does not', async () => {
  const root = project();
  const state = world();
  release(state, '1.0.0', { approve: false });
  const apps = service(state);
  const source = { kind: 'github' as const, owner: 'octocat', repository: 'heat-map', asset: 'heat-map.zip' };
  const staged = await apps.stageGitHub(root, source, undefined);
  assert.ok(staged.ok, staged.ok ? '' : staged.message);
  assert.ok(apps.commit(root, staged.value.token).ok);
  assert.ok(apps.setAutoUpdate(root, 'heat-map', { autoUpdate: true }).ok);

  release(state, '1.1.0', { approve: false, hosts: ['api.example.com'] });
  const held = await apps.checkUpdates(root, true);
  assert.deepEqual(held.ok ? held.value : held.message, [{ kind: 'needs-approval', id: 'heat-map', version: '1.1.0', additions: ['reaches api.example.com'] }]);
  assert.equal(readAppsLock(root).apps[0]?.version, '1.0.0');
  assert.equal(fs.readFileSync(path.join(root, '.stacki/apps/heat-map/index.html'), 'utf8'), '<p>v1.0.0</p>');

  const updated = await apps.applyUpdate(root, 'heat-map');
  assert.ok(updated.ok, updated.ok ? '' : updated.message);
  assert.equal(readAppsLock(root).apps[0]?.version, '1.1.0');

  release(state, '1.2.0', { approve: false, hosts: ['api.example.com'] });
  const installed = await apps.checkUpdates(root, true);
  assert.deepEqual(installed.ok ? installed.value : installed.message, [{ kind: 'updated', id: 'heat-map', version: '1.2.0' }]);
});

test('auto-update has no meaning for an uploaded app, and a reinstall keeps it only from the same kind of source', () => {
  const root = project();
  const apps = service(world());
  const staged = apps.stageFile(root, appZip('1.0.0'), 'heat-map.zip');
  assert.ok(staged.ok);
  assert.ok(apps.commit(root, staged.value.token).ok);
  const refused = apps.setAutoUpdate(root, 'heat-map', { autoUpdate: true });
  assert.match(refused.ok ? '' : refused.message, /uploaded app has no updates/);
  assert.equal(readAppsLock(root).apps[0]?.autoUpdate, false);

  const github = { kind: 'github' as const, owner: 'o', repository: 'r', asset: 'a.zip', tag: 'v1' };
  const previous = {
    id: 'x',
    version: '1.0.0',
    sha256: 'a'.repeat(64),
    installedAt: '2026-11-01T00:00:00Z',
    source: github,
    update: undefined,
    autoUpdate: true,
  };
  assert.equal(carriedAutoUpdate(undefined, github), false);
  assert.equal(carriedAutoUpdate(previous, github), true);
  assert.equal(carriedAutoUpdate(previous, { kind: 'marketplace', id: 'x', version: '1.0.0' }), false);
  assert.equal(carriedAutoUpdate(previous, { kind: 'file', fileName: 'x.zip' }), false);
  assert.equal(carriedAutoUpdate({ ...previous, autoUpdate: false }, github), false);
});

test('the index is read from stacki.build; a refusal or a bad reply fails with a short reason', async () => {
  assert.equal(MARKETPLACE_INDEX_URL, 'https://stacki.build/api/marketplace/index.json');
  const asked: string[] = [];
  const answering = (response: () => Response) => async (url: string) => {
    asked.push(url);
    return response();
  };
  await assert.rejects(
    fetchMarketplaceIndex(
      answering(() => new Response('Not found', { status: 404 })),
      MARKETPLACE_INDEX_URL,
    ),
    { message: 'The marketplace index answered HTTP 404.' },
  );
  assert.deepEqual(asked, [MARKETPLACE_INDEX_URL]);
  await assert.rejects(
    fetchMarketplaceIndex(
      answering(() => new Response('<html>', { status: 200 })),
      MARKETPLACE_INDEX_URL,
    ),
    /not JSON/,
  );
  await assert.rejects(
    fetchMarketplaceIndex(
      answering(() => new Response(JSON.stringify({ version: 2, apps: [] }), { status: 200 })),
      MARKETPLACE_INDEX_URL,
    ),
    /version must be 1/,
  );
  const empty = await fetchMarketplaceIndex(
    answering(() => new Response(JSON.stringify({ version: 1, apps: [] }), { status: 200 })),
    MARKETPLACE_INDEX_URL,
  );
  assert.deepEqual(empty, { version: 1, apps: [] });
});

test('only a development build reads another index, and only over HTTPS or local HTTP', () => {
  const variable = MARKETPLACE_INDEX_URL_VARIABLE;
  assert.equal(marketplaceIndexURL({}, 'development'), MARKETPLACE_INDEX_URL);
  assert.equal(marketplaceIndexURL({ [variable]: 'https://example.test/apps.json' }, 'release'), MARKETPLACE_INDEX_URL);
  assert.equal(marketplaceIndexURL({ [variable]: 'https://example.test/apps.json' }, 'development'), 'https://example.test/apps.json');
  assert.equal(marketplaceIndexURL({ [variable]: 'http://localhost:4000/apps.json' }, 'development'), 'http://localhost:4000/apps.json');
  assert.throws(() => marketplaceIndexURL({ [variable]: 'http://example.test/apps.json' }, 'development'), /https: address/);
});

test('main gates the marketplace channels by their role features, and auto-update by admin', () => {
  assert.deepEqual(CHANNEL_ACCESS['apps:marketplace'], ['marketplace:view']);
  assert.deepEqual(CHANNEL_ACCESS['apps:installMarketplace'], ['marketplace:install']);
  assert.deepEqual(CHANNEL_ACCESS['apps:setAutoUpdate'], ['settings:roles']);
  assert.deepEqual(CHANNEL_ACCESS['apps:applyUpdate'], ['settings:roles']);
  // The check itself only records updates, or installs one an admin switched on: anyone's editor may run it.
  assert.equal(CHANNEL_ACCESS['apps:checkUpdates'], undefined);
});
