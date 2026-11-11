// Goal: one bad app never hides the others. Every failure to read one app (its
// manifest, a cross-field check such as an auth provider naming a setting the
// manifest does not declare, its lockfile entry) is a broken row for that app
// alone, with the reason, on the host (Desktop's main process and Studio's
// server share electron/project/appStore.ts) and again in the editor, which
// re-parses each summary off the wire. A manifest parsed once parses again to
// the same value, so the editor's re-check never refuses what the host accepted:
// the bug this pins is a Stacki connection (`provider: "hubspot"`) whose parsed
// form says `connection`, which the editor read as a custom provider with no
// client id and failed the whole Installed list.
// Method: temporary projects on a real disk; the host's list and broken folders
// cross a structured clone (Electron IPC) and JSON (Studio HTTP) and are read by
// the editor's parsers, as the Apps panel reads them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createAppService } from '#dist/electron/project/appService.js';
import { listInstalledFolders } from '#dist/electron/project/appStore.js';
import { parseAppManifest, parseAppManifestSource, readAppsLockEntries } from '#dist/shared/properties/apps.js';
import { joinBrokenRows, parseAppFoldersBroken, parseInstalledAppList } from '#dist/shared/properties/appFolders.js';
// The running Stacki these tests stand in for: new enough for every fixture bundle.
const STACKI_VERSION = '1.1.0';

const service = createAppService({
  stackiVersion: STACKI_VERSION,
  fetch: () => Promise.reject(new Error('offline')),
  now: () => Date.parse('2026-11-10T12:00:00Z'),
});

function project(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-app-list-')));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  return root;
}

function manifest(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { manifestVersion: 1, id, name: `App ${id}`, version: '1.0.0', entry: 'index.html', ...extra };
}

function writeFolder(root: string, fields: Record<string, unknown>): void {
  const directory = path.join(root, '.stacki/apps', String(fields['id']));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'stacki-app.json'), JSON.stringify(fields));
  fs.writeFileSync(path.join(directory, 'index.html'), '<p>app</p>');
}

// A custom provider whose client id names a setting the manifest does not declare.
const BAD_AUTH = {
  auth: [
    { id: 'crm', label: 'CRM', authorizeURL: 'https://crm.example/auth', tokenURL: 'https://crm.example/token', pkce: true, clientIdSetting: 'client-id' },
  ],
};
// A Stacki connection, which the old editor could not read back off the wire.
const CONNECTION = { auth: [{ provider: 'hubspot', scopes: ['oauth', 'forms'] }], window: { mode: 'panel', width: 380, height: 640 } };

// What the Apps panel shows: the editor's reading of the host's list, joined with the host's broken folders.
function panelRows(list: unknown, folders: unknown): { readonly good: readonly string[]; readonly broken: readonly { folder: string; message: string }[] } {
  const reading = parseInstalledAppList(list);
  return { good: reading.apps.map((app) => app.manifest.id), broken: joinBrokenRows(parseAppFoldersBroken(folders), reading.broken) };
}

test('three apps, one with an invalid auth/settings link: two good rows and one broken row, over IPC and HTTP', () => {
  const root = project();
  writeFolder(root, manifest('analytics'));
  writeFolder(root, manifest('crm', BAD_AUTH));
  writeFolder(root, manifest('hubspot', CONNECTION));
  const list = service.list(root);
  const folders = service.folders(root);
  assert.ok(list.ok);
  assert.ok(folders.ok);
  for (const wire of [structuredClone, (value: unknown): unknown => JSON.parse(JSON.stringify(value))]) {
    const rows = panelRows(wire(list.value), wire(folders.value));
    assert.deepEqual(rows.good, ['analytics', 'hubspot']);
    assert.equal(rows.broken.length, 1);
    assert.equal(rows.broken[0]?.folder, 'crm');
    assert.match(rows.broken[0]?.message ?? '', /Auth provider crm: clientIdSetting names a text or secret setting the manifest declares/);
  }
});

test('an app the host accepted and the editor refuses is a broken row under its id; only a malformed list fails whole', () => {
  const root = project();
  for (const id of ['alpha', 'beta', 'gamma']) {
    writeFolder(root, manifest(id));
  }
  const list = service.list(root);
  assert.ok(list.ok);
  // A host from another build: its summary of beta carries a check this editor makes and that host did not.
  const wire = structuredClone(list.value).map((summary) =>
    summary.manifest.id === 'beta' ? { ...summary, manifest: { ...summary.manifest, ...BAD_AUTH, auth: [{ ...BAD_AUTH.auth[0], id: 'beta' }] } } : summary,
  );
  const reading = parseInstalledAppList(wire);
  assert.deepEqual(
    reading.apps.map((app) => app.manifest.id),
    ['alpha', 'gamma'],
  );
  assert.deepEqual(
    reading.broken.map((row) => row.folder),
    ['beta'],
  );
  // A summary with no readable id still gets a row, named by its place.
  assert.deepEqual(
    parseInstalledAppList([...wire, { manifest: {} }]).broken.map((row) => row.folder),
    ['beta', 'app-4'],
  );
  assert.throws(() => parseInstalledAppList({ apps: [] }), /Expected a list of apps/);
});

test('a parsed manifest parses again to itself: connections, custom providers, window size, author', () => {
  const sources = [
    manifest('hubspot', CONNECTION),
    manifest('ga', {
      auth: [{ provider: 'google', scopes: ['openid'], clientIdSetting: 'client-id' }],
      settings: [{ id: 'client-id', label: 'Client ID', kind: 'text' }],
    }),
    manifest('crm', { ...BAD_AUTH, settings: [{ id: 'client-id', label: 'Client ID', kind: 'secret' }] }),
    manifest('authored', { author: { github: 'octocat' }, window: { mode: 'popup', width: 400, height: 300 } }),
  ];
  for (const source of sources) {
    const once = parseAppManifestSource(JSON.stringify(source));
    assert.deepEqual(parseAppManifest(structuredClone(once)), once, `${String(source['id'])} over IPC`);
    // JSON drops undefined fields, so the HTTP reading is compared as JSON again.
    const overHTTP = parseAppManifest(JSON.parse(JSON.stringify(once)));
    assert.equal(JSON.stringify(overHTTP), JSON.stringify(once), `${String(source['id'])} over HTTP`);
  }
  // The parsed form is no way around the registry: a connection's endpoints are Stacki's own.
  const forged = { ...parseAppManifestSource(JSON.stringify(sources[0])) };
  const auth = forged.auth[0];
  assert.ok(auth !== undefined);
  assert.throws(() => parseAppManifest({ ...forged, auth: [{ ...auth, tokenURL: 'https://evil.example/token' }] }), /takes its endpoints from Stacki/);
  assert.throws(() => parseAppManifest({ ...forged, auth: [{ ...auth, provider: 'google' }] }), /provider and connection differ/);
});

test('a bad lockfile entry breaks its own app; an unreadable lockfile is one row and the apps still list', () => {
  const root = project();
  for (const id of ['alpha', 'beta', 'gamma']) {
    writeFolder(root, manifest(id));
  }
  const entry = (id: string) => ({
    id,
    version: '1.0.0',
    sha256: 'a'.repeat(64),
    installedAt: '2026-11-01T00:00:00.000Z',
    source: { kind: 'file', fileName: `${id}.zip` },
  });
  const lockFile = path.join(root, '.stacki/apps/apps.json');
  fs.writeFileSync(lockFile, JSON.stringify({ version: 1, apps: [entry('alpha'), { ...entry('beta'), sha256: 'nope' }, entry('gamma')] }));
  const listed = listInstalledFolders(root);
  assert.deepEqual(
    listed.apps.map((app) => [app.manifest.id, app.lock.source.kind]),
    [
      ['alpha', 'file'],
      ['gamma', 'file'],
    ],
  );
  assert.deepEqual(
    listed.broken.map((row) => row.folder),
    ['beta'],
  );
  assert.match(listed.broken[0]?.message ?? '', /Its entry in \.stacki\/apps\/apps\.json is invalid/);

  // Listed twice: that app is broken, not the list.
  assert.deepEqual(
    [...readAppsLockEntries(JSON.stringify({ version: 1, apps: [entry('alpha'), entry('alpha'), entry('gamma')] })).entryFailures.keys()],
    ['alpha'],
  );

  fs.writeFileSync(lockFile, '{ not json');
  const unreadable = listInstalledFolders(root);
  assert.deepEqual(
    unreadable.apps.map((app) => [app.manifest.id, app.lock.source.kind]),
    [
      ['alpha', 'local'],
      ['beta', 'local'],
      ['gamma', 'local'],
    ],
  );
  assert.deepEqual(
    unreadable.broken.map((row) => row.folder),
    ['apps.json'],
  );
  assert.match(unreadable.broken[0]?.message ?? '', /apps\.json cannot be read/);
  // The row crosses the wire like any other broken folder.
  assert.equal(parseAppFoldersBroken(JSON.parse(JSON.stringify(unreadable.broken))).length, 1);
});
