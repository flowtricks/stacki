// Goal: the stand-in a palette pick draws on the canvas is built from what the writer emits, goes
// where the page will put the node, and is never drawn for a node or a place the canvas cannot
// predict. Method: a small tree with ids and canvas paths; one table of plans (before, after,
// inside, the root list, a component's scope), then the negative space (script, handlers,
// loops, text neighbours, bounds), the renumbering of every path from the gap on, and the boundary
// parser against each known-bad shape.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CANVAS_INSERT_LIMITS,
  insertedNodeToken,
  parseCanvasInsert,
  planCanvasInsert,
  renumberedInsertPath,
  type CanvasInsertTreeNode,
} from '#dist/shared/page/canvasInsert.js';

const leaf = (id: string, kind = 'element'): CanvasInsertTreeNode => ({ id, kind });
const tree: readonly CanvasInsertTreeNode[] = [
  { id: 'main', kind: 'element', children: [leaf('a'), leaf('note', 'comment'), leaf('b'), leaf('words', 'text')] },
  { id: 'empty', kind: 'element', children: [] },
  { id: 'loop', kind: 'map', children: [leaf('item')] },
  { id: 'card', kind: 'component', children: [] },
];
const PATHS = new Map([
  ['main', '0'],
  ['a', '0.0'],
  ['note', '0.1'],
  ['b', '0.2'],
  ['words', '0.3'],
  ['empty', '1'],
  ['loop', '2'],
  ['item', '2.0'],
  ['card', '3'],
]);
const pathOf = (id: string): string | undefined => PATHS.get(id);
const paragraph = { kind: 'element', name: 'p', props: {}, children: [{ kind: 'text', value: 'Paragraph' }] };

test('a node lands before the next element sibling, or after the previous one past a comment', () => {
  const before = planCanvasInsert(tree, { parentId: 'main', index: 0 }, paragraph, pathOf);
  assert.deepEqual(before?.anchor, { path: [0, 0], placement: 'before' });
  assert.equal(before?.index, 0);
  assert.deepEqual(before?.parent, [0]);
  const between = planCanvasInsert(tree, { parentId: 'main', index: 2 }, paragraph, pathOf);
  assert.deepEqual(between?.anchor, { path: [0, 2], placement: 'before' }, 'the comment is skipped, not stood beside');
  const afterGap = planCanvasInsert(tree, { parentId: 'main', index: 1 }, paragraph, pathOf);
  assert.deepEqual(afterGap?.anchor, { path: [0, 2], placement: 'before' });
  const trailing = planCanvasInsert(tree, { parentId: 'main', index: 3 }, paragraph, pathOf);
  assert.deepEqual(trailing?.anchor, { path: [0, 2], placement: 'after' }, 'text next to the gap is not an anchor; the element before it is');
});

test('the element stand-in carries the template: tag, string attributes and starting words', () => {
  const plan = planCanvasInsert(
    tree,
    { parentId: 'main', index: 0 },
    {
      kind: 'element',
      name: 'a',
      props: { href: { type: 'string', value: '#' }, title: { type: 'expr', value: 'x' } },
      children: [{ kind: 'text', value: 'Link' }],
    },
    pathOf,
  );
  assert.deepEqual(plan?.node, { kind: 'element', tag: 'a', attributes: [['href', '#']], text: 'Link' });
  const image = planCanvasInsert(tree, { parentId: 'main', index: 0 }, { kind: 'element', name: 'img', props: {}, children: undefined }, pathOf);
  assert.deepEqual(image?.node, { kind: 'element', tag: 'img', attributes: [], text: undefined });
});

test('a component is a labelled block, and only a legal name is one', () => {
  const plan = planCanvasInsert(tree, { parentId: 'main', index: 0 }, { kind: 'component', name: 'Section', props: {} }, pathOf);
  assert.deepEqual(plan?.node, { kind: 'component', name: 'Section' });
  assert.equal(planCanvasInsert(tree, { parentId: 'main', index: 0 }, { kind: 'component', name: 'a b', props: {} }, pathOf), undefined);
});

test('an empty element takes its first child inside; an empty component or loop is left to the render', () => {
  const inside = planCanvasInsert(tree, { parentId: 'empty', index: 0 }, paragraph, pathOf);
  assert.deepEqual(inside?.anchor, { path: [1], placement: 'inside' });
  assert.equal(planCanvasInsert(tree, { parentId: 'card', index: 0 }, paragraph, pathOf), undefined);
  assert.equal(planCanvasInsert(tree, { parentId: 'loop', index: 0 }, paragraph, pathOf), undefined);
});

test('the root list stands beside a root sibling, in the scope of that sibling', () => {
  const scoped = new Map([...PATHS].map(([id, path]) => [id, `src/Card.astro|${path}`]));
  const plan = planCanvasInsert(tree, { parentId: undefined, index: 4 }, paragraph, (id) => scoped.get(id));
  assert.equal(plan?.scope, 'src/Card.astro|');
  assert.deepEqual(plan?.anchor, { path: [3], placement: 'after' });
  assert.deepEqual(plan?.parent, []);
});

test('negative space: nothing is drawn for what a stand-in cannot be', () => {
  const place = { parentId: 'main', index: 0 };
  for (const name of ['script', 'style', 'iframe', 'link', 'meta', 'svg', 'body', 'slot', 'Bad', 'a b']) {
    assert.equal(planCanvasInsert(tree, place, { kind: 'element', name, props: {}, children: [] }, pathOf), undefined, name);
  }
  const handler = { kind: 'element', name: 'div', props: { onclick: { type: 'string', value: 'x()' } }, children: [] };
  assert.equal(planCanvasInsert(tree, place, handler, pathOf), undefined, 'a handler never runs on a stand-in');
  const marked = { kind: 'element', name: 'div', props: { 'data-avb-p': { type: 'string', value: '9' } }, children: [] };
  assert.equal(planCanvasInsert(tree, place, marked, pathOf), undefined, 'the frame writes its own marks');
  const nested = { kind: 'element', name: 'div', props: {}, children: [{ kind: 'element', value: undefined }] };
  assert.equal(planCanvasInsert(tree, place, nested, pathOf), undefined, 'children beyond the starting words are the render’s');
  const long = { kind: 'element', name: 'p', props: {}, children: [{ kind: 'text', value: 'x'.repeat(CANVAS_INSERT_LIMITS.textCharsMax + 1) }] };
  assert.equal(planCanvasInsert(tree, place, long, pathOf), undefined);
  assert.equal(planCanvasInsert(tree, { parentId: 'missing', index: 0 }, paragraph, pathOf), undefined);
  assert.equal(planCanvasInsert(tree, place, { kind: 'text', name: undefined }, pathOf), undefined);
  assert.equal(
    planCanvasInsert(tree, place, paragraph, () => undefined),
    undefined,
    'no path, no stand-in',
  );
});

test('paths from the gap on move down one; earlier ones, other parents and other files do not', () => {
  const insert = { scope: '', parent: [0], index: 1 };
  assert.equal(renumberedInsertPath('0.0', insert), '0.0');
  assert.equal(renumberedInsertPath('0.1', insert), '0.2');
  assert.equal(renumberedInsertPath('0.2.4.1', insert), '0.3.4.1');
  assert.equal(renumberedInsertPath('0', insert), '0', 'the parent itself keeps its path');
  assert.equal(renumberedInsertPath('1.1', insert), '1.1');
  assert.equal(renumberedInsertPath('src/Card.astro|0.1', insert), 'src/Card.astro|0.1');
  assert.equal(renumberedInsertPath('not-a-path', insert), 'not-a-path');
  const scoped = { scope: 'src/Card.astro|', parent: [], index: 0 };
  assert.equal(renumberedInsertPath('src/Card.astro|0', scoped), 'src/Card.astro|1');
  assert.equal(insertedNodeToken(insert), '0.1');
  assert.equal(insertedNodeToken(scoped), 'src/Card.astro|0');
});

test('the boundary parser takes a plan and refuses every known-bad shape', () => {
  const plan = planCanvasInsert(tree, { parentId: 'main', index: 0 }, paragraph, pathOf);
  assert.deepEqual(parseCanvasInsert(JSON.parse(JSON.stringify(plan))), plan);
  const bad: unknown[] = [
    undefined,
    [],
    {},
    { ...plan, scope: 'no-bar' },
    { ...plan, index: -1 },
    { ...plan, index: 1.5 },
    { ...plan, parent: [-1] },
    { ...plan, parent: 'x' },
    { ...plan, anchor: { path: [], placement: 'before' } },
    { ...plan, anchor: { path: [0], placement: 'under' } },
    { ...plan, node: { kind: 'element', tag: 'script', attributes: [], text: undefined } },
    { ...plan, node: { kind: 'element', tag: 'p', attributes: [['onclick', 'x']], text: undefined } },
    { ...plan, node: { kind: 'element', tag: 'img', attributes: [], text: 'words' } },
    { ...plan, node: { kind: 'element', tag: 'p', attributes: [['a']], text: undefined } },
    { ...plan, node: { kind: 'component', name: '' } },
    { ...plan, node: { kind: 'other' } },
  ];
  for (const input of bad) {
    assert.equal(parseCanvasInsert(input), undefined, JSON.stringify(input));
  }
});
