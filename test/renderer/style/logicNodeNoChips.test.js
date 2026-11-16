// Goal: a node that is not an element has nothing to style, so the Style panel
// shows its empty state for it instead of the chips of whatever element the
// canvas happens to report for its path (src/features/style/model/styleTarget.ts).
//
// Why: the canvas answers "what did this path render" with the first element
// between the node's markers. For a `<Fragment>` holding an `<Icon>` that is the
// icon's `svg.icon.small…`, so the panel showed chips, CSS code and layout for an
// element the Fragment does not have. The same goes for an if/else, a loop, a
// `<slot>` and an expression: logic and structure, not elements.
//
// Method: a tree with one node of each kind. Elements and component instances
// keep their selection; every other kind, and a node the tree no longer has,
// comes back undefined, which is what StylePanel shows as "select an element".
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { styleableSelection } = load('src/features/style/model/styleTarget.ts');

const tree = [
  { id: '0', kind: 'element', name: 'div' },
  { id: '1', kind: 'component', name: 'Icon' },
  { id: '2', kind: 'component', name: 'Fragment' },
  { id: '3', kind: 'element', name: 'Fragment' },
  { id: '4', kind: 'element', name: 'slot' },
  { id: '5', kind: 'cond', children: [{ id: '5.0', kind: 'branch', name: 'if variant === "play"' }] },
  { id: '6', kind: 'map' },
  { id: '7', kind: 'expr', value: 'title' },
  { id: '8', kind: 'text', value: 'hello' },
];
const pick = (id) => styleableSelection({ nodes: tree }, id === undefined ? undefined : { id });

test('an element and a component instance stay selected', () => {
  assert.deepEqual(pick('0'), { id: '0' });
  assert.deepEqual(pick('1'), { id: '1' });
});

test('a Fragment, in either parse kind, has no element to style', () => {
  assert.equal(pick('2'), undefined);
  assert.equal(pick('3'), undefined);
});

test('a slot, an if/else, a branch, a loop and an expression have none either', () => {
  for (const id of ['4', '5', '5.0', '6', '7']) {
    assert.equal(pick(id), undefined, id);
  }
});

test('nothing selected is undefined; a node outside the tree is left to the panel', () => {
  assert.equal(pick(undefined), undefined);
  assert.deepEqual(pick('9.9'), { id: '9.9' });
});

test('text is left to the panel as before', () => {
  assert.deepEqual(pick('8'), { id: '8' });
});
