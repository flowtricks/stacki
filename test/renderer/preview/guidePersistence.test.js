// Goal: project files become the guide's authority after legacy preference migration.
// Method: run the real controller and IPC parsers against a bounded in-memory disk,
// then exercise coalesced changes, independent editors, stale saves and reopening.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const loadRenderer = require('../../helpers/rendererModule');
const { createGuideController } = loadRenderer('src/features/preview/guidePersistence.ts');

async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await delay(10);
  }
  assert.fail('Guide controller did not reach the expected state within one second');
}

test('guide migration, coalesced saves, and stale editor protection', async () => {
  let source;
  const writes = [];
  globalThis.CSS = { supports: () => true };
  globalThis.localStorage = {
    getItem: () =>
      JSON.stringify({ columns: 8, visible: true, color: '#abc', columnDefaultsVersion: 1 }),
  };
  globalThis.window = {
    avb: {
      projectMetadata: async () => ({ ok: true, value: source === undefined ? {} : { source } }),
      writeProjectMetadata: async ({ write: input }) => {
        if (input.base !== source) {
          return { ok: false, error: { code: 'stale', message: 'Changed in another editor.' } };
        }
        source = input.source;
        writes.push(input);
        return { ok: true, value: { source } };
      },
    },
  };
  const states = [];
  const first = createGuideController('/project', (state) => states.push(state));
  first.reload();
  await until(() => writes.length === 1);
  assert.equal(JSON.parse(source).settings.columns.count, 8);
  assert.equal(JSON.parse(source).settings.visible, true);
  first.change((settings) => ({ ...settings, opacity: 0.11 }));
  first.change((settings) => ({ ...settings, opacity: 0.12 }));
  await until(() => writes.length === 2);
  assert.equal(JSON.parse(source).settings.opacity, 0.12);

  const otherStates = [];
  const other = createGuideController('/project', (state) => otherStates.push(state));
  other.reload();
  await until(() => otherStates.at(-1)?.loading === false);
  assert.equal(otherStates.at(-1).settings.opacity, 0.12);
  assert.equal(writes.length, 2);
  first.change((settings) => ({ ...settings, opacity: 0.2 }));
  await until(() => writes.length === 3);
  other.change((settings) => ({ ...settings, opacity: 0.3 }));
  await until(() => otherStates.at(-1)?.message.includes('Changed in another editor.'));
  assert.equal(JSON.parse(source).settings.opacity, 0.2);
  other.reload();
  await until(() => otherStates.at(-1)?.settings.opacity === 0.2);
  first.close();
  other.close();
  delete globalThis.window;
  delete globalThis.localStorage;
  delete globalThis.CSS;
});

for (const legacy of [
  JSON.parse('null'),
  undefined,
  '{broken',
  'null',
  '[]',
  '42',
  'x'.repeat(2049),
]) {
  test(`guide saves on change with legacy record ${String(legacy).slice(0, 20)}`, async () => {
    let source;
    const writes = [];
    globalThis.CSS = { supports: () => true };
    globalThis.localStorage = { getItem: () => legacy };
    globalThis.window = {
      avb: {
        projectMetadata: async () => ({ ok: true, value: source === undefined ? {} : { source } }),
        writeProjectMetadata: async ({ write: input }) => {
          source = input.source;
          writes.push(input);
          return { ok: true, value: { source } };
        },
      },
    };
    const states = [];
    const controller = createGuideController('/project', (state) => states.push(state));
    controller.reload();
    await until(() => states.at(-1)?.loading === false);
    // Let a save that should not happen have its chance to run.
    await delay(50);
    assert.equal(writes.length, 0);
    assert.equal(source, undefined);
    controller.change((settings) => ({ ...settings, opacity: 0.15 }));
    await until(() => writes.length === 1);
    assert.equal(writes[0].base, undefined);
    assert.equal(JSON.parse(source).settings.opacity, 0.15);
    controller.close();
    delete globalThis.window;
    delete globalThis.localStorage;
    delete globalThis.CSS;
  });
}
