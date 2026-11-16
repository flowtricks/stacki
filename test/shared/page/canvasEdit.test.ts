// Goal: the edits predicted from a model change are exactly what the writer will produce for nodes that
// keep their place (attributes, words, a tag), fall back to "updating" where only the server knows, never
// invent a change for an unchanged page, and the boundary parser refuses every unsafe shape.
// Method: small trees before and after one gesture each (class, string and bare attributes, removal,
// expression, component props, text, rename, structure), then the single added or removed node an
// undo makes, then known-bad messages.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCanvasEdits, planModelEdits, singleStructuralChange, type EditTreeNode } from '#dist/shared/page/canvasEdit.js';

const pathOf = (id: string): string => `p${id}`;
const node = (id: string, name: string, props: EditTreeNode['props'] = {}, children: EditTreeNode[] | undefined = []): EditTreeNode => ({
  id,
  kind: 'element',
  name,
  props,
  children,
});
const text = (id: string, value: string): EditTreeNode => ({ id, kind: 'text', value });
const plan = (before: EditTreeNode, after: EditTreeNode) => planModelEdits([before], [after], pathOf);

test('a class, a string attribute and a bare attribute are set; a removed one is removed', () => {
  const before = node('a', 'div', { class: { type: 'string', value: 'x' }, title: { type: 'string', value: 't' } });
  const after = node('a', 'div', { class: { type: 'string', value: 'x y' }, hidden: { type: 'bare' } });
  assert.deepEqual(plan(before, after).edits, [
    {
      kind: 'attributes',
      path: 'pa',
      set: [
        ['class', 'x y'],
        ['hidden', ''],
      ],
      remove: ['title'],
    },
  ]);
});

test('an expression on either side is the server’s: the element is marked updating', () => {
  const before = node('a', 'div', { class: { type: 'string', value: 'x' } });
  const after = node('a', 'div', { class: { type: 'expr', value: 'cls' } });
  assert.deepEqual(plan(before, after).edits, [{ kind: 'updating', path: 'pa' }]);
});

test('a component’s props, name or words are updating, never guessed', () => {
  const before: EditTreeNode = { id: 'c', kind: 'component', name: 'Card', props: { size: { type: 'string', value: 's' } }, children: [] };
  assert.deepEqual(plan(before, { ...before, props: { size: { type: 'string', value: 'l' } } }).edits, [{ kind: 'updating', path: 'pc' }]);
  assert.deepEqual(plan(before, { ...before, name: 'Tile' }).edits, [{ kind: 'updating', path: 'pc' }]);
  assert.deepEqual(plan(before, { ...before }).edits, []);
});

test('the words of an element that holds only words, and a renamed tag', () => {
  const before = node('a', 'p', {}, [text('t', 'one')]);
  assert.deepEqual(plan(before, node('a', 'p', {}, [text('t', 'two')])).edits, [{ kind: 'text', path: 'pa', text: 'two' }]);
  assert.deepEqual(plan(before, node('a', 'h2', {}, [text('t', 'one')])).edits, [{ kind: 'tag', path: 'pa', tag: 'h2' }]);
  assert.deepEqual(plan(before, node('a', 'script', {}, [text('t', 'one')])).edits, [{ kind: 'updating', path: 'pa' }], 'a script is never made');
  assert.deepEqual(
    plan(node('a', 'div', {}, [node('b', 'span')]), node('a', 'div', {}, [node('b', 'em')])).edits,
    [{ kind: 'tag', path: 'pb', tag: 'em' }],
    'a child is found too',
  );
});

test('an unchanged page has no edits, and an added or removed node is structural', () => {
  const page = node('a', 'div', { class: { type: 'string', value: 'x' } }, [text('t', 'w')]);
  assert.deepEqual(plan(page, page), { edits: [], structural: false });
  assert.equal(planModelEdits([page], [{ ...page, children: [] }], pathOf).structural, true);
});

test('an undo’s one added or removed node is named, anything more is left to the render', () => {
  const list = node('l', 'ul', {}, [node('a', 'li'), node('b', 'li')]);
  const fewer = node('l', 'ul', {}, [node('a', 'li')]);
  assert.deepEqual(singleStructuralChange([list], [fewer]), { kind: 'removed', id: 'b' });
  const added = singleStructuralChange([fewer], [list]);
  assert.equal(added?.kind, 'added');
  assert.deepEqual(added && added.kind === 'added' ? [added.id, added.parentId, added.index] : [], ['b', 'l', 1]);
  assert.equal(singleStructuralChange([list], [node('l', 'ul', {}, [])]), undefined, 'two removed');
  assert.equal(singleStructuralChange([list], [list]), undefined);
});

test('the parser refuses unsafe and malformed edits', () => {
  assert.deepEqual(parseCanvasEdits([{ kind: 'updating', path: 'p' }]), [{ kind: 'updating', path: 'p' }]);
  const bad: unknown[] = [
    'x',
    [{ kind: 'attributes', path: 'p', set: [['onclick', 'x()']], remove: [] }],
    [{ kind: 'attributes', path: 'p', set: [], remove: ['onclick'] }],
    [{ kind: 'attributes', path: 'p', set: [['a']], remove: [] }],
    [{ kind: 'tag', path: 'p', tag: 'script' }],
    [{ kind: 'tag', path: '', tag: 'p' }],
    [{ kind: 'text', path: 'p', text: 1 }],
    [{ kind: 'other', path: 'p' }],
    Array.from({ length: 65 }, () => ({ kind: 'updating', path: 'p' })),
  ];
  for (const input of bad) {
    assert.equal(parseCanvasEdits(input), undefined, JSON.stringify(input).slice(0, 80));
  }
});
