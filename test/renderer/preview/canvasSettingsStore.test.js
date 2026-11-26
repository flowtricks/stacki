// Goal: no edit of the component canvas ever loses another setting. Every pair of edit kinds, in both orders, keeps what
// each set and everything stored before: other components, the project's classes and background, a component's own
// canvas root, its split and a later version's keys. The one writer applies changes to the file as it is when written:
// rapid edits while a save is under way, a change made to the file from outside, a save that is refused, and a reload.
// Method: apply the shared edit functions to a file holding one of everything and compare the two orders byte for byte;
// then drive canvasSettingsStore over an in-memory file whose writes refuse a stale base, as the app's transport does.
// A first-hand bug: editing a frame's prop removed the component's own canvas root, classes and all.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule');
const shared = require('#dist/shared/properties/componentCanvas.js');
const { canvasSettingsStore } = loadRenderer('src/app/model/canvasSettingsStore.ts');

const CARD = 'src/components/Card.astro';
const OTHER = 'src/components/Other.astro';
const STORED = {
  version: 1,
  background: '#101010',
  classes: ['theme-dark'],
  components: {
    [CARD]: { split: ['variant'], root: { background: '#222222', classes: ['theme-light'] }, frames: { '': { width: 300 } } },
    [OTHER]: { frames: { '': { props: { label: 'Other' } } } },
  },
  layout: { direction: 'from a later version' },
};
const parse = (text) => {
  const result = shared.parseComponentCanvasSource(text);
  assert.ok(result.ok, result.ok ? '' : result.error.message);
  return result.value;
};
const base = () => parse(JSON.stringify(STORED));

const frame = (scope, edit) => (file) => shared.withFrameEdit(file, CARD, scope, edit);
const root = (target, edit) => (file) => shared.withRootEdit(file, target, edit);
const own = { kind: 'component', file: CARD };
// Each kind of edit the canvas makes, with how to tell that it is still there.
const KINDS = {
  prop: [frame('variant=a', { kind: 'prop', name: 'label', value: 'A' }), (after) => after.components[CARD].frames['variant=a'].props.label === 'A'],
  asset: [
    frame('variant=b', { kind: 'asset', name: 'image', asset: { file: 'src/assets/a.png' } }),
    (after) => after.components[CARD].frames['variant=b'].assets.image.file === 'src/assets/a.png',
  ],
  literal: [
    frame('variant=c', { kind: 'literal', name: 'tags', literal: '["x"]' }),
    (after) => after.components[CARD].frames['variant=c'].literals.tags === '["x"]',
  ],
  content: [frame('variant=d', { kind: 'content', value: 'Words' }), (after) => after.components[CARD].frames['variant=d'].content === 'Words'],
  reset: [frame('', { kind: 'field', field: 'width', value: undefined }), (after) => after.components[CARD].frames?.['']?.width === undefined],
  height: [frame('variant=e', { kind: 'field', field: 'height', value: 120 }), (after) => after.components[CARD].frames['variant=e'].height === 120],
  frameBackground: [
    frame('variant=f', { kind: 'background', value: '#333333' }),
    (after) => after.components[CARD].frames['variant=f'].background === '#333333',
  ],
  split: [(file) => shared.withSplit(file, CARD, ['variant', 'tone']), (after) => after.components[CARD].split.join() === 'variant,tone'],
  projectClasses: [root(shared.PROJECT_ROOT, { kind: 'classes', value: ['theme-brand'] }), (after) => after.classes.join() === 'theme-brand'],
  projectBackground: [root(shared.PROJECT_ROOT, { kind: 'background', value: '#444444' }), (after) => after.background === '#444444'],
  ownClasses: [root(own, { kind: 'classes', value: ['theme-own'] }), (after) => after.components[CARD].root.classes.join() === 'theme-own'],
  ownBackground: [root(own, { kind: 'background', value: '#555555' }), (after) => after.components[CARD].root.background === '#555555'],
};

// What no edit here touches stays, unless the edit is the one that sets it.
function untouched(file, applied) {
  assert.deepEqual(file.components[OTHER], STORED.components[OTHER], 'another component keeps its settings');
  assert.deepEqual(file.later, { layout: STORED.layout }, 'a later version’s key is carried through');
  if (!applied.includes('projectClasses')) {
    assert.deepEqual(file.classes, STORED.classes, `project classes after ${applied.join(' then ')}`);
  }
  if (!applied.includes('projectBackground')) {
    assert.equal(file.background, STORED.background);
  }
  if (!applied.includes('ownClasses')) {
    assert.deepEqual(file.components[CARD].root?.classes, ['theme-light'], `own classes after ${applied.join(' then ')}`);
  }
  if (!applied.includes('ownBackground')) {
    assert.equal(file.components[CARD].root?.background, '#222222', `own background after ${applied.join(' then ')}`);
  }
  if (!applied.includes('split')) {
    assert.deepEqual(file.components[CARD].split, ['variant']);
  }
}

test('every pair of edit kinds keeps both and everything else, in either order, and reads back the same', () => {
  const names = Object.keys(KINDS);
  for (const first of names) {
    for (const second of names.filter((name) => name !== first)) {
      const file = KINDS[second][0](KINDS[first][0](base()));
      const reloaded = parse(shared.serializeComponentCanvas(file));
      for (const name of [first, second]) {
        assert.ok(KINDS[name][1](reloaded), `${name} survives ${first} then ${second}`);
      }
      untouched(reloaded, [first, second]);
      assert.equal(shared.serializeComponentCanvas(file), shared.serializeComponentCanvas(KINDS[first][0](KINDS[second][0](base()))), `${first}/${second}`);
    }
  }
});

test('turning a split on and off, and setting and resetting a value, leaves the file as it was', () => {
  const start = shared.serializeComponentCanvas(base());
  let file = shared.withSplit(base(), CARD, ['variant', 'tone']);
  file = shared.withSplit(file, CARD, ['variant']);
  file = KINDS.prop[0](file);
  file = shared.withFrameEdit(file, CARD, 'variant=a', { kind: 'inherit', name: 'label' });
  assert.equal(shared.serializeComponentCanvas(file), start);
});

// The app's transport: a write lands only where the file still holds what it was built on.
function disk(initial) {
  const held = { source: initial, writes: 0, during: undefined };
  return {
    held,
    io: {
      read: async () => held.source,
      write: async (source, from) => {
        await new Promise((resolve) => setImmediate(resolve));
        held.during?.();
        held.during = undefined;
        if (held.source !== from) {
          throw new Error('Project settings changed. Reload before saving.');
        }
        held.source = source;
        held.writes += 1;
        return source;
      },
    },
  };
}

test('edits made while a save runs are written after it, and saves never overlap', async () => {
  const stored = shared.serializeComponentCanvas(base());
  const { held, io } = disk(stored);
  const store = canvasSettingsStore(io, stored);
  store.change(KINDS.projectClasses[0]);
  const first = store.save();
  store.change(KINDS.prop[0]);
  const second = store.save();
  store.change(KINDS.ownBackground[0]);
  await Promise.all([first, second, store.save()]);
  const written = parse(held.source);
  for (const name of ['projectClasses', 'prop', 'ownBackground']) {
    assert.ok(KINDS[name][1](written), name);
  }
});

test('a change to the file from outside is kept: the canvas’s edits are applied to what is there now', async () => {
  const stored = shared.serializeComponentCanvas(base());
  const { held, io } = disk(stored);
  const store = canvasSettingsStore(io, stored);
  store.change(KINDS.prop[0]);
  // Another writer lands while this save is under way.
  held.during = () => {
    held.source = shared.serializeComponentCanvas(KINDS.projectBackground[0](parse(held.source)));
  };
  const view = await store.save();
  const written = parse(held.source);
  assert.ok(KINDS.prop[1](written), 'the canvas edit lands');
  assert.ok(KINDS.projectBackground[1](written), 'the outside change stays');
  assert.deepEqual(view, written);
  // Read again with an edit not yet written: both are shown, and a reload of what is saved shows them.
  store.change(KINDS.content[0]);
  held.source = shared.serializeComponentCanvas(KINDS.ownClasses[0](parse(held.source)));
  const reread = await store.reread();
  assert.ok(KINDS.content[1](reread));
  assert.ok(KINDS.ownClasses[1](reread));
  await store.save();
  const reopened = await canvasSettingsStore(io, held.source).save();
  for (const name of ['prop', 'projectBackground', 'content', 'ownClasses']) {
    assert.ok(KINDS[name][1](reopened), name);
  }
});

test('a save that cannot land says so and keeps the edits; a file it cannot read is never written over', async () => {
  const stored = shared.serializeComponentCanvas(base());
  const { held, io } = disk(stored);
  let refuse = true;
  const store = canvasSettingsStore(
    {
      read: io.read,
      write: (source, from) => (refuse ? Promise.reject(new Error('disk full')) : io.write(source, from)),
    },
    stored,
  );
  store.change(KINDS.prop[0]);
  await assert.rejects(store.save(), /disk full/);
  refuse = false;
  await store.save();
  assert.ok(KINDS.prop[1](parse(held.source)));
  store.change(KINDS.height[0]);
  held.source = '{ not json';
  await assert.rejects(store.save(), /component-canvas\.json/);
  assert.equal(held.source, '{ not json');
});

test('nothing set writes no file', async () => {
  const { held, io } = disk(undefined);
  await canvasSettingsStore(io, undefined).save();
  assert.equal(held.writes, 0);
});
