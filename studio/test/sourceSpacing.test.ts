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

// The same layout Desktop writes: Studio's palette, component and paste actions all
// reach the shared planner through insertFragment, with a fragment printed at column
// zero, and the first section below grew onto one line before the planner laid it out.
function target(source: string, name: string) {
  const found = flatten(nodesOf(source)).find((node) => node.name === name);
  assert.ok(found?.id);
  return found.id;
}

test('palette elements build a nested structure, one element per line', () => {
  const action = (source: string, name: string, tag: string) =>
    applyEdits(
      source,
      structuralEdits(source, { kind: 'insert-content', target: target(source, name), placement: 'inside', content: { type: 'element', tag } }),
    );
  let source = '<main>\n\t<section></section>\n</main>\n';
  source = action(source, 'section', 'div');
  source = action(source, 'div', 'h2');
  source = action(source, 'div', 'article');
  assert.equal(source, '<main>\n\t<section>\n\t\t<div>\n\t\t\t<h2>Heading</h2>\n\t\t\t<article></article>\n\t\t</div>\n\t</section>\n</main>\n');
});

test('a multi-line fragment is indented where it lands, without a trailing line', () => {
  const spaced = '<main>\n  <header>\n    <h1>a</h1>\n  </header>\n  <section></section>\n</main>\n';
  const edit = insertFragment(spaced, { target: target(spaced, 'section'), placement: 'inside' }, '<div>\n  <p>x</p>\n</div>\n', false);
  assert.equal(
    applyEdits(spaced, [edit]),
    '<main>\n  <header>\n    <h1>a</h1>\n  </header>\n  <section>\n    <div>\n      <p>x</p>\n    </div>\n  </section>\n</main>\n',
  );
});

test('text parents, code and one-line runs stay on their line', () => {
  const into = (source: string, name: string, fragment: string) =>
    applyEdits(source, [insertFragment(source, { target: target(source, name), placement: 'inside' }, fragment, false)]);
  assert.equal(into('<p></p>\n', 'p', '<span>x</span>'), '<p><span>x</span></p>\n');
  assert.equal(into('<code></code>\n', 'code', '<span>x</span>'), '<code><span>x</span></code>\n');
  assert.equal(into('<pre></pre>\n', 'pre', '<div>x</div>'), '<pre><div>x</div></pre>\n');
  assert.equal(into('<p>a <b>b</b></p>\n', 'p', '<i>c</i>'), '<p>a <b>b</b><i>c</i></p>\n');
});

test('a self-closing component gains a child on its own line, and an undo restores the bytes', () => {
  const source = '<main>\n\t<Wrapper />\n</main>\n';
  const edit = insertFragment(source, { target: target(source, 'Wrapper'), placement: 'inside' }, '<p>x</p>', false);
  const written = applyEdits(source, [edit]);
  assert.equal(written, '<main>\n\t<Wrapper>\n\t\t<p>x</p>\n\t</Wrapper>\n</main>\n');
  const undo = { start: edit.start, end: edit.start + edit.text.length, text: source.slice(edit.start, edit.end) };
  assert.equal(applyEdits(written, [undo]), source);
});
