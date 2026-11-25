// Goal: the editor asks the placement model the same question for every way of putting a node
// on the page, describes the place correctly from the live tree, and finds the nearest valid
// place when the one asked for is invalid (a doctype dropped into a component goes to the top
// of the page; a block dropped into a paragraph goes after it), or says there is none.
// Method: one generated page tree, then each entry shape against it: an existing node moved
// (never into itself, never into the frontmatter), a node about to be made from a palette item,
// and the snap search, each with its refusal reason pinned. Fixtures only, never a real project.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { checkTarget, resolveTarget, snapTarget, placementNodeOfItem, documentOfPath } = load('src/editor/placementCheck.ts');

const element = (id, name, children) => ({ id, kind: 'element', name, children });
const component = (id, name, children) => ({ id, kind: 'component', name, children });
const text = (id, value) => ({ id, kind: 'text', value });

const nodes = [
  { id: 'doctype', kind: 'raw-line', value: '<!doctype html>' },
  component('layout', 'Layout', [
    element('main', 'main', [
      element('p', 'p', [text('t', 'Hello')]),
      element('list', 'ul', [element('item', 'li', [text('i', 'one')])]),
      component('machine', 'MachineMode', []),
      element('link', 'a', [text('l', 'x')]),
      element('wrap', 'div', [element('inner', 'a', [text('l2', 'y')])]),
    ]),
  ]),
];
const environment = {
  insertables: [
    { name: 'MachineMode', renderTag: { tag: 'section' } },
    { name: 'Row', renderTag: { tag: 'li' } },
  ],
  document: 'page',
};
const existing = (id) => ({ kind: 'existing', id });

test('the doctype dropped into a component is refused, and snaps to the top of the page', () => {
  const into = { parentId: 'machine', index: 0 };
  const verdict = checkTarget(nodes, existing('doctype'), into, environment);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'doctype-position');
  assert.equal(verdict.messageKey, 'structure.placement.doctypePosition');
  const resolved = resolveTarget(nodes, existing('doctype'), into, environment);
  assert.equal(resolved.kind, 'snapped');
  assert.deepEqual(resolved.target, { parentId: undefined, index: 0 });
  assert.equal(resolved.reason.reason, 'doctype-position');
});

test('the doctype stays valid at the top, even among its own siblings', () => {
  assert.equal(checkTarget(nodes, existing('doctype'), { parentId: undefined, index: 0 }, environment).ok, true);
  assert.equal(checkTarget(nodes, existing('doctype'), { parentId: undefined, index: 1 }, environment).ok, true);
  assert.equal(checkTarget(nodes, existing('doctype'), { parentId: undefined, index: 2 }, environment).ok, false);
});

test('a new doctype from the palette goes only to the top, and only once', () => {
  const doctype = placementNodeOfItem({ type: 'doctype' }, environment);
  const subject = { kind: 'new', node: doctype };
  assert.equal(checkTarget(nodes, subject, { parentId: 'main', index: 0 }, environment).ok, false);
  const duplicate = checkTarget(nodes, subject, { parentId: undefined, index: 0 }, environment);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.reason, 'doctype-duplicate');
  assert.equal(snapTarget(nodes, subject, { parentId: 'main', index: 0 }, environment), undefined, 'a page that has one has no place for another');
  const bare = [nodes[1]];
  assert.deepEqual(snapTarget(bare, subject, { parentId: 'main', index: 0 }, environment).target, { parentId: undefined, index: 0 });
});

test('a node is never placed inside itself or its own subtree', () => {
  for (const parentId of ['main', 'p', 'list', 'item']) {
    const verdict = checkTarget(nodes, existing('main'), { parentId, index: 0 }, environment);
    assert.equal(verdict.ok, false, parentId);
    assert.equal(verdict.reason, 'self-drop');
  }
  assert.equal(checkTarget(nodes, existing('list'), { parentId: 'list', index: 0 }, environment).reason, 'self-drop');
  assert.equal(checkTarget(nodes, existing('list'), { parentId: 'main', index: 0 }, environment).ok, true);
});

test('the frontmatter and unknown parents are no place for markup', () => {
  assert.equal(checkTarget(nodes, existing('p'), { parentId: 'frontmatter', index: 0 }, environment).reason, 'frontmatter');
  assert.equal(checkTarget(nodes, existing('p'), { parentId: 'missing', index: 0 }, environment).ok, false);
  assert.equal(resolveTarget(nodes, existing('p'), { parentId: 'frontmatter', index: 0 }, environment).kind, 'refused');
  assert.equal(resolveTarget(nodes, existing('main'), { parentId: 'p', index: 0 }, environment).kind, 'refused', 'into itself is refused, not moved');
});

test('a block dropped into a paragraph or a list snaps to just outside it', () => {
  const resolved = resolveTarget(nodes, existing('wrap'), { parentId: 'p', index: 1 }, environment);
  assert.equal(resolved.kind, 'snapped');
  assert.equal(resolved.reason.reason, 'content-model');
  assert.deepEqual(resolved.target, { parentId: 'main', index: 1 });
  const intoList = resolveTarget(nodes, existing('wrap'), { parentId: 'list', index: 0 }, environment);
  assert.equal(intoList.kind, 'snapped');
  assert.equal(intoList.target.parentId, 'main');
});

test('a list item has no valid place on a page outside a list: refused, not snapped', () => {
  const resolved = resolveTarget(nodes, existing('item'), { parentId: 'main', index: 0 }, environment);
  assert.equal(resolved.kind, 'refused');
  assert.equal(resolved.refusal.reason, 'needs-parent');
  // MachineMode renders a section, so a list item is wrong there too.
  assert.notEqual(resolveTarget(nodes, existing('item'), { parentId: 'machine', index: 0 }, environment).kind, 'placed');
});

test('a component is judged by the tag it renders, and warns when it cannot be told', () => {
  const row = placementNodeOfItem({ type: 'component', name: 'Row' }, environment);
  assert.deepEqual(row, { kind: 'component', tag: 'li' });
  assert.equal(checkTarget(nodes, { kind: 'new', node: row }, { parentId: 'main', index: 0 }, environment).ok, false);
  assert.equal(checkTarget(nodes, { kind: 'new', node: row }, { parentId: 'list', index: 0 }, environment).ok, true);
  const unknown = placementNodeOfItem({ type: 'component', name: 'Whatever' }, environment);
  const inList = checkTarget(nodes, { kind: 'new', node: unknown }, { parentId: 'list', index: 0 }, environment);
  assert.equal(inList.ok, true);
  assert.equal(inList.warning.reason, 'unknown-component-child');
});

test('links never nest, including through a moved subtree', () => {
  assert.equal(checkTarget(nodes, existing('link'), { parentId: 'inner', index: 0 }, environment).reason, 'nested-interactive');
  assert.equal(checkTarget(nodes, existing('wrap'), { parentId: 'link', index: 0 }, environment).reason, 'nested-interactive');
  assert.equal(checkTarget(nodes, existing('wrap'), { parentId: 'main', index: 0 }, environment).ok, true);
});

test('palette items map to the nodes they make', () => {
  assert.deepEqual(placementNodeOfItem({ type: 'element', tag: 'li' }, environment), { kind: 'element', tag: 'li' });
  assert.deepEqual(placementNodeOfItem({ type: 'script' }, environment), { kind: 'element', tag: 'script' });
  assert.deepEqual(placementNodeOfItem({ type: 'map' }, environment), { kind: 'code' });
  assert.deepEqual(placementNodeOfItem({ type: 'element', tag: 'slot' }, environment), { kind: 'slot' });
  assert.equal(placementNodeOfItem({ type: 'unknown' }, environment), undefined);
  assert.equal(checkTarget(nodes, { kind: 'new', node: { kind: 'slot' } }, { parentId: 'main', index: 0 }, environment).reason, 'slot-in-page');
  assert.equal(checkTarget(nodes, { kind: 'new', node: { kind: 'slot' } }, { parentId: 'main', index: 0 }, { ...environment, document: 'component' }).ok, true);
});

test('the file kind comes from its path', () => {
  assert.equal(documentOfPath('/p/src/pages/index.astro'), 'page');
  assert.equal(documentOfPath('/p/src/content/post.mdx'), 'page');
  assert.equal(documentOfPath('/p/src/components/Card.astro'), 'component');
  assert.equal(documentOfPath('/p/readme.txt'), 'unknown');
  assert.equal(documentOfPath(undefined), 'unknown');
});
