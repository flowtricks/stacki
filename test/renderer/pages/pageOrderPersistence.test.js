// Goal: pages and folders share a durable sibling order without overwriting another editor.
// Method: exercise the parser and controller with real IPC validation and a witnessed memory disk.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const loadRenderer = require('../../helpers/rendererModule');
const { parsePageOrder, reorderPageEntries, PAGE_ORDER_LIMITS } = loadRenderer('shared/properties/pageOrder.ts');
const { PageOrderController } = loadRenderer('src/features/pages/pageOrderPersistence.ts');

async function until(predicate) {
  for (let count = 0; count < 100; count += 1) {
    if (predicate()) {
      return;
    }
    await delay(10);
  }
  assert.fail('Page order did not settle');
}

test('page-order parser rejects unsafe paths, duplicates, versions and oversized input', () => {
  const good = { version: 1, entries: ['index.astro', 'about/', 'about/story.mdx'] };
  assert.deepEqual(parsePageOrder(good), good);
  for (const input of [
    undefined,
    {},
    { ...good, version: 2 },
    { ...good, entries: {} },
    ...['../x.astro', '/x.astro', 'a//b/', 'a/./', 'a\\b.astro', '', 'a.js', 'a\0/'].map((entry) => ({ version: 1, entries: [entry] })),
    { version: 1, entries: ['index.astro', 'index.astro'] },
    { version: 1, entries: ['x'.repeat(PAGE_ORDER_LIMITS.pathCharsMax) + '/'] },
    { version: 1, entries: Array(PAGE_ORDER_LIMITS.entriesMax + 1).fill('x.astro') },
  ]) {
    assert.throws(() => parsePageOrder(input));
  }
});

test('folders and pages reorder together while retaining child order', () => {
  const initial = parsePageOrder({
    version: 1,
    entries: ['index.astro', 'about/', 'campus/', 'about/story.astro', 'about/index.astro'],
  });
  const siblings = ['index.astro', 'about/', 'campus/'];
  const next = reorderPageEntries(initial, siblings, {
    source: 'campus/',
    target: 'index.astro',
    position: 'before',
  });
  assert.deepEqual(next.entries, ['about/story.astro', 'about/index.astro', 'campus/', 'index.astro', 'about/']);
  assert.equal(
    reorderPageEntries(next, siblings, {
      source: 'about/story.astro',
      target: 'index.astro',
      position: 'after',
    }),
    next,
  );
  assert.equal(
    reorderPageEntries(next, siblings, {
      source: 'index.astro',
      target: 'index.astro',
      position: 'after',
    }),
    next,
  );
});

test('saved order reloads; stale and malformed disk data cannot be overwritten', async () => {
  let source;
  const writes = [];
  globalThis.window = {
    avb: {
      projectMetadata: async () => ({ ok: true, value: source === undefined ? {} : { source } }),
      writeProjectMetadata: async ({ write }) => {
        if (write.base !== source) {
          return { ok: false, error: { code: 'stale', message: 'Changed in another editor.' } };
        }
        source = write.source;
        writes.push(write);
        return { ok: true, value: { source } };
      },
    },
  };
  const firstStates = [];
  const secondStates = [];
  const first = new PageOrderController('/project', (state) => firstStates.push(state));
  const second = new PageOrderController('/project', (state) => secondStates.push(state));
  try {
    first.reload();
    second.reload();
    await until(() => firstStates.at(-1)?.kind === 'ready' && secondStates.at(-1)?.kind === 'ready');
    const order = { version: 1, entries: ['campus/', 'index.astro', 'about/'] };
    first.save(order);
    await until(() => firstStates.at(-1)?.kind === 'ready');
    assert.equal(writes[0].kind, 'pages');
    second.save({ version: 1, entries: ['about/', 'index.astro', 'campus/'] });
    await until(() => secondStates.at(-1)?.kind === 'failed');
    assert.deepEqual(secondStates.at(-1).order.entries, []);
    assert.deepEqual(JSON.parse(source), order);
    second.reload();
    await until(() => secondStates.at(-1)?.kind === 'ready');
    assert.deepEqual(secondStates.at(-1).order, order);
    source = '{broken';
    second.reload();
    await until(() => secondStates.at(-1)?.kind === 'failed');
    second.save(order);
    assert.equal(source, '{broken');
    assert.equal(writes.length, 1);
  } finally {
    first.close();
    second.close();
    delete globalThis.window;
  }
});
