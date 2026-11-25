// Goal: a void element inside a run of text keeps its attributes when the run
// is written, for the file and for the preview. A `<br class="hero_break" />`
// in a heading was written as a bare `<br />`: the class was lost from the
// file on the next rewrite, and in the preview the break carried no path tag,
// so the canvas refused to edit the heading's text. Method: parse a heading
// with a classed `<br>`, write it plainly and marked, and read the tag back;
// the negative space is a bare `<br>`, which stays `<br />`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parsePage, serializePage, serializePageMarked } = require('#dist/electron/parse/astroParser.js');

const heading = '<h1 class="hero_title">\n  Messaging with<br class="hero_break" />\n  actual wings.\n</h1>\n';

// The heading re-read with its words edited, so the run is written from nodes,
// not put back verbatim from its source text.
function edited(source) {
  const parsed = parsePage(source);
  assert.equal(parsed.editable, true);
  const [title] = parsed.model.nodes;
  assert.equal(title.kind, 'element');
  const children = title.children.map((child) =>
    child.kind === 'text' ? { ...child, value: child.value.replace('wings', 'feathers'), source: undefined } : child,
  );
  return { ...parsed.model, nodes: [{ ...title, source: undefined, children }] };
}

test('a classed <br> in a run of text keeps its class when the run is written', () => {
  const written = serializePage(edited(heading));
  assert.match(written, /<br class="hero_break" \/>/);
  assert.match(written, /actual feathers\./);
});

test('the preview tags a <br> in a run of text with its path, beside its class', () => {
  const marked = serializePageMarked(parsePage(heading).model);
  const tag = /<br[^>]*>/.exec(marked)?.[0] ?? '';
  assert.match(tag, /class="hero_break"/);
  assert.match(tag, /data-avb-p="0\.1"/, `the break carries its path: ${tag}`);
});

test('a bare <br> is still written as <br />', () => {
  const written = serializePage(edited('<p>One<br />two wings</p>\n'));
  assert.match(written, /One<br \/>two feathers/);
});
