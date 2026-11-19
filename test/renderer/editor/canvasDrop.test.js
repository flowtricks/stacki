// Goal: the one drop model the canvas and the Navigator draw from (src/editor/canvasDrop.ts, canvasDropView.ts)
// names the right place for every kind of container, draws its line where that place is, refuses what cannot be
// placed with a reason, and does work per pointer move that does not grow with the size of the page.
//
// Method: a page shaped like the Lumos style guide (a section holding a centred column container with a logo, a
// heading, a row of badge and link, an empty box; a loop of cards; an instance of a component without a slot; an
// instance of one with a slot), measured by hand as the frame would report it: each level's box, content box and
// flow, deepest first. Each case puts the pointer somewhere and pins the decision (parent, index, before/after/into,
// no-op), the guide (orientation, position, length, inset) and, through canvasDropView.ts, the verdict, the
// Navigator mark and the rows it opens. Flows other than the page's own (row-reverse, grid, wrap) use small
// synthetic levels. The cost check times the same moves over a small tree and an 8,000-node one in this run and
// compares them, so it holds on any machine; it never reads the wall clock against a fixed number.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { decideCanvasDrop, indexDropTree, lineFor, guideForPlace, edgeBand } = load('src/editor/canvasDrop.ts');
const { dropView, dropActionOf, startDropSession, hostingOf, levelsOfPaths, landing, stickyView, DROP_STICKY_PX, DROP_HOLD_PROBES_MAX } =
  load('src/editor/canvasDropView.ts');
const { publishCanvasDrag, navigatorDragView, selfRefusal } = load('src/editor/canvasDragSession.ts');

const element = (id, name, children = []) => ({ id, kind: 'element', name, children });
const component = (id, name, children = []) => ({ id, kind: 'component', name, children });
const text = (id, value) => ({ id, kind: 'text', value });
const loop = (id, children) => ({ id, kind: 'map', children });

const nodes = [
  element('section', 'section', [
    element('container', 'div', [
      element('logo', 'img'),
      element('heading', 'h1', [text('heading-text', 'Style Guide')]),
      element('row', 'div', [element('badge', 'span', [text('badge-text', 'v2.2.4')]), element('link', 'a', [text('link-text', 'View Docs')])]),
      element('empty', 'div'),
    ]),
    loop('cards', [element('card', 'div', [element('card-title', 'h3', [text('card-text', 'Card')])])]),
    component('instance', 'Badge'),
    component('box', 'Box', [element('boxed', 'p', [text('boxed-text', 'Inside')])]),
  ]),
];
const insertables = [
  { name: 'Badge', slots: [], renderTag: { tag: 'span' } },
  { name: 'Box', slots: ['default'], renderTag: { tag: 'div' } },
];
const environment = { insertables, document: 'page' };
const tree = indexDropTree(nodes, (node) => hostingOf(node, insertables));

const rect = (x, y, width, height) => ({ x, y, w: width, h: height });
// The measured page, in frame pixels. The container is a centred column with 16px padding.
const boxes = {
  section: rect(0, 0, 900, 900),
  container: rect(40, 40, 820, 400),
  containerContent: rect(56, 56, 788, 368),
  logo: rect(370, 56, 160, 40),
  heading: rect(250, 120, 400, 74),
  row: rect(330, 218, 240, 30),
  badge: rect(330, 218, 70, 30),
  link: rect(412, 218, 158, 30),
  empty: rect(300, 272, 300, 40),
  cards: rect(40, 460, 820, 120),
  card: rect(40, 460, 400, 120),
  instance: rect(40, 600, 200, 60),
  box: rect(40, 680, 400, 80),
  boxed: rect(56, 696, 368, 48),
};
const child = (id, index) => ({ id, index, box: boxes[id] });
const containerLevel = {
  id: 'container',
  box: boxes.container,
  content: boxes.containerContent,
  flow: 'column',
  children: [child('logo', 0), child('heading', 1), child('row', 2), child('empty', 3)],
};
const sectionLevel = {
  id: 'section',
  box: boxes.section,
  content: boxes.section,
  flow: 'block',
  children: [child('container', 0), child('cards', 1), child('instance', 2), child('box', 3)],
};
const rootLevel = { id: undefined, box: rect(0, 0, 900, 1000), content: rect(0, 0, 900, 1000), flow: 'block', children: undefined };
const leaf = (id, flow = 'block') => ({ id, box: boxes[id], content: boxes[id], flow, children: [] });
const over = (draggedId, point, levels) => decideCanvasDrop({ tree, draggedId, point, levels });

test('a heading in a column: its top edge band drops before it, the line between the logo and the heading, across the content box', () => {
  const decision = over('empty', { x: 450, y: 122 }, [leaf('heading'), containerLevel, sectionLevel, rootLevel]);
  assert.equal(decision.kind, 'place');
  assert.equal(decision.parentId, 'container');
  assert.equal(decision.index, 1);
  assert.equal(decision.mode, 'before');
  assert.equal(decision.anchorId, 'heading');
  assert.equal(decision.noop, false);
  assert.deepEqual(decision.guide, { kind: 'line', orientation: 'horizontal', x: 56, y: 108, length: 788 });
  assert.deepEqual(decision.parentBox, boxes.container);
});

test('a heading in a column: its bottom edge band drops after it, the line between the heading and the row', () => {
  const decision = over('empty', { x: 450, y: 192 }, [leaf('heading'), containerLevel, sectionLevel, rootLevel]);
  assert.equal(decision.index, 2);
  assert.equal(decision.mode, 'after');
  assert.deepEqual(decision.guide, { kind: 'line', orientation: 'horizontal', x: 56, y: 206, length: 788 });
});

test('the middle of an empty container drops into it, and the placeholder is its content box', () => {
  const decision = over('logo', { x: 450, y: 292 }, [leaf('empty'), containerLevel, sectionLevel, rootLevel]);
  assert.equal(decision.kind, 'place');
  assert.equal(decision.parentId, 'empty');
  assert.equal(decision.index, 0);
  assert.equal(decision.mode, 'into');
  assert.equal(decision.anchorId, undefined);
  assert.deepEqual(decision.guide, { kind: 'empty', box: boxes.empty });
});

test('a row: the right half of the badge drops after it, a vertical line in the gap before the link, as tall as the row', () => {
  const rowLevel = { id: 'row', box: boxes.row, content: boxes.row, flow: 'row', children: [child('badge', 0), child('link', 1)] };
  const decision = over('logo', { x: 395, y: 230 }, [leaf('badge'), rowLevel, containerLevel, sectionLevel, rootLevel]);
  assert.equal(decision.parentId, 'row');
  assert.equal(decision.index, 1);
  assert.equal(decision.mode, 'after');
  assert.deepEqual(decision.guide, { kind: 'line', orientation: 'vertical', x: 406, y: 218, length: 30 });
});

test('a reversed row reads right to left: the left half of a child is after it', () => {
  const left = rect(0, 0, 50, 20);
  const right = rect(60, 0, 50, 20);
  const level = {
    id: 'row',
    box: rect(0, 0, 110, 20),
    content: rect(0, 0, 110, 20),
    flow: 'row-reverse',
    children: [
      { id: 'badge', index: 0, box: right },
      { id: 'link', index: 1, box: left },
    ],
  };
  const decision = over('logo', { x: 70, y: 10 }, [
    { id: 'badge', box: right, content: right, flow: 'block', children: [] },
    level,
    containerLevel,
    sectionLevel,
    rootLevel,
  ]);
  assert.equal(decision.mode, 'after');
  assert.equal(decision.index, 1);
  assert.equal(decision.guide.orientation, 'vertical');
  assert.equal(decision.guide.x, 55);
});

test('a grid: the line stands beside the nearest cell, as tall as that cell', () => {
  const cells = [rect(0, 0, 100, 100), rect(110, 0, 100, 100), rect(0, 110, 100, 100)];
  const level = {
    id: 'container',
    box: rect(0, 0, 210, 210),
    content: rect(0, 0, 210, 210),
    flow: 'grid',
    children: cells.map((box, index) => ({ id: ['logo', 'heading', 'row'][index], index, box })),
  };
  const decision = over('empty', { x: 105, y: 150 }, [level, sectionLevel, rootLevel]);
  assert.equal(decision.kind, 'place');
  assert.equal(decision.parentId, 'container');
  assert.equal(decision.mode, 'into');
  assert.equal(decision.anchorId, 'row');
  assert.equal(decision.index, 3);
  assert.deepEqual(decision.guide, { kind: 'line', orientation: 'vertical', x: 100, y: 110, length: 100 });
});

test('a wrapping row: above a cell row is before, below it is after', () => {
  const level = {
    id: 'row',
    box: rect(0, 0, 200, 60),
    content: rect(0, 0, 200, 60),
    flow: 'wrap',
    children: [
      { id: 'badge', index: 0, box: rect(0, 0, 90, 20) },
      { id: 'link', index: 1, box: rect(0, 30, 90, 20) },
    ],
  };
  const decision = over('logo', { x: 150, y: 40 }, [level, containerLevel, sectionLevel, rootLevel]);
  assert.equal(decision.anchorId, 'link');
  assert.equal(decision.mode, 'into');
  assert.equal(decision.index, 2);
  const above = over('logo', { x: 150, y: 25 }, [level, containerLevel, sectionLevel, rootLevel]);
  // Between the two lines, as near one as the other: after the first is before the second, the same place.
  assert.equal(above.index, 1);
});

test('nested depth: the line is inset to the target container’s content box, not the page', () => {
  const decision = over('empty', { x: 450, y: 60 }, [leaf('logo'), containerLevel, sectionLevel, rootLevel]);
  assert.equal(decision.parentId, 'container');
  assert.equal(decision.guide.x, boxes.containerContent.x);
  assert.equal(decision.guide.length, boxes.containerContent.w);
});

test('a void element never takes a drop inside: its middle drops beside it', () => {
  const decision = over('heading', { x: 450, y: 70 }, [leaf('logo'), containerLevel, sectionLevel, rootLevel]);
  assert.equal(decision.kind, 'place');
  assert.equal(decision.parentId, 'container');
  assert.equal(decision.mode, 'before');
  assert.equal(decision.index, 0);
});

test('the node over itself, or over anything inside it, is no place', () => {
  const self = over('row', { x: 400, y: 230 }, [leaf('row', 'row'), containerLevel, sectionLevel, rootLevel]);
  assert.equal(self.kind, 'self');
  assert.deepEqual(self.box, boxes.row);
  const inside = over('row', { x: 360, y: 230 }, [
    leaf('badge'),
    { ...leaf('row', 'row'), children: [child('badge', 0), child('link', 1)] },
    containerLevel,
    sectionLevel,
    rootLevel,
  ]);
  assert.equal(inside.kind, 'self');
  assert.deepEqual(inside.box, boxes.row);
});

test('the place a node already holds is a no-op on both sides of it', () => {
  const after = over('heading', { x: 450, y: 94 }, [leaf('logo'), containerLevel, sectionLevel, rootLevel]);
  assert.equal(after.index, 1);
  assert.equal(after.noop, true);
  const before = over('heading', { x: 450, y: 220 }, [leaf('row', 'row'), containerLevel, sectionLevel, rootLevel]);
  assert.equal(before.index, 2);
  assert.equal(before.noop, true);
  const elsewhere = over('heading', { x: 450, y: 310 }, [leaf('empty'), containerLevel, sectionLevel, rootLevel]);
  assert.equal(elsewhere.noop, false);
});

test('a new node from the palette is never a no-op', () => {
  const decision = over(undefined, { x: 450, y: 94 }, [leaf('logo'), containerLevel, sectionLevel, rootLevel]);
  assert.equal(decision.kind, 'place');
  assert.equal(decision.noop, false);
});

test('a loop: a drop beside a card lands in the loop’s template and says so', () => {
  const cardsLevel = { id: 'cards', box: boxes.cards, content: boxes.cards, flow: 'row', children: [child('card', 0)] };
  const decision = over('logo', { x: 430, y: 520 }, [leaf('card'), cardsLevel, sectionLevel, rootLevel]);
  assert.equal(decision.parentId, 'cards');
  assert.equal(decision.mode, 'after');
  assert.equal(decision.loop, true);
  const outside = over('logo', { x: 450, y: 194 }, [leaf('heading'), containerLevel, sectionLevel, rootLevel]);
  assert.equal(outside.loop, false);
});

test('an instance of a component without a slot refuses a drop inside, with its reason; its edges drop beside it', () => {
  const middle = over('logo', { x: 140, y: 630 }, [leaf('instance'), sectionLevel, rootLevel]);
  assert.deepEqual(middle, { kind: 'refused', reason: 'no-slot', targetId: 'instance', box: boxes.instance });
  const edge = over('logo', { x: 140, y: 602 }, [leaf('instance'), sectionLevel, rootLevel]);
  assert.equal(edge.kind, 'place');
  assert.equal(edge.mode, 'before');
  assert.equal(edge.parentId, 'section');
});

test('an instance of a component with a slot takes a drop into its slot content', () => {
  const boxLevel = { id: 'box', box: boxes.box, content: rect(56, 696, 368, 48), flow: 'block', children: [child('boxed', 0)] };
  const decision = over('logo', { x: 200, y: 720 }, [boxLevel, sectionLevel, rootLevel]);
  assert.equal(decision.parentId, 'box');
  assert.equal(decision.mode, 'into');
});

test('the page’s root list takes a drop where nothing else is under the pointer', () => {
  const root = { ...rootLevel, children: [{ id: 'section', index: 0, box: boxes.section }] };
  const decision = over('logo', { x: 450, y: 950 }, [root]);
  assert.equal(decision.parentId, undefined);
  assert.equal(decision.index, 1);
});

test('nothing measured is no decision', () => {
  assert.deepEqual(over('logo', { x: 1, y: 1 }, []), { kind: 'none' });
});

test('the edge band is a quarter of the size, at least 4px and at most 16px', () => {
  assert.equal(edgeBand(rect(0, 0, 10, 8), 'block'), 4);
  assert.equal(edgeBand(rect(0, 0, 10, 40), 'block'), 10);
  assert.equal(edgeBand(rect(0, 0, 10, 400), 'column'), 16);
  assert.equal(edgeBand(rect(0, 0, 40, 400), 'row'), 10);
});

test('a guide for a snapped place is drawn only where the levels measured it', () => {
  assert.deepEqual(
    guideForPlace([containerLevel], { parentId: 'container', index: 4 }),
    lineFor(containerLevel, child('empty', 3), 'after', containerLevel.children),
  );
  assert.deepEqual(guideForPlace([{ ...leaf('empty') }], { parentId: 'empty', index: 0 }), { kind: 'empty', box: boxes.empty });
  assert.equal(guideForPlace([containerLevel], { parentId: 'section', index: 0 }), undefined);
});

// --- The view: the verdict, the Navigator's mark and the rows it opens -------------------------------------

const session = (subject) => startDropSession(nodes, subject, environment);
const moving = (id) => ({ kind: 'element', id, label: id });
const view = (subject, point, levels, outside = false) => dropView(session(subject), { levels, pointer: point, dragged: [], outside }, (id) => `path:${id}`);

test('a valid gap: the canvas line, the Navigator gap at the same parent and index, its parent and ancestors opened', () => {
  const result = view(moving('empty'), { x: 450, y: 122 }, [leaf('heading'), containerLevel, sectionLevel, rootLevel]);
  assert.equal(result.verdict.kind, 'valid');
  assert.deepEqual(result.navigator, { kind: 'gap', parentId: 'container', index: 1 });
  assert.deepEqual([...result.expand].sort(), ['container', 'section']);
  assert.equal(result.revealId, 'heading');
  assert.deepEqual(result.parent, { box: boxes.container, path: 'path:container' });
  assert.deepEqual(landing(result.decision, result.verdict), { parentId: 'container', index: 1 });
});

test('an empty container: the Navigator lights the row itself', () => {
  const result = view(moving('logo'), { x: 450, y: 292 }, [leaf('empty'), containerLevel, sectionLevel, rootLevel]);
  assert.deepEqual(result.navigator, { kind: 'into', intoId: 'empty' });
  assert.ok(result.expand.has('empty'));
});

test('a container that cannot take the node takes the drop beside it, by halves, with no snap and no red', () => {
  // A <div> inside an <h1> is reparented by the browser: in the heading's middle the drop goes before or after it.
  const headingLevel = {
    id: 'heading',
    box: boxes.heading,
    content: boxes.heading,
    flow: 'block',
    children: [{ id: 'heading-text', index: 0, box: rect(250, 120, 400, 74) }],
  };
  const upper = view(moving('empty'), { x: 450, y: 150 }, [headingLevel, containerLevel, sectionLevel, rootLevel]);
  assert.equal(upper.verdict.kind, 'valid');
  assert.equal(upper.decision.mode, 'before');
  assert.deepEqual(upper.navigator, { kind: 'gap', parentId: 'container', index: 1 });
  const lower = view(moving('empty'), { x: 450, y: 170 }, [headingLevel, containerLevel, sectionLevel, rootLevel]);
  assert.equal(lower.decision.mode, 'after');
  assert.deepEqual(lower.navigator, { kind: 'gap', parentId: 'container', index: 2 });
});

test('a container holding only words the frame could not box takes the drop beside it, never an empty placeholder', () => {
  const boxLevel = { id: 'boxed', box: boxes.boxed, content: boxes.boxed, flow: 'block', children: [] };
  const boxParent = { id: 'box', box: boxes.box, content: boxes.box, flow: 'block', children: [child('boxed', 0)] };
  const result = view(moving('empty'), { x: 200, y: 710 }, [boxLevel, boxParent, sectionLevel, rootLevel]);
  assert.equal(result.verdict.kind, 'valid');
  assert.notEqual(result.guide.kind, 'empty');
  assert.deepEqual(result.navigator, { kind: 'gap', parentId: 'box', index: 0 });
});

test('the dragged node over itself is refused with the self reason; outside the frame is nothing', () => {
  const self = view(moving('row'), { x: 400, y: 230 }, [leaf('row', 'row'), containerLevel, sectionLevel, rootLevel]);
  assert.deepEqual(self.verdict, { kind: 'refused', reason: { kind: 'self' } });
  assert.equal(self.navigator, undefined);
  assert.equal(self.guide, undefined);
  const outside = view(moving('row'), { x: -10, y: 230 }, [], true);
  assert.deepEqual(outside.verdict, { kind: 'none' });
  assert.equal(landing(outside.decision, outside.verdict), undefined);
});

test('a slotless instance takes the drop beside it; the drop where the node stands is a no-op that writes nothing', () => {
  const beside = view(moving('logo'), { x: 140, y: 620 }, [leaf('instance'), sectionLevel, rootLevel]);
  assert.equal(beside.verdict.kind, 'valid');
  assert.deepEqual(beside.navigator, { kind: 'gap', parentId: 'section', index: 2 });
  const noop = view(moving('heading'), { x: 450, y: 94 }, [leaf('logo'), containerLevel, sectionLevel, rootLevel]);
  assert.deepEqual(noop.verdict, { kind: 'noop' });
});

test('the frame’s paths become ids, and a level the tree lacks is left out', () => {
  const byPath = { 0: 'section', '0.0': 'container', '0.0.1': 'heading', '0.0.0': 'logo' };
  const levels = levelsOfPaths(
    [
      { path: '0.0.1', box: boxes.heading, content: boxes.heading, flow: 'block', children: [] },
      { path: '9.9', box: boxes.row, content: boxes.row, flow: 'block', children: undefined },
      {
        path: '0.0',
        box: boxes.container,
        content: boxes.containerContent,
        flow: 'column',
        children: [
          { path: '0.0.0', box: boxes.logo },
          { path: '0.0.1', box: boxes.heading },
        ],
      },
      { path: '', box: rootLevel.box, content: rootLevel.content, flow: 'block', children: undefined },
    ],
    tree,
    (path) => byPath[path],
  );
  assert.deepEqual(
    levels.map((level) => level.id),
    ['heading', 'container', undefined],
  );
  assert.deepEqual(levels[1].children, [child('logo', 0), child('heading', 1)]);
});

test('the release: a move, an insert, or nothing for a no-op, a refusal and a release over nothing', () => {
  const valid = view(moving('empty'), { x: 450, y: 122 }, [leaf('heading'), containerLevel, sectionLevel, rootLevel]);
  assert.deepEqual(dropActionOf(moving('empty'), valid), { kind: 'move', id: 'empty', place: { parentId: 'container', index: 1 } });
  const noop = view(moving('heading'), { x: 450, y: 94 }, [leaf('logo'), containerLevel, sectionLevel, rootLevel]);
  assert.deepEqual(dropActionOf(moving('heading'), noop), { kind: 'none' });
  const refused = view(moving('row'), { x: 400, y: 230 }, [leaf('row', 'row'), containerLevel, sectionLevel, rootLevel]);
  assert.deepEqual(dropActionOf(moving('row'), refused), { kind: 'none' });
  const outside = view(moving('logo'), { x: -1, y: 0 }, [], true);
  assert.deepEqual(dropActionOf(moving('logo'), outside), { kind: 'none' });
  const fresh = { kind: 'new', label: 'Box', path: '/p/src/components/Box.astro' };
  const inserted = view(fresh, { x: 450, y: 292 }, [leaf('empty'), containerLevel, sectionLevel, rootLevel]);
  assert.deepEqual(dropActionOf(fresh, inserted), { kind: 'insert', component: '/p/src/components/Box.astro', place: { parentId: 'empty', index: 0 } });
});

test('near a boundary the shown place holds until the pointer travels past the sticky distance', () => {
  const levels = [leaf('logo'), containerLevel, sectionLevel, rootLevel];
  const above = view(moving('empty'), { x: 450, y: 74 }, levels); // before the logo, index 0
  const below = view(moving('empty'), { x: 450, y: 78 }, levels); // after the logo, index 1
  assert.notDeepEqual(landing(above.decision, above.verdict), landing(below.decision, below.verdict));
  const shown = stickyView(undefined, above);
  const held = stickyView(shown, below);
  assert.equal(held.view.decision, above.decision, 'a 4px move across the midline keeps the place');
  assert.deepEqual(held.view.pointer, below.pointer, 'the reason chip still follows the pointer');
  const far = view(moving('empty'), { x: 450, y: 74 + DROP_STICKY_PX + 1 }, levels);
  assert.equal(stickyView(held, far).view.decision, far.decision, 'past the distance it switches');
});

test('a held place gives way after its bound of probes, and to a scroll under a still pointer', () => {
  const levels = [leaf('logo'), containerLevel, sectionLevel, rootLevel];
  const above = view(moving('empty'), { x: 450, y: 74 }, levels);
  const below = view(moving('empty'), { x: 450, y: 78 }, levels);
  let shown = stickyView(undefined, above);
  for (let probe = 0; probe < DROP_HOLD_PROBES_MAX; probe++) {
    shown = stickyView(shown, below);
    assert.equal(shown.view.decision, above.decision);
  }
  assert.equal(stickyView(shown, below).view.decision, below.decision);
  const before = { ...above, dragged: [rect(0, 100, 10, 10)] };
  const scrolled = { ...below, dragged: [rect(0, 80, 10, 10)] };
  assert.equal(stickyView(stickyView(undefined, before), scrolled).view.decision, below.decision);
});

test('the Navigator’s slice of the drag is the same object while only the pointer moves', () => {
  const levels = [leaf('heading'), containerLevel, sectionLevel, rootLevel];
  publishCanvasDrag(view(moving('empty'), { x: 450, y: 122 }, levels));
  const first = navigatorDragView();
  publishCanvasDrag(view(moving('empty'), { x: 452, y: 123 }, levels));
  assert.equal(navigatorDragView(), first);
  publishCanvasDrag(view(moving('empty'), { x: 450, y: 192 }, levels));
  assert.notEqual(navigatorDragView(), first);
  publishCanvasDrag(undefined);
  assert.equal(navigatorDragView(), undefined);
});

test('a refusal over the node itself is the one the Navigator keeps quiet about', () => {
  const self = view(moving('row'), { x: 400, y: 230 }, [leaf('row', 'row'), containerLevel, sectionLevel, rootLevel]);
  assert.equal(selfRefusal(self.verdict), true);
  const message = { reason: 'self-drop', messageKey: 'structure.placement.selfDrop', params: {} };
  assert.equal(selfRefusal({ kind: 'refused', reason: { kind: 'placement', message } }), true);
  assert.equal(selfRefusal({ kind: 'refused', reason: { kind: 'placement', message: { ...message, reason: 'content-model' } } }), false);
  assert.equal(selfRefusal({ kind: 'noop' }), false);
});

// --- Cost: the same moves over a small page and an 8,000-node page --------------------------------------------

function bigPage(sectionCount, perSection) {
  const sections = [];
  for (let section = 0; section < sectionCount; section += 1) {
    const children = [];
    for (let i = 0; i < perSection; i += 1) {
      children.push(element(`n-${section}-${i}`, 'div', [text(`t-${section}-${i}`, 'x')]));
    }
    sections.push(element(`s-${section}`, 'section', children));
  }
  return sections;
}

function movesCostMs(page, rounds) {
  const subject = { kind: 'element', id: 'n-0-0', label: 'div' };
  const started = startDropSession(page, subject, environment);
  const levels = [
    { id: 'n-0-1', box: rect(0, 40, 800, 30), content: rect(0, 40, 800, 30), flow: 'block', children: [] },
    {
      id: 's-0',
      box: rect(0, 0, 800, 400),
      content: rect(0, 0, 800, 400),
      flow: 'column',
      children: [0, 1, 2, 3].map((index) => ({ id: `n-0-${index}`, index, box: rect(0, index * 40, 800, 30) })),
    },
    { id: undefined, box: rect(0, 0, 800, 4000), content: rect(0, 0, 800, 4000), flow: 'block', children: undefined },
  ];
  // Warm: the first judgement indexes the tree once per drag, which is not a pointer move.
  dropView(started, { levels, pointer: { x: 10, y: 42 }, dragged: [], outside: false }, () => undefined);
  const begin = process.hrtime.bigint();
  for (let round = 0; round < rounds; round += 1) {
    const y = 40 + (round % 30);
    dropView(started, { levels, pointer: { x: 10, y }, dragged: [], outside: false }, () => undefined);
  }
  return Number(process.hrtime.bigint() - begin) / 1e6;
}

test('a pointer move costs the same on an 8,000-node page as on a 40-node page (relative, measured in this run)', () => {
  const small = bigPage(2, 10); // 40 nodes
  const large = bigPage(40, 100); // 8,000 nodes
  const rounds = 4000;
  // Best of three, against noise from the machine.
  const smallMs = Math.min(movesCostMs(small, rounds), movesCostMs(small, rounds), movesCostMs(small, rounds));
  const largeMs = Math.min(movesCostMs(large, rounds), movesCostMs(large, rounds), movesCostMs(large, rounds));
  // O(depth + siblings): the large page may cost a little more (cache effects), never in proportion to its size (200x).
  assert.ok(largeMs < smallMs * 4 + 5, `8,000 nodes: ${largeMs.toFixed(1)} ms for ${rounds} moves against ${smallMs.toFixed(1)} ms for 40 nodes`);
});
