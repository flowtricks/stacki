// Goal: a tile dragged from the Add elements panel is placed by the same rule as every other drop. Over the
// Navigator its drag reads as a new node of the tile's kind, so a valid place takes it and an invalid one does
// not; the drop carries a parsed choice or nothing; and over the canvas the release inserts that choice, never a
// component of the same name.
// Methodology: pure calls only. parseNavigatorDrop reads stub DataTransfer getters holding a good insert payload,
// a bad one (alone and beside a node id), and none; dropPlacement is asked about an <li> and a <div> inside a <ul>
// and about drags it knows nothing of; startDropSession and dropActionOf are given a new subject with a choice.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule');
const { parseNavigatorDrop } = loadRenderer('src/features/structure/navigatorDrop.ts');
const { dropPlacement, dragSubject } = loadRenderer('src/features/structure/dropPlacement.ts');
const { dropActionOf, startDropSession } = loadRenderer('src/editor/canvasDropView.ts');
const { insertDragText } = loadRenderer('src/editor/insertDragData.ts');

const transfer = (data) => (type) => data[type] ?? '';
const element = (id, name, children = []) => ({ id, kind: 'element', name, props: {}, children });
const nodes = [element('main', 'main', [element('list', 'ul', [element('item', 'li')]), element('after', 'section')])];
const environment = { insertables: [], document: 'page' };
const insertDrag = (choice) => ({ kind: 'insert', choice, label: 'tile' });

test('an Add elements payload parses to its choice; a bad one is no drop, even beside a node id', () => {
  const text = insertDragText({ type: 'element', tag: 'li' });
  assert.deepEqual(parseNavigatorDrop(transfer({ 'avb/insert': text })), { kind: 'insert', choice: { type: 'element', tag: 'li' } });
  assert.equal(parseNavigatorDrop(transfer({ 'avb/insert': '{"type":"element","tag":"blink"}' })), undefined);
  assert.equal(parseNavigatorDrop(transfer({ 'avb/insert': 'not json', 'avb/node': 'item' })), undefined, 'meant as an insert, so not read as a move');
  assert.equal(parseNavigatorDrop(transfer({})), undefined);
  assert.deepEqual(
    parseNavigatorDrop(transfer({ 'avb/component': 'Hero', 'avb/insert': text })),
    { kind: 'component', name: 'Hero' },
    'the palette’s type is read first, as before',
  );
});

test('the Navigator places a dragged tile by the placement rule', () => {
  assert.deepEqual(dragSubject(insertDrag({ type: 'element', tag: 'li' }), environment), { kind: 'new', node: { kind: 'element', tag: 'li' } });
  const intoList = { parentId: 'list', index: 1 };
  assert.equal(dropPlacement(nodes, insertDrag({ type: 'element', tag: 'li' }), intoList, environment).kind, 'valid', 'an <li> goes into a <ul>');
  assert.notEqual(dropPlacement(nodes, insertDrag({ type: 'element', tag: 'div' }), intoList, environment).kind, 'valid', 'a <div> does not');
  assert.equal(dropPlacement(nodes, insertDrag({ type: 'map' }), { parentId: 'main', index: 0 }, environment).kind, 'valid', 'a loop goes into <main>');
  assert.equal(dropPlacement(nodes, undefined, intoList, environment).kind, 'open', 'a drag it knows nothing of is left to the browser');
});

test('a canvas release inserts the tile’s choice, and the session places it as that node', () => {
  const choice = { type: 'element', tag: 'section' };
  const subject = { kind: 'new', label: 'Section', choice };
  const session = startDropSession(nodes, subject, { ...environment, insertables: [] });
  assert.deepEqual(session.placement, { kind: 'new', node: { kind: 'element', tag: 'section' } }, 'placed as a <section>, not a component called Section');
  const place = { kind: 'place', parentId: 'main', index: 1 };
  assert.deepEqual(dropActionOf(subject, { decision: place, verdict: { kind: 'valid', warning: undefined } }), {
    kind: 'insertChoice',
    choice,
    place: { parentId: 'main', index: 1 },
  });
  assert.deepEqual(dropActionOf(subject, { decision: place, verdict: { kind: 'none' } }), { kind: 'none' }, 'over nothing, nothing is written');
  const component = { kind: 'new', label: 'Hero' };
  assert.deepEqual(dropActionOf(component, { decision: place, verdict: { kind: 'valid', warning: undefined } }), {
    kind: 'insert',
    component: 'Hero',
    place: { parentId: 'main', index: 1 },
  });
});
