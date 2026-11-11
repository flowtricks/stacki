// Goal: the folder is the source of truth for installed apps (docs/apps.md, "Apps
// added as a folder"). A folder in `.stacki/apps/<id>/` with a valid bundle is an
// installed app at once: with the lockfile's record when the lockfile names it,
// as source `local` (with its digest, never auto-updated) when it does not, and
// served to its frame either way; listing never writes the lockfile. A lockfile
// entry whose folder is gone is not listed and is dropped on the next lockfile
// write. A folder whose id does not match, or whose manifest or bundle is
// invalid, is a broken row with the reason, never hidden and never served;
// dotfiles, the lockfile, the settings file and the app data folder are not
// apps. A folder app edited in place shows its new version and digest. The
// watcher's listener waits out a burst of events and sends one notice naming
// the folders that moved.
// Method: temporary projects on a real disk, written file by file as a person or
// an agent would; the merge is also driven directly over hand-made readings; the
// watcher's listener runs on a fake clock and a fake stamp reader.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeStoredZip } from '#dist/shared/properties/appBundle.js';
import { createAppService } from '#dist/electron/project/appService.js';
import { listInstalledFolders, readAppsLock } from '#dist/electron/project/appStore.js';
import { mergeInstalledApps, readAppFolderStamps } from '#dist/electron/project/appScan.js';
import { createAppFoldersListener } from '#dist/electron/project/appsWatcher.js';
import { serveAppRequest } from '#dist/electron/handlers/appsHandlers.js';
import { parseAppManifest, type AppInstallSource } from '#dist/shared/properties/apps.js';
import { changedAppFolders, parseAppFoldersBroken, parseAppFolderName } from '#dist/shared/properties/appFolders.js';
// The running Stacki these tests stand in for: new enough for every fixture bundle.
const STACKI_VERSION = '1.1.0';

const encoder = new TextEncoder();
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16"/></svg>';

function project(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-app-scan-')));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  return root;
}

function manifest(id: string, version = '1.0.0'): Record<string, unknown> {
  return { manifestVersion: 1, id, name: `App ${id}`, version, entry: 'index.html', icon: 'icon.svg' };
}

// An app folder as an agent writes it: the manifest, the entry and the icon.
function writeFolder(root: string, folder: string, fields: Record<string, unknown>, html = '<p>hello</p>'): void {
  const directory = path.join(root, '.stacki/apps', folder);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'stacki-app.json'), JSON.stringify(fields));
  fs.writeFileSync(path.join(directory, 'index.html'), html);
  fs.writeFileSync(path.join(directory, 'icon.svg'), ICON);
}

function zip(id: string, version: string): Uint8Array {
  const files = { 'stacki-app.json': JSON.stringify(manifest(id, version)), 'index.html': `<p>${version}</p>`, 'icon.svg': ICON };
  return writeStoredZip(Object.entries(files).map(([filePath, text]) => ({ path: filePath, bytes: encoder.encode(text) })));
}

const service = createAppService({
  stackiVersion: STACKI_VERSION,
  fetch: () => Promise.reject(new Error('offline')),
  now: () => Date.parse('2026-11-10T12:00:00Z'),
});

function install(root: string, id: string): void {
  const staged = service.stageFile(root, zip(id, '1.0.0'), `${id}.zip`);
  assert.ok(staged.ok, staged.ok ? '' : staged.message);
  const committed = service.commit(root, staged.value.token);
  assert.ok(committed.ok, committed.ok ? '' : committed.message);
}

test('a folder alone is installed at once as a local app; an installed folder keeps its lock record', () => {
  const root = project();
  install(root, 'installed');
  writeFolder(root, 'dropped', manifest('dropped'));
  const listed = listInstalledFolders(root);
  assert.deepEqual(
    listed.apps.map((app) => [app.manifest.id, app.lock.source.kind]),
    [
      ['dropped', 'local'],
      ['installed', 'file'],
    ],
  );
  const dropped = listed.apps[0];
  assert.match(dropped?.lock.sha256 ?? '', /^[0-9a-f]{64}$/);
  assert.equal(dropped?.lock.autoUpdate, false);
  assert.equal(dropped?.lock.version, '1.0.0');
  assert.deepEqual(listed.broken, []);
  // It opens at once: the file route serves it, the SDK included.
  assert.equal(serveAppRequest('stacki-app://dropped/index.html', root).status, 200);
  assert.equal(serveAppRequest('stacki-app://dropped/stacki-sdk.js', root).status, 200);
  // Listing never writes: the lockfile names only the installed app.
  assert.deepEqual(
    readAppsLock(root).apps.map((entry) => entry.id),
    ['installed'],
  );
  // Removing a folder app removes its folder.
  const removed = service.uninstall(root, 'dropped');
  assert.ok(removed.ok, removed.ok ? '' : removed.message);
  assert.equal(fs.existsSync(path.join(root, '.stacki/apps/dropped')), false);
});

test('a lockfile entry whose folder is gone is not listed and is dropped on the next write', () => {
  const root = project();
  install(root, 'kept');
  install(root, 'gone');
  fs.rmSync(path.join(root, '.stacki/apps/gone'), { recursive: true });
  assert.deepEqual(
    listInstalledFolders(root).apps.map((app) => app.manifest.id),
    ['kept'],
  );
  assert.equal(readAppsLock(root).apps.length, 2, 'Listing does not write');
  // Any lock write prunes: installing another app is one.
  install(root, 'fresh');
  assert.deepEqual(
    readAppsLock(root)
      .apps.map((entry) => entry.id)
      .sort(),
    ['fresh', 'kept'],
  );
});

test('an id that does not match its folder, and an invalid manifest or bundle, are broken rows with the reason', () => {
  const root = project();
  writeFolder(root, 'named-wrong', manifest('other-id'));
  writeFolder(root, 'bad-json', manifest('bad-json'));
  fs.writeFileSync(path.join(root, '.stacki/apps/bad-json/stacki-app.json'), '{ not json');
  writeFolder(root, 'no-entry', { ...manifest('no-entry'), entry: 'missing.html' });
  writeFolder(root, 'empty-folder', manifest('empty-folder'));
  fs.rmSync(path.join(root, '.stacki/apps/empty-folder/stacki-app.json'));
  writeFolder(root, 'bad-file', manifest('bad-file'));
  fs.writeFileSync(path.join(root, '.stacki/apps/bad-file/tool.exe'), 'MZ');
  const listed = listInstalledFolders(root);
  assert.deepEqual(listed.apps, []);
  const rows = new Map(listed.broken.map((row) => [row.folder, row]));
  const reason = (folder: string): string => {
    const row = rows.get(folder);
    assert.ok(row !== undefined, `${folder} is broken`);
    return row.message;
  };
  assert.match(reason('named-wrong'), /named "named-wrong" but its stacki-app.json says "id": "other-id"/);
  assert.match(reason('bad-json'), /not JSON/);
  assert.match(reason('no-entry'), /entry file missing\.html is missing/);
  assert.match(reason('empty-folder'), /no stacki-app\.json/);
  assert.match(reason('bad-file'), /not a type an app may hold/);
  assert.equal(rows.size, 5);
  // Never served, and the rows cross the wire through their parser.
  assert.equal(serveAppRequest('stacki-app://bad-file/index.html', root).status, 404);
  assert.equal(parseAppFoldersBroken(JSON.parse(JSON.stringify(listed.broken))).length, 5);
});

test('dotfiles, the lockfile, the settings file and the app data folder are not apps', () => {
  const root = project();
  install(root, 'real');
  fs.writeFileSync(path.join(root, '.stacki/apps/settings.json'), '{}');
  fs.writeFileSync(path.join(root, '.stacki/apps/.DS_Store'), 'x');
  fs.mkdirSync(path.join(root, '.stacki/apps/.staging-0123'), { recursive: true });
  fs.mkdirSync(path.join(root, '.stacki/app-data'), { recursive: true });
  fs.writeFileSync(path.join(root, '.stacki/app-data/real.json'), '{}');
  // A hidden file inside an app's folder (Finder's) does not break it.
  fs.writeFileSync(path.join(root, '.stacki/apps/real/.DS_Store'), 'x');
  const listed = listInstalledFolders(root);
  assert.deepEqual(
    listed.apps.map((app) => app.manifest.id),
    ['real'],
  );
  assert.deepEqual(listed.broken, []);
});

test('a folder app edited in place shows its new version and digest, and keeps running', () => {
  const root = project();
  writeFolder(root, 'agent-app', manifest('agent-app'));
  const first = listInstalledFolders(root).apps[0];
  writeFolder(root, 'agent-app', manifest('agent-app', '1.1.0'), '<p>edited</p>');
  const again = listInstalledFolders(root).apps[0];
  assert.equal(again?.manifest.version, '1.1.0');
  assert.equal(again?.lock.version, '1.1.0');
  assert.notEqual(again?.lock.sha256, first?.lock.sha256);
  assert.equal(serveAppRequest('stacki-app://agent-app/index.html', root).status, 200);
  // Broken by an edit: listed with the reason, no longer served.
  fs.writeFileSync(path.join(root, '.stacki/apps/agent-app/stacki-app.json'), '{');
  assert.equal(listInstalledFolders(root).broken[0]?.folder, 'agent-app');
  assert.equal(serveAppRequest('stacki-app://agent-app/index.html', root).status, 404);
});

test('an installed app edited in place keeps running, with its new manifest version', () => {
  const root = project();
  install(root, 'edited');
  writeFolder(root, 'edited', manifest('edited', '2.0.0'), '<p>by hand</p>');
  const listed = listInstalledFolders(root);
  assert.equal(listed.apps[0]?.manifest.version, '2.0.0');
  assert.equal(listed.apps[0]?.lock.source.kind, 'file');
});

test('the merge over hand-made readings: lockfile only, folder only, both, broken', () => {
  const read = (id: string, sha256: string) => ({
    kind: 'app' as const,
    folder: id,
    manifest: parseAppManifest(manifest(id)),
    sha256,
    addedAt: '2026-11-10T00:00:00.000Z',
  });
  const entry = (id: string, source: AppInstallSource, sha256: string) => ({
    id,
    version: '1.0.0',
    sha256,
    installedAt: '2026-11-01T00:00:00.000Z',
    source,
    update: undefined,
    autoUpdate: true,
  });
  const lock = {
    version: 1 as const,
    apps: [
      entry('lock-only', { kind: 'file', fileName: 'a.zip' }, 'a'.repeat(64)),
      entry('both', { kind: 'marketplace', id: 'both', version: '1.0.0' }, 'b'.repeat(64)),
    ],
  };
  const merged = mergeInstalledApps(lock, [
    read('both', '0'.repeat(64)),
    read('folder-only', '1'.repeat(64)),
    { kind: 'broken', folder: 'Broken Folder', message: 'stacki-app.json is not JSON' },
  ]);
  assert.deepEqual(
    merged.apps.map((app) => [app.manifest.id, app.lock.source.kind, app.lock.sha256.slice(0, 1), app.lock.autoUpdate]),
    [
      ['both', 'marketplace', 'b', true],
      ['folder-only', 'local', '1', false],
    ],
  );
  assert.equal(merged.apps[1]?.lock.installedAt, '2026-11-10T00:00:00.000Z');
  assert.deepEqual(merged.broken, [{ folder: 'Broken Folder', message: 'stacki-app.json is not JSON' }]);
});

test('folder names on the wire are one visible segment', () => {
  assert.equal(parseAppFolderName('My App'), 'My App');
  for (const bad of ['', '.hidden', '..', 'a/b', 'a\\b', 'x'.repeat(256), 3]) {
    assert.throws(() => parseAppFolderName(bad));
  }
});

test('stamps move with a folder’s files, and only that folder is named', () => {
  const root = project();
  writeFolder(root, 'one', manifest('one'));
  writeFolder(root, 'two', manifest('two'));
  const before = readAppFolderStamps(root);
  fs.writeFileSync(path.join(root, '.stacki/apps/two/index.html'), '<p>changed and longer</p>');
  const after = readAppFolderStamps(root);
  assert.deepEqual(changedAppFolders(before, after), { folders: ['two'], any: true });
  fs.writeFileSync(path.join(root, '.stacki/apps/apps.json'), '{"version":1,"apps":[]}\n');
  assert.deepEqual(changedAppFolders(after, readAppFolderStamps(root)), { folders: [], any: true });
  fs.rmSync(path.join(root, '.stacki/apps/one'), { recursive: true });
  assert.deepEqual(changedAppFolders(after, readAppFolderStamps(root)).folders, ['one']);
});

test('the watcher waits out a burst and sends one notice naming the folders that moved', () => {
  let stamps: { folders: Record<string, string>; files: string } = { folders: { one: 'aa' }, files: '00' };
  const timers: (() => void)[] = [];
  let cancelled = 0;
  const sent: unknown[] = [];
  const listener = createAppFoldersListener({
    projectPath: '/site',
    send: (_channel, payload) => sent.push(payload),
    readStamps: () => stamps,
    schedule: (_delayMs, run) => {
      timers.push(run);
      return () => {
        cancelled += 1;
      };
    },
  });
  // A burst: each event re-arms the one timer.
  listener.heard(path.join('apps', 'one', 'index.html'));
  listener.heard(path.join('apps', 'two', 'stacki-app.json'));
  listener.heard(undefined); // A coalesced event names no file and still counts.
  listener.heard('folders.json'); // Elsewhere in .stacki: ignored.
  listener.heard(path.join('preview', 'x.html'));
  assert.equal(timers.length, 3);
  assert.equal(cancelled, 2);
  stamps = { folders: { one: 'aa', two: 'bb' }, files: '00' };
  timers.at(-1)?.();
  assert.deepEqual(sent, [{ folders: ['two'] }]);
  // Nothing moved: no notice.
  listener.heard('apps');
  timers.at(-1)?.();
  assert.equal(sent.length, 1);
  listener.close();
  listener.heard('apps');
  assert.equal(timers.length, 4, 'A closed listener arms nothing');
});
