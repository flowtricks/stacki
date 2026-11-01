// Goal: repeated structural edits do not accumulate blank lines or alter authored content.
// Method: round-trip real Astro through Desktop's shared planner using Studio's edit API,
// including CRLF, Unicode, inline markup, comments and whitespace-sensitive descendants.
import { structuralEdits, insertFragment } from '../src/features/source/sourceOperations';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdits, flatten, nodesOf } from '../src/features/source/source';

function buttons(source: string) {
  const nodes = flatten(nodesOf(source)).filter((node) => node.name === 'Button');
  const first = nodes[0];
  const second = nodes[1];
  assert.ok(first?.id);
  assert.ok(second?.id);
  return { first: first.id, second: second.id };
}

for (const separator of ['\n', '\r\n', '']) {
  const original = [
    '<main>',
    '  <Button><strong>Choose 🌱</strong> a campus</Button>',
    '  <Button>Plan your visit</Button>',
    '  <!-- Keep this comment. -->',
    '  <pre>  Keep\n\n\nthese spaces  </pre>',
    '</main>',
  ].join(separator);
  test(`moves and duplicate/delete preserve spacing (${JSON.stringify(separator)})`, () => {
    let source = original;
    for (let index = 0; index < 40; index++) {
      const { first, second } = buttons(source);
      source = applyEdits(
        source,
        structuralEdits(source, {
          kind: 'move',
          node: second,
          target: first,
          placement: 'before',
        }),
      );
    }
    assert.equal(source, original, 'Reordering back and forth leaves exact original bytes');
    source = applyEdits(
      source,
      structuralEdits(source, {
        kind: 'duplicate',
        node: buttons(source).first,
      }),
    );
    source = applyEdits(
      source,
      structuralEdits(source, {
        kind: 'delete',
        node: buttons(source).second,
      }),
    );
    assert.equal(source, original, 'Duplicate/delete does not leave a blank separator behind');
  });
}

test('insertions use existing indentation and preserve unrelated blank lines', () => {
  const source = '<main>\n  <Button>First</Button>\n  <Button>Second</Button>\n</main>\n\n<!-- End -->';
  const edit = insertFragment(
    source,
    {
      target: buttons(source).first,
      placement: 'after',
    },
    '<mark>New</mark>',
    false,
  );
  const result = applyEdits(source, [edit]);
  assert.equal(result, source.replace('</Button>\n', '</Button>\n  <mark>New</mark>\n'));
});
