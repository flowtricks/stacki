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
