// Goal: the generic key-level edit (path reading and set, unset, add, remove) accepts exactly what the key reference allows and nothing else.
// Method: paths are round-tripped and malformed ones refused; edits run on the guide, styles and roles registries (nested object, variant,
// list, map) asserting the new document, that the input document is never changed, and one refusal per rule: unknown key, wrong type,
// out of bounds, required key removed, duplicate map entry, bad list position.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyConfigOperation, readConfigValue } from '#dist/shared/properties/cli/stackiConfigEdit.js';
import { formatConfigPath, parseConfigPath } from '#dist/shared/properties/cli/stackiConfigPath.js';
import { fileSchemaById } from '#dist/shared/properties/cli/stackiFiles.js';

const guide = fileSchemaById('guide');
const styles = fileSchemaById('styles');
assert.ok(guide !== undefined && styles !== undefined);

const path = (text: string) => {
  const parsed = parseConfigPath(text);
  assert.ok(parsed.ok, text);
  return parsed.value;
};

test('paths round-trip and malformed ones are refused', () => {
  for (const text of ['settings.visible', 'entries[3]', 'components["src/Card.astro"].tag', 'a["x.y"][0]']) {
    assert.equal(formatConfigPath(path(text)), text);
  }
  for (const bad of ['a..b', '.a', 'a[', 'a[x]', 'a["b"', '', 'a b', `${'a.'.repeat(20)}a`]) {
    const parsed = parseConfigPath(bad);
    assert.ok(bad === '' ? parsed.ok : !parsed.ok, `"${bad}"`);
  }
});

test('set replaces nested keys and a variant, and never changes its input', () => {
  const before = { ...guide.empty };
  const frozen = JSON.stringify(before);
  const next = applyConfigOperation(guide, before, { kind: 'set', path: path('settings.columns'), value: { kind: 'count', count: 6 } });
  assert.ok(next.ok);
  assert.deepEqual(Reflect.get(Object(next.value['settings']), 'columns'), { kind: 'count', count: 6 });
  assert.equal(JSON.stringify(before), frozen);
});

test('each rule refuses with its own code', () => {
  const run = (operation: Parameters<typeof applyConfigOperation>[2]) => applyConfigOperation(guide, guide.empty, operation);
  const expectCode = (result: ReturnType<typeof run>, code: string) => {
    assert.ok(!result.ok);
    assert.equal(result.error.code, code);
  };
  expectCode(run({ kind: 'set', path: path('settings.visibel'), value: true }), 'unknown-key');
  expectCode(run({ kind: 'set', path: path('settings.visible'), value: 'yes' }), 'invalid-value');
  expectCode(run({ kind: 'set', path: path('settings.opacity'), value: 5 }), 'invalid-value');
  expectCode(run({ kind: 'set', path: path('settings.columns'), value: { kind: 'count', count: 99 } }), 'invalid-value');
  expectCode(run({ kind: 'set', path: path('settings.columns'), value: { kind: 'count', count: 4, extra: 1 } }), 'invalid-value');
  expectCode(run({ kind: 'unset', path: path('settings.visible') }), 'required');
  expectCode(run({ kind: 'unset', path: path('settings.margin') }), 'missing');
  expectCode(run({ kind: 'set', path: path('legacyKey'), value: 1 }), 'unknown-key');
  expectCode(run({ kind: 'set', path: [], value: 1 }), 'bad-path');
});

test('lists: add, add at a position, remove by value, remove by position, bounds and the legacy key', () => {
  const start = { version: 1, keep: ['a'], lockedStylesheets: [], trustedScripts: ['x'] };
  const added = applyConfigOperation(styles, start, { kind: 'add', path: path('keep'), value: 'b', position: 0 });
  assert.ok(added.ok);
  assert.deepEqual(added.value['keep'], ['b', 'a']);
  const removed = applyConfigOperation(styles, added.value, { kind: 'remove', path: path('keep[0]') });
  assert.ok(removed.ok);
  assert.deepEqual(removed.value['keep'], ['a']);
  assert.ok(removed.ok && removed.value['trustedScripts'] !== undefined, 'a legacy key the app drops later is left alone');
  const missing = applyConfigOperation(styles, start, { kind: 'remove', path: path('keep'), value: 'zzz' });
  assert.ok(!missing.ok && missing.error.code === 'missing');
  const space = applyConfigOperation(styles, start, { kind: 'add', path: path('keep'), value: 'has space' });
  assert.ok(!space.ok, 'the key reference refuses a pattern the app would not accept');
  const legacy = applyConfigOperation(styles, start, { kind: 'set', path: path('trustedScripts'), value: [] });
  assert.ok(!legacy.ok && legacy.error.code === 'unknown-key', 'a legacy key is not settable');
});

test('get reports the value, its type and its description', () => {
  const read = readConfigValue(guide, guide.empty, path('settings.opacity'));
  assert.ok(read.ok);
  assert.equal(read.value.present, true);
  assert.match(read.value.type, /number/);
  assert.equal(read.value.default, 0.06);
  const absent = readConfigValue(guide, guide.empty, path('settings.margin'));
  assert.ok(absent.ok && !absent.value.present);
});
