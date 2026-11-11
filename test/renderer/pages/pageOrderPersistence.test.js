// Goal: pages and folders share a durable sibling order without overwriting another editor.
// Method: exercise the parser and controller with real IPC validation and a witnessed memory disk.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const loadRenderer = require('../../helpers/rendererModule');
const { parsePageOrder, reorderPageEntries, PAGE_ORDER_LIMITS } = loadRenderer('shared/properties/pageOrder.ts');
const { PageOrderController } = loadRenderer('src/features/pages/pageOrderPersistence.ts');
const LOADING = { kind: 'loading', order: { version: 1, entries: [] } };

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
  const first = new PageOrderController('/project', LOADING, (state) => firstStates.push(state));
  const second = new PageOrderController('/project', LOADING, (state) => secondStates.push(state));
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

test('a kept order stays ready while it is read again, and a save outranks the read it overtook', async () => {
  // The Pages panel opens on the order it last saw (so its rows hold still) and
  // reads the file again in place. A drag saved before that read lands must not
  // be undone by the older answer.
  let source = JSON.stringify({ version: 1, entries: ['about.astro', 'index.astro'] });
  let answerRead;
  globalThis.window = {
    avb: {
      projectMetadata: () => new Promise((resolve) => (answerRead = () => resolve({ ok: true, value: { source } }))),
      writeProjectMetadata: async ({ write }) => {
        source = write.source;
        return { ok: true, value: { source } };
      },
    },
  };
  const kept = { kind: 'ready', order: { version: 1, entries: ['about.astro', 'index.astro'] }, source };
  const states = [];
  const controller = new PageOrderController('/kept', kept, (state) => states.push(state));
  try {
    const stale = source;
    controller.reload();
    assert.equal(states.length, 0, 'A kept order is not replaced by a loading state');
    const moved = { version: 1, entries: ['index.astro', 'about.astro'] };
    controller.save(moved);
    await until(() => states.at(-1)?.kind === 'ready');
    // The read began before the save; its answer (the bytes before the save) arrives last.
    source = stale;
    answerRead();
    await delay(20);
    assert.deepEqual(states.at(-1).order, moved, 'The older read does not undo the save');
    assert.throws(() => new PageOrderController('/kept', { kind: 'saving', order: moved }, () => undefined), /it starts loading or on a kept order/);
  } finally {
    controller.close();
    delete globalThis.window;
  }
});
