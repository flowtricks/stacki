// Goal: dragging a chat between and within sections decides correctly, and a click never
// turns into a drag.
// Method, part 1: the pure model (src/ui/sectionedDragModel.ts). resolveDrop is checked for
// every refusal (unknown item, unknown section, drop on itself, into a collapsed section,
// before an item that is elsewhere, a drop that changes nothing) and for the moves it
// allows; applyMove is run over many seeded random moves and must always keep every item
// exactly once and every other item in its order; stepTarget (Alt+Arrow) is walked across
// section edges and past collapsed sections; locateDrop maps a pointer height to a target.
// Part 2: the hook in jsdom with real pointer events: a press and release is not a drag, a
// short wobble is not a drag, a long travel is, Escape cancels, and nested controls keep
// their own presses.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const load = require('../../helpers/rendererModule');
const { repoPath } = require('../../helpers/sources.js');
const { resolveDrop, applyMove, stepTarget, locateDrop, assertDragSections } = load('src/ui/sectionedDragModel.ts');
const { autoscrollDelta } = load('src/ui/useSectionedDrag.ts');

const sections = () => [
  { id: 'inbox', collapsed: false, itemIds: ['a', 'b', 'c'] },
  { id: 'work', collapsed: false, itemIds: ['d', 'e'] },
  { id: 'old', collapsed: true, itemIds: ['f'] },
  { id: 'empty', collapsed: false, itemIds: [] },
];

test('moves inside a section and between sections report the index after removal', () => {
  const result = resolveDrop(sections(), 'a', { sectionId: 'inbox', beforeId: undefined });
  assert.deepEqual(result, { kind: 'move', move: { itemId: 'a', sectionId: 'inbox', beforeId: undefined, index: 2 } });
  const across = resolveDrop(sections(), 'a', { sectionId: 'work', beforeId: 'e' });
  assert.deepEqual(across, { kind: 'move', move: { itemId: 'a', sectionId: 'work', beforeId: 'e', index: 1 } });
  const intoEmpty = resolveDrop(sections(), 'a', { sectionId: 'empty', beforeId: undefined });
  assert.equal(intoEmpty.kind, 'move');
  assert.equal(intoEmpty.move.index, 0);
});

test('every refusal names its reason', () => {
  const reason = (id, target) => resolveDrop(sections(), id, target).reason;
  assert.equal(reason('zzz', { sectionId: 'inbox', beforeId: undefined }), 'unknown-item');
  assert.equal(reason('a', { sectionId: 'nowhere', beforeId: undefined }), 'unknown-section');
  assert.equal(reason('a', { sectionId: 'inbox', beforeId: 'a' }), 'self');
  assert.equal(reason('a', { sectionId: 'old', beforeId: undefined }), 'collapsed');
  assert.equal(reason('a', { sectionId: 'old', beforeId: 'f' }), 'collapsed');
  assert.equal(reason('a', { sectionId: 'inbox', beforeId: 'd' }), 'unknown-anchor');
  assert.equal(reason('a', { sectionId: 'inbox', beforeId: 'b' }), 'no-change', 'dropping before the next sibling leaves it in place');
  assert.equal(reason('c', { sectionId: 'inbox', beforeId: undefined }), 'no-change', 'the last item dropped at the end');
  assert.equal(reason('b', { sectionId: 'inbox', beforeId: 'c' }), 'no-change');
});

test('duplicate ids are a programmer error', () => {
  assert.throws(() => assertDragSections([{ id: 's', collapsed: false, itemIds: ['a', 'a'] }]), /duplicate item a/);
  assert.throws(
    () =>
      assertDragSections([
        { id: 's', collapsed: false, itemIds: ['a'] },
        { id: 't', collapsed: false, itemIds: ['a'] },
      ]),
    /duplicate item a/,
  );
  assert.throws(
    () =>
      assertDragSections([
        { id: 's', collapsed: false, itemIds: [] },
        { id: 's', collapsed: false, itemIds: [] },
      ]),
    /duplicate section s/,
  );
});

// A small seeded generator keeps the property reproducible.
function random(seed) {
  let state = seed;
  return (limit) => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state % limit;
  };
}

test('any run of allowed moves keeps every item once and the others in order', () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    const next = random(seed);
    let current = sections();
    const everything = current.flatMap((section) => section.itemIds).sort();
    for (let step = 0; step < 60; step += 1) {
      const itemIds = current.flatMap((section) => section.itemIds);
      const itemId = itemIds[next(itemIds.length)];
      const destination = current[next(current.length)];
      const beforeId = destination.itemIds.length === 0 || next(3) === 0 ? undefined : destination.itemIds[next(destination.itemIds.length)];
      const decision = resolveDrop(current, itemId, { sectionId: destination.id, beforeId });
      if (decision.kind !== 'move') {
        continue;
      }
      const before = current;
      current = applyMove(current, decision.move);
      assert.deepEqual(current.flatMap((section) => section.itemIds).sort(), everything);
      assert.equal(current.find((section) => section.id === decision.move.sectionId).itemIds[decision.move.index], itemId);
      for (const section of current) {
        const was = before.find((candidate) => candidate.id === section.id).itemIds.filter((id) => id !== itemId);
        assert.deepEqual(
          section.itemIds.filter((id) => id !== itemId),
          was,
          'the others keep their order',
        );
      }
    }
  }
});

test('applyMove does not change its input and refuses an index outside the section', () => {
  const input = sections();
  applyMove(input, { itemId: 'a', sectionId: 'work', beforeId: undefined, index: 2 });
  assert.deepEqual(input, sections());
  assert.throws(() => applyMove(input, { itemId: 'a', sectionId: 'work', beforeId: undefined, index: 9 }), /inside the section/);
});

test('Alt+Arrow walks an item up and down, over section edges, skipping collapsed sections', () => {
  assert.deepEqual(stepTarget(sections(), 'b', 'up'), { sectionId: 'inbox', beforeId: 'a' });
  assert.deepEqual(stepTarget(sections(), 'a', 'up'), undefined, 'the very top');
  assert.deepEqual(stepTarget(sections(), 'a', 'down'), { sectionId: 'inbox', beforeId: 'c' });
  assert.deepEqual(stepTarget(sections(), 'b', 'down'), { sectionId: 'inbox', beforeId: undefined });
  assert.deepEqual(stepTarget(sections(), 'c', 'down'), { sectionId: 'work', beforeId: 'd' });
  assert.deepEqual(stepTarget(sections(), 'd', 'up'), { sectionId: 'inbox', beforeId: undefined });
  assert.deepEqual(stepTarget(sections(), 'e', 'down'), { sectionId: 'empty', beforeId: undefined }, 'past a collapsed section');
  assert.deepEqual(stepTarget(sections(), 'zzz', 'up'), undefined);
});

test('stepping with the keyboard always reaches an allowed move or the end of the list', () => {
  let current = sections();
  for (let step = 0; step < 20; step += 1) {
    const target = stepTarget(current, 'a', 'down');
    if (target === undefined) {
      break;
    }
    const decision = resolveDrop(current, 'a', target);
    assert.equal(decision.kind, 'move', `step ${step}: ${JSON.stringify(target)}`);
    current = applyMove(current, decision.move);
  }
  assert.deepEqual(current.find((section) => section.id === 'empty').itemIds, ['a']);
});

const layout = [
  {
    id: 'inbox',
    top: 0,
    bottom: 100,
    collapsed: false,
    rows: [
      { id: 'a', top: 20, bottom: 40 },
      { id: 'b', top: 40, bottom: 60 },
      { id: 'c', top: 60, bottom: 80 },
    ],
  },
  { id: 'work', top: 110, bottom: 170, collapsed: false, rows: [{ id: 'd', top: 130, bottom: 150 }] },
  { id: 'old', top: 180, bottom: 200, collapsed: true, rows: [] },
];

test('a pointer height becomes a section and an anchor row', () => {
  assert.deepEqual(locateDrop(layout, 25), { sectionId: 'inbox', beforeId: 'a' });
  assert.deepEqual(locateDrop(layout, 55), { sectionId: 'inbox', beforeId: 'c' });
  assert.deepEqual(locateDrop(layout, 90), { sectionId: 'inbox', beforeId: undefined });
  assert.deepEqual(locateDrop(layout, 5), { sectionId: 'inbox', beforeId: 'a' }, 'over the header: the start');
  assert.deepEqual(locateDrop(layout, 105), { sectionId: 'inbox', beforeId: undefined }, 'in the gap: the nearer section');
  assert.deepEqual(locateDrop(layout, 108), { sectionId: 'work', beforeId: 'd' });
  assert.deepEqual(locateDrop(layout, 190), { sectionId: 'old', beforeId: undefined });
  assert.deepEqual(locateDrop(layout, -500), { sectionId: 'inbox', beforeId: 'a' }, 'above the list');
  assert.deepEqual(locateDrop(layout, 9999), { sectionId: 'old', beforeId: undefined }, 'below the list');
  assert.equal(locateDrop([], 10), undefined);
  assert.throws(() => locateDrop(layout, Number.NaN), /y is finite/);
});

test('the list scrolls near an edge, faster the closer, and never in the middle', () => {
  assert.equal(autoscrollDelta(300, 100, 500), 0);
  assert.ok(autoscrollDelta(110, 100, 500) < 0);
  assert.ok(autoscrollDelta(490, 100, 500) > 0);
  assert.ok(Math.abs(autoscrollDelta(100, 100, 500)) >= Math.abs(autoscrollDelta(125, 100, 500)));
  assert.ok(Math.abs(autoscrollDelta(-400, 100, 500)) <= 16, 'bounded');
  assert.ok(autoscrollDelta(9000, 100, 500) <= 16, 'bounded');
});

// Part 2: the hook in jsdom.

const { JSDOM } = require('jsdom');
const pageDirectory = repoPath('node_modules/.stacki-test/sectioned-drag');
fs.mkdirSync(pageDirectory, { recursive: true });
const bundle = path.join(pageDirectory, 'hook.cjs');
buildSync({
  stdin: { contents: "export * from './src/ui/useSectionedDrag';", resolveDir: repoPath('.'), loader: 'ts' },
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
});

async function mount() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.Element = dom.window.Element;
  global.Node = dom.window.Node;
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  global.IS_REACT_ACT_ENVIRONMENT = true;
  delete require.cache[bundle];
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = require('react');
  const { useSectionedDrag } = require(bundle);
  const moves = [];
  const clicks = [];
  const data = [
    { id: 'inbox', collapsed: false, itemIds: ['a', 'b', 'c'] },
    { id: 'work', collapsed: false, itemIds: ['d'] },
  ];
  function List() {
    const drag = useSectionedDrag({ sections: data, onMove: (move) => moves.push(move) });
    return React.createElement(
      'div',
      { ref: drag.containerRef, id: 'list' },
      data.map((section) =>
        React.createElement(
          'section',
          { key: section.id, id: `s-${section.id}`, ...drag.sectionProps(section.id) },
          section.itemIds.map((id) =>
            React.createElement(
              'div',
              { key: id, id: `i-${id}`, tabIndex: 0, onClick: () => clicks.push(id), ...drag.itemProps(id) },
              id,
              React.createElement('button', { id: `b-${id}`, type: 'button' }, 'x'),
            ),
          ),
        ),
      ),
    );
  }
  const root = createRoot(dom.window.document.getElementById('root'));
  await act(async () => root.render(React.createElement(List)));
  // Jsdom has no layout: rows are 20px tall stacked, sections 100px apart.
  const rows = { a: 20, b: 40, c: 60, d: 140 };
  for (const [id, top] of Object.entries(rows)) {
    dom.window.document.getElementById(`i-${id}`).getBoundingClientRect = () => ({ top, bottom: top + 20, left: 0, right: 100, width: 100, height: 20 });
  }
  dom.window.document.getElementById('s-inbox').getBoundingClientRect = () => ({ top: 0, bottom: 90, left: 0, right: 100, width: 100, height: 90 });
  dom.window.document.getElementById('s-work').getBoundingClientRect = () => ({ top: 100, bottom: 190, left: 0, right: 100, width: 100, height: 90 });
  dom.window.document.getElementById('list').getBoundingClientRect = () => ({ top: 0, bottom: 400, left: 0, right: 100, width: 100, height: 400 });
  const pointer = (type, target, x, y) =>
    act(async () => {
      const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
      Object.defineProperty(event, 'pointerId', { value: 1 });
      target.dispatchEvent(event);
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  const settle = (ms = 40) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
  return { dom, moves, clicks, pointer, settle, act, root, get: (id) => dom.window.document.getElementById(id) };
}

test('a press and release is a click, never a drag', async () => {
  const view = await mount();
  const row = view.get('i-b');
  await view.pointer('pointerdown', row, 10, 50);
  await view.pointer('pointerup', view.dom.window, 10, 50);
  await view.act(async () => row.dispatchEvent(new view.dom.window.MouseEvent('click', { bubbles: true })));
  assert.deepEqual(view.moves, []);
  assert.deepEqual(view.clicks, ['b'], 'the click reaches the row');
});

test('a wobble under the start distance is still a click', async () => {
  const view = await mount();
  const row = view.get('i-b');
  await view.pointer('pointerdown', row, 10, 50);
  await view.pointer('pointermove', view.dom.window, 12, 52);
  await view.pointer('pointerup', view.dom.window, 12, 52);
  assert.deepEqual(view.moves, []);
  assert.equal(view.get('i-b').hasAttribute('data-dragging'), false);
});

test('dragging a row past the start distance drops it where the pointer is and swallows the click', async () => {
  const view = await mount();
  const row = view.get('i-a');
  await view.pointer('pointerdown', row, 10, 30);
  await view.pointer('pointermove', view.dom.window, 10, 150);
  assert.equal(view.get('i-a').getAttribute('data-dragging'), 'true');
  // A browser dispatches the click in the same task as the release, before any timer.
  await view.act(async () => {
    const up = new view.dom.window.MouseEvent('pointerup', { bubbles: true, cancelable: true, clientX: 10, clientY: 150, button: 0 });
    Object.defineProperty(up, 'pointerId', { value: 1 });
    view.dom.window.dispatchEvent(up);
    row.dispatchEvent(new view.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  assert.equal(view.moves.length, 1);
  assert.deepEqual(view.moves[0], { itemId: 'a', sectionId: 'work', beforeId: undefined, index: 1 });
  assert.deepEqual(view.clicks, [], 'the click that ends a drag does not open the row');
});

test('dropping on its own place or cancelling with Escape moves nothing', async () => {
  const view = await mount();
  await view.pointer('pointerdown', view.get('i-a'), 10, 30);
  await view.pointer('pointermove', view.dom.window, 10, 35);
  await view.pointer('pointermove', view.dom.window, 10, 36);
  await view.pointer('pointerup', view.dom.window, 10, 36);
  assert.deepEqual(view.moves, [], 'released over where it already is');
  await view.pointer('pointerdown', view.get('i-a'), 10, 30);
  await view.pointer('pointermove', view.dom.window, 10, 150);
  await view.act(async () => view.dom.window.dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'Escape' })));
  await view.pointer('pointerup', view.dom.window, 10, 150);
  assert.deepEqual(view.moves, []);
});

test("a press on a button inside the row is the button's own", async () => {
  const view = await mount();
  await view.pointer('pointerdown', view.get('b-a'), 10, 30);
  await view.pointer('pointermove', view.dom.window, 10, 150);
  await view.pointer('pointerup', view.dom.window, 10, 150);
  assert.deepEqual(view.moves, []);
});

test('Alt+ArrowDown moves the focused row one place; plain arrows do nothing', async () => {
  const view = await mount();
  const row = view.get('i-a');
  const key = (init) => view.act(async () => row.dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })));
  await key({ key: 'ArrowDown' });
  assert.deepEqual(view.moves, []);
  await key({ key: 'ArrowDown', altKey: true });
  assert.deepEqual(view.moves, [{ itemId: 'a', sectionId: 'inbox', beforeId: 'c', index: 1 }]);
  await key({ key: 'ArrowUp', altKey: true });
  assert.equal(view.moves.length, 1, 'the first item has nowhere further up');
});
