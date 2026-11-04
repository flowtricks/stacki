// Goal: arrow keys reach ::before and ::after rows in the Navigator. ↓ goes
// to an element's first row (its ::before when it draws one), ← and → treat
// ::before, the children and ::after as siblings, and ↑ goes back to the
// element. Method: a summary element drawing ::after inside a details element
// drawing ::before, walked key by key, then the negative space: no ::before,
// no children, and keys that lead nowhere.
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { navigatorArrowTarget, rowsUnder } = load('src/features/structure/navigatorArrows.ts');

const node = (id, children) => ({ id, kind: 'element', name: 'div', children });
const summary = node('summary', [node('title', [])]);
const body = node('body', []);
const details = node('details', [summary, body]);
const nodes = [details];
const pseudos = new Map([
  ['details', ['before']],
  ['summary', ['after']],
]);
const tree = { childrenOf: (entry) => entry.children ?? [], pseudosOf: (id) => pseudos.get(id) ?? [] };
const found = (id) => {
  if (id === 'details') {
    return { node: details, parent: undefined, siblings: nodes, index: 0 };
  }
  if (id === 'summary' || id === 'body') {
    return { node: id === 'summary' ? summary : body, parent: details, siblings: details.children, index: id === 'summary' ? 0 : 1 };
  }
  return { node: summary.children[0], parent: summary, siblings: summary.children, index: 0 };
};
const step = (key, id, pseudo) => {
  const row = navigatorArrowTarget(key, found(id), pseudo, tree);
  if (row === undefined) {
    return undefined;
  }
  return row.kind === 'node' ? row.node.id : `${row.nodeId}::${row.pseudo}`;
};

// ↓ enters an element at its ::before, or its first child when it has none.
assert.equal(step('ArrowDown', 'details'), 'details::before');
assert.equal(step('ArrowDown', 'summary'), 'title');
assert.equal(step('ArrowDown', 'body'), undefined, 'nothing under an empty element');
assert.equal(step('ArrowDown', 'details', 'before'), undefined, 'nothing under a pseudo-element');
// ← → step through ::before, the children and ::after as siblings.
assert.equal(step('ArrowRight', 'details', 'before'), 'summary');
assert.equal(step('ArrowLeft', 'summary'), 'details::before');
assert.equal(step('ArrowRight', 'summary'), 'body');
assert.equal(step('ArrowRight', 'title'), 'summary::after');
assert.equal(step('ArrowLeft', 'summary', 'after'), 'title');
assert.equal(step('ArrowRight', 'summary', 'after'), undefined, '::after is the last row');
assert.equal(step('ArrowLeft', 'details', 'before'), undefined, '::before is the first row');
// ↑ from a pseudo-element is its own element; from an element, its parent.
assert.equal(step('ArrowUp', 'summary', 'after'), 'summary');
assert.equal(step('ArrowUp', 'summary'), 'details');
assert.equal(step('ArrowUp', 'details'), undefined);
// Rows are listed in tree order, one per child and pseudo-element.
assert.deepEqual(
  rowsUnder(summary, summary.children, ['before', 'after']).map((row) => (row.kind === 'node' ? row.node.id : row.pseudo)),
  ['before', 'title', 'after'],
);
console.log('navigator arrows: ok');
