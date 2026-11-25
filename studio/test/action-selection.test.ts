import assert from 'node:assert/strict';
import test from 'node:test';
import { actionSelection } from '../src/features/navigator/actionSelection';
import { dropTarget } from '../src/features/navigator/dropTarget';
import { structuralEdits } from '../src/features/source/sourceOperations';
import { applyEdits, nodesOf, type TreeAction } from '../src/features/source/source';

function selection(source: string, action: TreeAction) {
  const edits = structuralEdits(source, action, 'src/pages/index.astro');
  return actionSelection(source, applyEdits(source, edits), edits, action);
}
const source = '<main><h1>First</h1><p>Second</p><button>Last</button></main>';
test('duplicate selects its clone and remaps other collaborators to the same original node', () => {
  const select = selection(source, { kind: 'duplicate', node: 'n0.0' });
  assert.equal(select('n0.0', true), 'n0.1');
  assert.equal(select('n0.0', false), 'n0.0');
  assert.equal(select('n0.1', false), 'n0.2');
});
test('deletion uses Stacki next, previous, parent, then empty selection rules', () => {
  assert.equal(selection(source, { kind: 'delete', node: 'n0.1' })('n0.1', true), 'n0.1');
  assert.equal(selection(source, { kind: 'delete', node: 'n0.2' })('n0.2', true), 'n0.1');
  assert.equal(selection('<main><h1>Only</h1></main>', { kind: 'delete', node: 'n0.0' })('n0.0', true), 'n0');
  assert.equal(selection('<h1>Only</h1>', { kind: 'delete', node: 'n0' })('n0', true), '');
  assert.equal(selection(source, { kind: 'delete', node: 'n0.0' })('n0.2', true), 'n0.1');
});
test('inserting a component selects it even when an import is added ahead of the page', () => {
  const select = selection(source, {
    kind: 'insert',
    target: 'n0',
    name: 'Section',
    importPath: '../components/Section.astro',
    paired: false,
  });
  assert.equal(select('n0', true), 'n0.3');
  assert.equal(select('n0.1', false), 'n0.1');
});
test('an empty container receives appended children and selects the new child', () => {
  const source = "---\nimport Section from '../components/Section.astro';\n---\n<main><Section /></main>";
  const target = dropTarget(nodesOf(source), { parentId: 'n0.0', index: 0 });
  assert.deepEqual(target, { target: 'n0.0', placement: 'inside' });
  const select = selection(source, {
    kind: 'insert',
    ...target,
    name: 'Heading',
    importPath: '../components/Heading.astro',
    paired: true,
  });
  assert.equal(select('n0.0', true), 'n0.0.0');
  assert.equal(select('n0.0', false), 'n0.0');
});
test('moving keeps the moved node selected and remaps adjacent selections', () => {
  const select = selection(source, {
    kind: 'move',
    node: 'n0.2',
    target: 'n0.0',
    placement: 'before',
  });
  assert.equal(select('n0.2', true), 'n0.0');
  assert.equal(select('n0.0', false), 'n0.1');
});

test('conditional branches and their first elements keep distinct collaborator selections', () => {
  const page = '<main><p>Before</p>{show && <div><p>Inside</p></div>}</main>';
  const select = selection(page, { kind: 'duplicate', node: 'n0.0' });
  assert.equal(select('n0.1.0', false), 'n0.2.0');
  assert.equal(select('n0.1.0.0', false), 'n0.2.0.0');
});
test('converting a run selects the new element, even behind the blank run its line break leaves', () => {
  const words = (text: string) => {
    const select = selection(text, { kind: 'wrap-text', node: 'n0.1', name: 'span' });
    return select('n0.1', true);
  };
  assert.equal(words('<code><br /> two<br />three</code>'), 'n0.1');
  assert.equal(words('<section><b>x</b>\n  words\n  <i>y</i></section>'), 'n0.2');
  const after = applyEdits(
    '<section><b>x</b>\n  words\n  <i>y</i></section>',
    structuralEdits('<section><b>x</b>\n  words\n  <i>y</i></section>', { kind: 'wrap-text', node: 'n0.1', name: 'span' }),
  );
  assert.equal(nodesOf(after)[0]?.children?.[2]?.name, 'span');
  // Another editor's selection stays on its own node, which the run's tags moved along.
  const other = selection('<section><b>x</b>\n  words\n  <i>y</i></section>', { kind: 'wrap-text', node: 'n0.1', name: 'span' });
  assert.equal(other('n0.2', false), 'n0.4');
});

// A move on a page laid out over lines: the moved node keeps the selection at its new
// path, whatever blank text or label comment travels or is left around it.
const LINED = `---
import Heading from '../components/Heading.astro';
import Paragraph from '../components/Paragraph.astro';
import Section from '../components/Section.astro';
---
<main>
  <Section>
    <Heading>Title</Heading>
    <Paragraph>Body</Paragraph>
  </Section>

  {/* ---------------------------- Features */}
  <Section id="features">
    <Paragraph>More</Paragraph>
  </Section>
</main>
`;
function idWhere(text: string, match: (node: ReturnType<typeof nodesOf>[number]) => boolean): string {
  const pending = [...nodesOf(text)];
  for (let index = 0; index < pending.length && index < 1000; index++) {
    const node = pending[index];
    assert.ok(node !== undefined);
    if (match(node)) {
      return node.id ?? '';
    }
    pending.push(...(node.children ?? []));
  }
  return '';
}
function movedSelection(text: string, action: Extract<TreeAction, { kind: 'move' }>) {
  const edits = structuralEdits(text, action, 'src/pages/index.astro');
  const after = applyEdits(text, edits);
  return { after, select: actionSelection(text, after, edits, action) };
}
test('a paragraph moved above its sibling heading stays selected at its new path', () => {
  const paragraph = idWhere(LINED, (node) => node.name === 'Paragraph');
  const heading = idWhere(LINED, (node) => node.name === 'Heading');
  const { after, select } = movedSelection(LINED, { kind: 'move', node: paragraph, target: heading, placement: 'before' });
  const now = idWhere(after, (node) => node.name === 'Paragraph');
  assert.equal(select(paragraph, true), now);
  assert.equal(
    select(heading, false),
    idWhere(after, (node) => node.name === 'Heading'),
    'another editor keeps the heading',
  );
});
test('a labelled section moved above its sibling stays selected, not its label', () => {
  const features = idWhere(LINED, (node) => node.props?.['id']?.type === 'string');
  const first = idWhere(LINED, (node) => node.name === 'Section');
  const { after, select } = movedSelection(LINED, { kind: 'move', node: features, target: first, placement: 'before' });
  assert.equal(
    select(features, true),
    idWhere(after, (node) => node.props?.['id']?.type === 'string'),
  );
  assert.ok(after.indexOf('Features') < after.indexOf('<Section id="features">'), 'its label moved with it');
});
test('a node moved into another parent stays selected', () => {
  const paragraph = idWhere(LINED, (node) => node.name === 'Paragraph');
  const features = idWhere(LINED, (node) => node.props?.['id']?.type === 'string');
  const { after, select } = movedSelection(LINED, { kind: 'move', node: paragraph, target: features, placement: 'inside' });
  const moved = idWhere(after, (node) => node.name === 'Paragraph' && (node.children ?? []).some((child) => child.value === 'Body'));
  assert.ok(moved.length > 0);
  assert.equal(select(paragraph, true), moved);
});
