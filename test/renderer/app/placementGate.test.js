// Goal: every gesture that puts a node somewhere gets one answer from the gate: go ahead where it
// asked, go ahead at the nearest valid place with a note saying so, or stop with the reason; and
// the words for that answer are the catalog's. Method: the gate over a generated tree, for a
// move, a new node and the default end-of-page target, with the notice read back for each.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { gatePlacement, placementNotice } = load('src/app/model/placementGate.ts');

const element = (id, name, children = []) => ({ id, kind: 'element', name, children });
const model = {
  nodes: [
    { id: 'doctype', kind: 'raw-line', value: '<!doctype html>' },
    element('main', 'main', [element('p', 'p'), element('list', 'ul', [element('item', 'li')])]),
  ],
};
const context = { insertables: [], pagePath: '/p/src/pages/index.astro' };
const translate = (key, params) => `${key}:${JSON.stringify(params ?? {})}`;

test('a valid place goes ahead where it asked, without a notice', () => {
  const gate = gatePlacement(model, { kind: 'existing', id: 'p' }, { parentId: 'main', index: 2 }, context);
  assert.equal(gate.kind, 'place');
  assert.deepEqual(gate.target, { parentId: 'main', index: 2 });
  assert.equal(gate.moved, undefined);
  assert.equal(placementNotice(gate, translate), undefined);
});

test('a doctype dropped inside the page goes to the top with a note that says why', () => {
  const gate = gatePlacement(model, { kind: 'existing', id: 'doctype' }, { parentId: 'main', index: 0 }, context);
  assert.equal(gate.kind, 'place');
  assert.deepEqual(gate.target, { parentId: undefined, index: 0 });
  assert.equal(gate.moved.reason, 'doctype-position');
  const notice = placementNotice(gate, translate);
  assert.equal(notice.tone, 'info');
  assert.match(notice.text, /^structure\.placement\.snapped:/);
  assert.match(notice.text, /structure\.placement\.doctypePosition/);
});

test('a list item with no list to go in stops, with the reason as an error', () => {
  const gate = gatePlacement(model, { kind: 'existing', id: 'item' }, { parentId: 'main', index: 0 }, context);
  assert.equal(gate.kind, 'stop');
  assert.equal(gate.refusal.reason, 'needs-parent');
  const notice = placementNotice(gate, translate);
  assert.equal(notice.tone, 'error');
  assert.match(notice.text, /^structure\.placement\.needsParent:/);
});

test('no target means the end of the page, and a second doctype has nowhere to go', () => {
  const gate = gatePlacement(model, { kind: 'new', node: { kind: 'doctype' } }, undefined, context);
  assert.equal(gate.kind, 'stop');
  assert.equal(gate.refusal.reason, 'doctype-duplicate');
  const paragraph = gatePlacement(model, { kind: 'new', node: { kind: 'element', tag: 'p' } }, undefined, context);
  assert.equal(paragraph.kind, 'place');
  assert.deepEqual(paragraph.target, { parentId: undefined, index: 2 });
});
