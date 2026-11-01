// Exercise the CMS save/read coordinators with deferred IPC. Serialized writes,
// coalesced bursts, retryable failures, file ownership, and read/edit races are
// pinned without timer sleeps or an Electron process.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');

// Null as a boundary receives it, parsed from JSON: inputs may hold it; our values never do.
const jsonNull = JSON.parse('null');
const { createCmsWriter } = load('src/features/cms/cmsWriter.ts');
const { createCmsReader, cmsCollection } = load('src/features/cms/cmsReader.ts');
const { createCmsSchemaOperations } = load('src/features/cms/cmsOperations.ts');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const original = [{ title: 'Original' }];
function fixture(rel = 'data.json') {
  const records = [];
  const errors = [];
  let refreshes = 0;
  let saves = 0;
  const writer = createCmsWriter({
    projectPath: '/project',
    rel,
    report: (error) => errors.push(error),
    record: (command) => records.push(command),
    saved: () => saves++,
    refresh: async () => {
      refreshes++;
    },
  });
  writer.accept(cmsCollection(rel, original), original);
  return { writer, records, errors, saves: () => saves, refreshes: () => refreshes };
}

test(
  'CMS writes serialize, coalesce pending ' + 'snapshots, and record exact inverse data',
  async () => {
    const writes = [];
    global.window = {
      avb: { writeCms: (payload) => new Promise((resolve) => writes.push({ payload, resolve })) },
    };
    const state = fixture();
    const first = [{ title: 'First' }];
    const last = [{ title: 'Last' }];
    state.writer.queue(first);
    const pending = state.writer.flush();
    await tick();
    state.writer.queue([{ title: 'Discarded intermediate' }]);
    state.writer.queue(last);
    // A flush asked during a write is answered by the one write after it, which
    // every flush asked meanwhile shares (src/lib/coalescedRun.ts).
    const follow = state.writer.flush();
    assert.notEqual(follow, pending);
    assert.equal(state.writer.flush(), follow);
    assert.equal(writes.length, 1);
    assert.throws(
      () => state.writer.accept(cmsCollection('data.json', []), []),
      /cannot replace unsaved data/,
    );
    writes[0].resolve({ ok: true });
    await tick();
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[1].payload.data, last);
    assert.equal(await pending, true);
    writes[1].resolve({ ok: true });
    assert.equal(await follow, true);
    assert.equal(state.saves(), 2);
    assert.equal(state.records.length, 2);
    assert.equal(state.records[0].coalesceKey, 'cms:data.json');
    const undo = state.records[1].undo();
    await tick();
    assert.deepEqual(writes[2].payload.data, first);
    writes[2].resolve({ ok: true });
    await undo;
    const redo = state.records[1].redo();
    await tick();
    assert.deepEqual(writes[3].payload.data, last);
    writes[3].resolve({ ok: true });
    await redo;
    assert.equal(state.refreshes(), 2);
  },
);

test('a failed write retains its edit for retry and does not record success', async () => {
  const state = fixture();
  global.window = {
    avb: {
      writeCms: async () => {
        throw new Error('disk full');
      },
    },
  };
  state.writer.queue([{ title: 'Changed' }]);
  assert.equal(await state.writer.flush(), false);
  assert.deepEqual(state.errors, ['disk full']);
  assert.equal(state.saves(), 0);
  assert.equal(state.records.length, 0);
  const written = [];
  window.avb.writeCms = async (payload) => {
    written.push(payload);
    return { ok: true };
  };
  assert.equal(await state.writer.flush(), true);
  assert.deepEqual(written[0].data, [{ title: 'Changed' }]);
  window.avb.writeCms = async () => {
    throw new Error('restore failed');
  };
  await state.records[0].undo();
  assert.deepEqual(state.errors, ['disk full', 'restore failed']);
  assert.equal(state.refreshes(), 0);
});

test(
  'writers enforce ownership, loaded data, ' + 'collection bounds, and wrapper fidelity',
  async () => {
    const state = fixture();
    assert.throws(
      () => state.writer.accept(cmsCollection('another.json', []), []),
      /snapshot belongs to another file/,
    );
    assert.throws(() => state.writer.queue(Array(100001).fill(jsonNull)), /item limit exceeded/);
    const empty = createCmsWriter({
      projectPath: '/project',
      rel: 'data.json',
      report() {},
      record() {},
      saved() {},
      refresh: async () => {},
    });
    assert.throws(() => empty.queue([]), /a loaded snapshot is required/);
    const wrapper = { entries: original, version: 2 };
    state.writer.accept(cmsCollection('data.json', wrapper), wrapper);
    let written;
    global.window = {
      avb: {
        writeCms: async (payload) => {
          written = payload;
          return { ok: true };
        },
      },
    };
    state.writer.queue([{ title: 'Updated' }]);
    await state.writer.flush();
    assert.deepEqual(written, {
      projectPath: '/project',
      rel: 'data.json',
      data: { entries: [{ title: 'Updated' }], version: 2 },
    });
  },
);

test('read bursts coalesce and stale reads cannot replace an edit', async () => {
  const state = fixture();
  const reads = [];
  const published = [];
  global.window = {
    avb: {
      readCms: () => new Promise((resolve) => reads.push(resolve)),
      cmsMeta: async () => ({ meta: {} }),
      writeCms: async () => ({ ok: true }),
    },
  };
  const reader = createCmsReader({
    projectPath: '/project',
    rel: 'data.json',
    writer: state.writer,
    publish: (result) => published.push(result),
    report: (error) => state.errors.push(error),
  });
  const first = reader.refresh();
  await tick();
  // A burst during a read shares the one read after it: two reads in all.
  const pending = reader.refresh();
  for (let index = 0; index < 50; index++) {
    assert.equal(reader.refresh(), pending);
  }
  assert.equal(reads.length, 1);
  reads[0]({ data: original });
  await first;
  await tick();
  assert.equal(reads.length, 2);
  state.writer.queue([{ title: 'Locally changed' }]);
  reads[1]({ data: original });
  await pending;
  assert.equal(published.length, 1, 'the read predates the local edit');
  await state.writer.flush();
  const late = reader.refresh();
  await tick();
  reader.dispose();
  reads[2]({ data: [{ title: 'Late' }] });
  await late;
  await reader.refresh();
  assert.equal(reads.length, 3);
  assert.equal(published.length, 1);
});

test('refresh waits for unsaved data and remains usable after a write failure', async () => {
  const state = fixture();
  let reads = 0;
  global.window = {
    avb: {
      writeCms: async () => {
        throw new Error('disk full');
      },
      readCms: async () => {
        reads++;
        return { data: original };
      },
      cmsMeta: async () => {
        throw new Error('metadata unavailable');
      },
    },
  };
  const published = [];
  const reader = createCmsReader({
    projectPath: '/project',
    rel: 'data.json',
    writer: state.writer,
    publish: (result) => published.push(result),
    report: (error) => state.errors.push(error),
  });
  state.writer.queue(original);
  await reader.refresh();
  assert.equal(reads, 0, 'a failed save must not be replaced by a reload');
  window.avb.writeCms = async () => ({ ok: true });
  await reader.refresh();
  assert.equal(reads, 1);
  assert.equal(published[0].ok, true, 'metadata failure does not hide readable content');
  assert.deepEqual(published[0].value.declared, {});
  assert.deepEqual(state.errors, ['disk full', 'metadata unavailable']);
  reader.dispose();
});

test('schema operations update nested declarations without mutating input', async () => {
  const source = [{ group: { title: 'Title', extra: 'Keep' } }];
  const declared = { 'group.title': 'longtext', 'group.title.nested': 'image', other: 'text' };
  const changes = [];
  const metadata = [];
  const errors = [];
  const operations = createCmsSchemaOperations({
    items: source,
    declared,
    commit: (value) => changes.push(value),
    saveDeclared: async (value) => {
      metadata.push(value);
    },
    report: (message) => errors.push(message),
  });
  assert.equal(operations.onRenameField(['group'], 'title', 'extra'), false);
  assert.equal(errors.length, 1);
  assert.equal(operations.onRenameField(['group'], 'title', 'heading'), true);
  assert.deepEqual(changes[0], [{ group: { heading: 'Title', extra: 'Keep' } }]);
  assert.deepEqual(metadata[0], {
    'group.heading': 'longtext',
    'group.heading.nested': 'image',
    other: 'text',
  });
  operations.onRemoveField(['group'], 'title');
  assert.deepEqual(metadata[1], { other: 'text' });
  operations.onAddField(['group'], 'phone', 'phone');
  assert.deepEqual(changes[2], [{ group: { title: 'Title', extra: 'Keep', phone: '' } }]);
  assert.deepEqual(source, [{ group: { title: 'Title', extra: 'Keep' } }]);
  assert.equal(declared['group.title'], 'longtext');
});

test('an edit during undo waits for the restore and becomes the next snapshot', async () => {
  const state = fixture();
  global.window = { avb: { writeCms: async () => ({ ok: true }) } };
  state.writer.queue([{ title: 'Saved' }]);
  await state.writer.flush();
  const writes = [];
  window.avb.writeCms = (payload) => new Promise((resolve) => writes.push({ payload, resolve }));
  const undo = state.records[0].undo();
  await tick();
  assert.deepEqual(writes[0].payload.data, original);
  state.writer.queue([{ title: 'Typed during undo' }]);
  const pending = state.writer.flush();
  assert.equal(writes.length, 1);
  writes[0].resolve({ ok: true });
  await tick();
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1].payload.data, [{ title: 'Typed during undo' }]);
  writes[1].resolve({ ok: true });
  await Promise.all([undo, pending]);
  assert.equal(state.records.length, 2);
  assert.deepEqual(state.errors, []);
});

test('a field defined inside an empty repeater gives it a first entry', () => {
  const changes = [];
  const operations = createCmsSchemaOperations({
    items: [{ title: 'Post', team: [] }],
    declared: { team: 'objects' },
    commit: (value) => changes.push(value),
    saveDeclared: async () => {},
    report: () => {},
  });
  operations.onAddField(['team'], 'name', 'text');
  assert.deepEqual(changes[0], [{ title: 'Post', team: [{ name: '' }] }]);
  operations.onAddField(['title'], 'name', 'text');
  assert.equal(changes.length, 2);
});
