// Goal: app storage (shared/properties/appStorage.ts, electron/project/appStorageStore.ts)
// and the person (electron/project/appPerson.ts) keep their contracts:
// - keys, scopes, values and files parse at the boundary, and every bound
//   (value bytes, app bytes, key count, key length and depth) refuses past it;
// - writes are atomic (no temporary file is left, the file reads back whole) and
//   each one notices its writer at once;
// - the project folder's watcher hears an outside change (a pull) with no
//   writer, and not the store's own write;
// - the RPC's storage, badge and label parsers hold their bounds;
// - the person's id is stable per person and project, and hiding the details
//   leaves the id alone and nothing else.
// Method: a temporary project per test, the real store and fs.watch, and
// known-good values beside each known-bad one.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  APP_STORAGE_LIMITS,
  changedAppStorageKeys,
  nextAppStorageValues,
  parseAppStorageChange,
  parseAppStorageKey,
  parseAppStorageScope,
  parseAppStorageSource,
  parseAppStorageValue,
  serializeAppStorage,
} from '#dist/shared/properties/appStorage.js';
import type { AppStorageChange } from '#dist/shared/properties/appStorage.js';
import { APP_METHODS, APP_RPC_LIMITS, optionalUndoLabel, parseAppPerson } from '#dist/shared/properties/appsRpc.js';
import { createAppStorageStore, forgetAppStorage, localAppStorageDirectory } from '#dist/electron/project/appStorageStore.js';
import { appPerson, appPersonId, normalizeRemote } from '#dist/electron/project/appPerson.js';

function project(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-app-storage-'));
}

test('keys are path-like segments, bounded in length and depth', () => {
  for (const key of ['pins', 'pins/hero', 'a.b_c-d/1', 'x'.repeat(APP_STORAGE_LIMITS.keyCharsMax)]) {
    assert.equal(parseAppStorageKey(key), key);
  }
  const deep = Array.from({ length: APP_STORAGE_LIMITS.keySegmentsMax + 1 }, () => 'a').join('/');
  for (const bad of ['', '/pins', 'pins/', 'a//b', '../up', 'a/./b', '.hidden', 'has space', 'é', deep, 'x'.repeat(APP_STORAGE_LIMITS.keyCharsMax + 1), 7]) {
    assert.throws(() => parseAppStorageKey(bad), /storage key|Expected string/, String(bad));
  }
});

test('scopes default to project; values are bounded in UTF-8 bytes', () => {
  assert.equal(parseAppStorageScope(undefined), 'project');
  assert.equal(parseAppStorageScope('local'), 'local');
  assert.throws(() => parseAppStorageScope('global'), /scope must be one of project, local/);
  assert.equal(parseAppStorageValue('x'.repeat(APP_STORAGE_LIMITS.valueBytesMax)).length, APP_STORAGE_LIMITS.valueBytesMax);
  assert.throws(() => parseAppStorageValue('x'.repeat(APP_STORAGE_LIMITS.valueBytesMax + 1)), /at most 262144 bytes/);
  // Two bytes each: half as many characters reach the same byte bound.
  assert.throws(() => parseAppStorageValue('é'.repeat(APP_STORAGE_LIMITS.valueBytesMax / 2 + 1)), /at most 262144 bytes/);
});

test('a scope refuses a key past the key bound, and bytes past the app bound', () => {
  const full = new Map(Array.from({ length: APP_STORAGE_LIMITS.keysMax }, (_, index) => [`k${index}`, '']));
  const refused = nextAppStorageValues(full, 'one-more', 'x');
  assert.equal(refused.ok, false);
  assert.equal(nextAppStorageValues(full, 'k0', 'replaced').ok, true, 'replacing a key adds none');
  const big = 'x'.repeat(APP_STORAGE_LIMITS.valueBytesMax - 16);
  let values: ReadonlyMap<string, string> = new Map();
  let index = 0;
  for (; index < 64; index += 1) {
    const next = nextAppStorageValues(values, `v${index}`, big);
    if (!next.ok) {
      assert.match(next.reason, /bytes/);
      break;
    }
    values = next.values;
  }
  assert.ok(index < 64, 'the byte bound is reached before 64 large values');
  assert.equal(nextAppStorageValues(values, 'v0', undefined).ok, true, 'a removal always fits');
});

test('the file round-trips with sorted keys and refuses what it must not hold', () => {
  const values = new Map([
    ['b', '2'],
    ['a/x', '1'],
  ]);
  const source = serializeAppStorage(values);
  assert.ok(source.indexOf('"a/x"') < source.indexOf('"b"'), 'keys are sorted, one per line');
  assert.deepEqual([...parseAppStorageSource(source)], [...values].sort());
  assert.throws(() => parseAppStorageSource('{"version":2,"values":{}}'), /is version 1/);
  assert.throws(() => parseAppStorageSource('{"version":1,"values":{"../x":"1"}}'), /not a storage key/);
  assert.throws(() => parseAppStorageSource('{"version":1,"values":{"a":1}}'), /Expected string/);
  assert.deepEqual(
    changedAppStorageKeys(
      new Map([
        ['a', '1'],
        ['b', '1'],
      ]),
      new Map([
        ['a', '2'],
        ['c', '1'],
      ]),
    ),
    ['a', 'b', 'c'],
  );
});

test('a change notice parses at the boundary, and "many" is no keys', () => {
  assert.deepEqual(parseAppStorageChange({ appId: 'pins', scope: 'project', keys: ['a'], writer: 'desktop-1' }), {
    appId: 'pins',
    scope: 'project',
    keys: ['a'],
    writer: 'desktop-1',
  });
  assert.equal(parseAppStorageChange({ appId: 'pins', scope: 'local' }).keys, undefined);
  const tooMany = Array.from({ length: APP_STORAGE_LIMITS.changeKeysMax + 1 }, (_, index) => `k${index}`);
  assert.throws(() => parseAppStorageChange({ appId: 'pins', scope: 'project', keys: tooMany }), /at most 64 keys/);
  assert.throws(() => parseAppStorageChange({ appId: 'pins', scope: 'project', writer: 'has space' }), /storage writer/);
});

test('writes are atomic, read back, and notice their writer at once', () => {
  const root = project();
  const changes: AppStorageChange[] = [];
  const store = createAppStorageStore({ projectRoot: root, notify: (change) => changes.push(change) });
  const local = { scope: 'local' as const, directory: localAppStorageDirectory(path.join(root, 'user-data'), root, 'desktop') };
  assert.deepEqual(store.set('pins', { scope: 'project' }, 'pins/hero', '{"x":1}', 'w1'), { applied: true });
  assert.deepEqual(store.set('pins', local, 'draft', 'mine', 'w1'), { applied: true });
  const dataDirectory = path.join(root, '.stacki', 'app-data');
  assert.deepEqual(fs.readdirSync(dataDirectory), ['pins.json'], 'no temporary file is left beside the data');
  assert.equal(parseAppStorageSource(fs.readFileSync(path.join(dataDirectory, 'pins.json'), 'utf8')).get('pins/hero'), '{"x":1}');
  assert.equal(store.get('pins', { scope: 'project' }, 'pins/hero'), '{"x":1}');
  assert.equal(store.get('pins', { scope: 'project' }, 'draft'), undefined, 'scopes do not share keys');
  assert.equal(store.get('pins', local, 'draft'), 'mine');
  assert.ok(!fs.readFileSync(path.join(dataDirectory, 'pins.json'), 'utf8').includes('mine'), 'local values never land in the project');
  assert.deepEqual(changes, [
    { appId: 'pins', scope: 'project', keys: ['pins/hero'], writer: 'w1' },
    { appId: 'pins', scope: 'local', keys: ['draft'], writer: 'w1' },
  ]);
  assert.deepEqual(store.set('pins', { scope: 'project' }, 'pins/hero', '{"x":1}', 'w1'), { applied: true });
  assert.equal(changes.length, 2, 'writing the same value changes nothing and notices nothing');
  assert.deepEqual(store.set('pins', { scope: 'project' }, 'pins/hero', undefined, 'w1'), { applied: true });
  assert.deepEqual(store.keys('pins', { scope: 'project' }), []);
  forgetAppStorage(root, local.directory, 'pins');
  assert.equal(store.get('pins', local, 'draft'), undefined, 'an uninstalled app keeps nothing');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a file that does not parse fails the read and is left as it is', () => {
  const root = project();
  const file = path.join(root, '.stacki', 'app-data', 'pins.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '<<<<<<< ours\n');
  const store = createAppStorageStore({ projectRoot: root, notify: () => undefined });
  assert.throws(() => store.get('pins', { scope: 'project' }, 'a'), SyntaxError);
  assert.throws(() => store.set('pins', { scope: 'project' }, 'a', '1', 'w1'), SyntaxError);
  assert.equal(fs.readFileSync(file, 'utf8'), '<<<<<<< ours\n', 'a conflicted file is never overwritten');
  fs.rmSync(root, { recursive: true, force: true });
});

test('the watcher hears an outside change with no writer, and not the store’s own write', async () => {
  const root = project();
  const changes: AppStorageChange[] = [];
  const store = createAppStorageStore({ projectRoot: root, notify: (change) => changes.push(change) });
  const stop = store.watch();
  try {
    store.set('pins', { scope: 'project' }, 'a', '1', 'w1');
    await settle();
    assert.deepEqual(changes, [{ appId: 'pins', scope: 'project', keys: ['a'], writer: 'w1' }], 'the own write is noticed once, by the write');
    // A pull: another file arrives whole.
    const file = path.join(root, '.stacki', 'app-data', 'pins.json');
    fs.writeFileSync(
      file,
      serializeAppStorage(
        new Map([
          ['a', '1'],
          ['b', 'theirs'],
        ]),
      ),
    );
    await settle();
    assert.deepEqual(changes.at(-1), { appId: 'pins', scope: 'project', keys: ['b'], writer: undefined });
    fs.rmSync(file);
    await settle();
    assert.deepEqual(changes.at(-1), { appId: 'pins', scope: 'project', keys: ['a', 'b'], writer: undefined }, 'a removed file removes its keys');
  } finally {
    stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the RPC parses storage, badge and label params within their bounds', () => {
  assert.deepEqual(APP_METHODS['storage.set'].params({ key: 'a', value: 'v' }), { key: 'a', scope: 'project', value: 'v' });
  assert.throws(() => APP_METHODS['storage.set'].params({ key: 'a' }), /Expected string/, 'a set needs a value');
  assert.deepEqual(APP_METHODS['storage.keys'].params(undefined), { scope: 'project' });
  assert.deepEqual(APP_METHODS['app.badge'].params({ count: 0 }), { count: 0 });
  assert.throws(() => APP_METHODS['app.badge'].params({ count: APP_RPC_LIMITS.badgeCountMax + 1 }), /count must be 0 to 9999/);
  assert.equal(optionalUndoLabel(undefined), undefined);
  assert.equal(optionalUndoLabel('  Pin feedback '), 'Pin feedback');
  for (const bad of ['', '   ', 'two\nlines', 'x'.repeat(APP_RPC_LIMITS.undoLabelCharsMax + 1), 4]) {
    assert.throws(() => optionalUndoLabel(bad), /label|Expected string/, String(bad));
  }
  assert.equal(APP_METHODS['node.remove'].params({ nodeId: 'n0', label: 'Resolve' }).label, 'Resolve');
  assert.throws(() => APP_METHODS['node.addClass'].params({ nodeId: 'n0', className: 'a', label: 'x'.repeat(61) }), /label is 1 to 60 characters/);
});

test('the person: a stable id per person and project, and hiding leaves the id alone', () => {
  const details = { name: 'Ada Lovelace', email: 'Ada@Example.test', github: undefined };
  const shown = appPerson('remote:github.com/acme/site', details, 'device', { hidden: false });
  const hidden = appPerson('remote:github.com/acme/site', details, 'device', { hidden: true });
  assert.deepEqual(shown, { id: shown.id, name: 'Ada Lovelace', email: 'Ada@Example.test', github: undefined });
  assert.deepEqual(hidden, { id: shown.id, name: undefined, email: undefined, github: undefined }, 'hidden is the id and nothing else');
  assert.equal(
    appPerson('remote:github.com/acme/site', { ...details, email: 'ada@example.test' }, 'other', { hidden: false }).id,
    shown.id,
    'email case does not matter',
  );
  assert.notEqual(appPerson('remote:github.com/acme/other', details, 'device', { hidden: false }).id, shown.id, 'another project, another id');
  const github = appPerson('remote:x', { name: undefined, email: 'a@b.test', github: 'Ada' }, 'device', { hidden: false });
  assert.equal(github.id, appPersonId('remote:x', 'github:ada'), 'a GitHub account is the person when known');
  assert.equal(normalizeRemote('git@github.com:Acme/Site.git'), 'github.com/acme/site');
  assert.equal(normalizeRemote('https://token@github.com/acme/site/'), 'github.com/acme/site');
  assert.throws(() => parseAppPerson({ id: 'short' }), /32 hex characters/);
  assert.throws(() => parseAppPerson({ id: 'a'.repeat(32), github: 'not a login' }), /GitHub login/);
});

// The watcher waits out a burst before it reads; give it that and the file system's own delay.
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 400));
}
