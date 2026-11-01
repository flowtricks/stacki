// Goal: Navigator traversal follows the rows users see and cannot recurse
// forever through malformed live trees. Methodology: exercise conditional
// projection, raw-tree lookup, ancestor/collapse state, then cross both bounds.
const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../../helpers/rendererModule')('src/features/structure/structureModel.ts');

const element = (id, children = []) => ({
  id,
  kind: 'element',
  name: 'div',
  children,
});

test('Navigator traversal follows visible conditional rows and raw ownership', () => {
  const child = element('child');
  const branch = { id: 'then', kind: 'branch', name: 'then', children: [child] };
  const condition = {
    id: 'condition',
    kind: 'cond',
    op: '&&',
    test: 'ready',
    children: [branch],
  };
  const root = element('root', [condition]);

  assert.equal(model.navigatorChildren(condition)[0], child);
  assert.equal(model.navigatorHost(condition), branch);
  assert.equal(model.findNavigatorNode([root], 'then'), branch);
  assert.deepEqual(model.navigatorAncestors([root], 'child'), [root, condition]);
  assert.deepEqual(model.findVisibleNode([root], 'child'), {
    node: child,
    parent: condition,
    siblings: [child],
    index: 0,
  });
  assert.deepEqual(
    [...model.collapseMap([root], { collapsed: true })],
    [
      ['root', true],
      ['condition', true],
    ],
  );
});

test('Navigator opens only the first expandable root and skips non-expandable rows', () => {
  const section = {
    ...element('section', [element('content')]),
    kind: 'component',
    name: 'Section',
  };
  const layout = { ...element('layout', [section]), kind: 'component', name: 'BaseLayout' };
  const sibling = { ...layout, id: 'sibling', name: 'OtherLayout' };
  const raw = { id: 'style', kind: 'raw', name: 'style', inner: '' };
  const text = { id: 'text', kind: 'text', value: 'Introduction' };
  const paragraph = element('paragraph', [text]);
  assert.deepEqual([...model.initialCollapseMap([raw, paragraph, layout, sibling])], [['layout', false]]);
  assert.deepEqual([...model.initialCollapseMap([element('main', [section])])], [['main', false]]);
  assert.deepEqual([...model.initialCollapseMap([raw, paragraph])], []);
  assert.deepEqual([...model.initialCollapseMap([])], []);
  assert.equal(model.defaultCollapsed(section), true, 'nested components retain their default');
  assert.throws(() => model.initialCollapseMap(Array.from({ length: 20_001 }, () => raw)), /root node limit/);
});

test('Navigator traversals reject excessive width, depth, and cycles', () => {
  const wide = Array.from({ length: 20_001 }, (_, index) => element(`node-${index}`));
  assert.throws(() => model.findNavigatorNode(wide, 'missing'), /node limit/);

  let deep = element('leaf');
  for (let depth = 0; depth < 66; depth += 1) {
    deep = element(`depth-${depth}`, [deep]);
  }
  assert.throws(() => model.navigatorAncestors([deep], 'missing'), /depth limit/);

  const cyclic = element('cycle');
  cyclic.children.push(cyclic);
  assert.throws(() => model.collapseMap([cyclic], { collapsed: false }), /depth limit/);
});
