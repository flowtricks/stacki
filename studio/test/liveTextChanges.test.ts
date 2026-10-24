// Goal: the immediate text preview cannot attach moved labels to old component props.
// Method: compare real parser snapshots for text edits, reorder/undo, and non-text
// changes, including equal-shaped siblings and incomplete source locations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasOnlyLiteralTextChanges } from '../src/features/preview/liveTextChanges';
import { nodesOf, applyEdits, structuralEdits } from '../src/features/source/source';

const source =
  '<main><Button variant="primary">Choose a campus</Button>' +
  '<Button variant="secondary">Plan your visit</Button></main>';
const snapshot = (source: string) => ({ source, nodes: nodesOf(source) });

test('moving equal-shaped buttons and undoing must use the complete Astro render', () => {
  const before = snapshot(source);
  const moved = applyEdits(
    source,
    structuralEdits(source, {
      kind: 'move',
      node: 'n0.1',
      target: 'n0.0',
      placement: 'before',
    }),
  );
  const after = snapshot(moved);
  assert.equal(hasOnlyLiteralTextChanges(before, after), false);
  assert.equal(hasOnlyLiteralTextChanges(after, before), false);
  // Whitespace is not the reason: hand-written swaps with identical formatting
  // must be rejected too, including changes received from a collaborator.
  assert.equal(
    hasOnlyLiteralTextChanges(
      before,
      snapshot(
        '<main><Button variant="secondary">Plan your visit</Button>' +
          '<Button variant="primary">Choose a campus</Button></main>',
      ),
    ),
    false,
  );
});

test('literal typing, entities and sequential edits retain the immediate path', () => {
  const before = snapshot(source);
  const after = snapshot(source.replace('Choose a campus', 'Come &amp; visit'));
  assert.equal(hasOnlyLiteralTextChanges(before, after), true);
  assert.equal(
    hasOnlyLiteralTextChanges(
      after,
      snapshot(after.source.replace('Plan your visit', 'Visit today')),
    ),
    true,
  );
});

test('prop, tag, expression, import and structural edits invalidate pending text', () => {
  for (const after of [
    source.replace('primary', 'secondary'),
    source.replace('Choose a campus', '{label}'),
    source.replaceAll('Button', 'Link'),
    source.replace('</main>', '<p>Added</p></main>'),
    '---\nimport Button from "./Other.astro";\n---\n' + source,
  ]) {
    assert.equal(hasOnlyLiteralTextChanges(snapshot(source), snapshot(after)), false);
  }
  const missingRange = { source, nodes: [{ kind: 'text' as const, id: 'n0', value: 'x' }] };
  assert.equal(hasOnlyLiteralTextChanges(missingRange, missingRange), false);
});
