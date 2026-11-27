// Goal: keep code, navigator, and canvas selection on one source-range model.
// Methodology: parse a real Astro file with offsets, then exercise selection,
// component links, nested hit-testing, text inside tags, frontmatter,
// invalid-range edges, and the exact code a refusal's 'Show in code' points at.

const assert = require('node:assert/strict');
const path = require('node:path');
const esbuild = require('esbuild');
const { parsePage } = require('#dist/electron/parse/astroParser.js');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/code-panel-model.cjs');

// Every kind of selection gives its own whole code as written: the instance picked among look-alikes, with all its
// children; a slot; bare text without the line breaks around it; a loop, a condition and what is inside them; the
// page's root. Each is named for the "+" menu by its component or tag.
function everyKindOfSelection(modelTools) {
  const source = [
    '<html lang="en">',
    '  <Section>',
    '    <p>one</p>',
    '  </Section>',
    '  <Section>',
    '    <slot name="aside"><b>none</b></slot>',
    '    {items.map((item) => (',
    '      <li>{item}</li>',
    '    ))}',
    '    {open && <i>yes</i>}',
    '    <em>',
    '      loose words',
    '    </em>',
    '  </Section>',
    '</html>',
    '',
  ].join('\n');
  const model = parsePage(source, { locs: true }).model;
  const [html] = model.nodes;
  const sections = html.children.filter((node) => node.name === 'Section');
  const [slot, loop, condition, emphasis] = sections[1].children;
  const codeOf = (node) => modelTools.nodeSelectionOf(source, model, node.id, 'page.astro')?.code;
  const lines = (first, last) =>
    source
      .split('\n')
      .slice(first - 1, last)
      .join('\n');
  assert.equal(codeOf(html), lines(1, 15), 'the root is the whole document');
  assert.equal(codeOf(sections[0]), lines(2, 4));
  assert.equal(codeOf(sections[1]), lines(5, 14), 'the second of two look-alikes, with every child');
  assert.equal(codeOf(slot), lines(6, 6));
  assert.equal(codeOf(loop), lines(7, 9));
  assert.equal(codeOf(loop.children[0]), lines(8, 8), 'an element inside a loop is its own markup');
  assert.equal(codeOf(condition), lines(10, 10));
  assert.equal(codeOf(condition.children[0].children[0]), '<i>yes</i>', 'an element inside a condition');
  const words = modelTools.nodeSelectionOf(source, model, emphasis.children[0].id, 'page.astro');
  assert.deepEqual([words.code, words.startLine, words.endLine], [lines(12, 12), 12, 12], 'bare text, without the breaks around it');
  const named = (node) => modelTools.offeredNodeOf(model, node.id)?.name;
  assert.deepEqual([sections[0], slot, loop, emphasis.children[0]].map(named), ['Section', '<slot>', undefined, undefined]);
  assert.equal(modelTools.offeredNodeOf(model, 'missing'), undefined);
  const markdown = '# Title\n\nWords.\n';
  const parsed = parsePage(markdown, { locs: true }).model;
  const heading = { ...parsed, nodes: [{ kind: 'element', id: 'n0', name: 'h1', start: 0, end: 7 }] };
  assert.equal(modelTools.nodeSelectionOf(markdown, heading, 'n0', 'post.md').code, '# Title', 'Markdown writes no tag');
}

(async () => {
  await esbuild.build({
    entryPoints: [repoPath('src/features/code/codePanelModel.ts')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });
  const modelTools = require(output);
  const source = [
    '---',
    "import Card from '../components/Card.astro';",
    "import Eyebrow from '../components/Eyebrow.astro';",
    '---',
    '<section>',
    '  <Card>',
    '    <h2>Hello</h2>',
    '  </Card>',
    '  <Eyebrow>tabs · horizontal</Eyebrow>',
    '  <p>After</p>',
    '</section>',
    '',
  ].join('\n');
  const parsed = parsePage(source, { locs: true });
  assert.equal(parsed.editable, true);
  const model = parsed.model;
  const section = model.nodes[0];
  const card = section.children[0];
  const heading = card.children[0];
  const eyebrow = section.children[1];

  assert.deepEqual(
    modelTools.sourceRangeForSelection(model, card.id, source.length),
    { from: card.start, to: card.end },
    'navigator selection resolves to the exact source span',
  );
  assert.deepEqual(
    modelTools.sourceRangeForSelection(model, 'frontmatter', source.length),
    { from: 0, to: model.bodyStart },
    'frontmatter participates in the same selection model',
  );
  assert.equal(modelTools.sourceNodeAtOffset(model.nodes, source.indexOf('<h2') + 1).id, heading.id, 'the narrowest nested node wins code hit-testing');
  assert.equal(
    modelTools.sourceNodeAtOffset(model.nodes, source.indexOf('Hello') + 1).id,
    heading.id,
    'plain text selects its containing element for the canvas outline',
  );
  assert.equal(modelTools.sourceNodeAtOffset(model.nodes, source.indexOf('horizontal') + 1).id, eyebrow.id, 'plain text in a component selects that component');
  assert.deepEqual(modelTools.componentSourceRanges(model.nodes, source), [
    {
      id: card.id,
      name: 'Card',
      from: source.indexOf('<Card') + 1,
      to: source.indexOf('<Card') + 5,
    },
    {
      id: eyebrow.id,
      name: 'Eyebrow',
      from: source.indexOf('<Eyebrow') + 1,
      to: source.indexOf('<Eyebrow') + 8,
    },
  ]);
  assert.equal(modelTools.sourceLineLabel(source, { from: card.start, to: card.end }), 'L6–8');
  assert.equal(modelTools.sourceRangeForSelection(model, card.id, card.end - 1), undefined, 'stale ranges never escape the current document');
  // 'Show in code': a piece of an attribute's expression, by offsets into it.
  const listed = '<div class="a" data-class={x} class:list={[\'card\', className]}>\n  <p class:list={[className]}>x</p>\n</div>\n';
  const listedModel = parsePage(listed, { locs: true }).model;
  const div = listedModel.nodes.find((node) => node.name === 'div');
  const code = listedModel.nodes.find((node) => node.name === 'div').props['class:list'].value;
  const at = code.indexOf('className');
  const range = modelTools.attributeCodeRange(listed, div, 'class:list', { code: 'className', from: at, to: at + 'className'.length });
  assert.ok(range, 'the code is found on the element’s own tag');
  assert.equal(listed.slice(range.from, range.to), 'className');
  assert.ok(range.from < listed.indexOf('<p'), 'on the element itself, not its child');
  assert.equal(
    modelTools.attributeCodeRange(listed, div, 'class', { code: 'className', from: 0, to: 9 }),
    undefined,
    'class matches neither class:list nor data-class',
  );
  assert.equal(
    modelTools.attributeCodeRange(listed, div, 'class:list', { code: 'other', from: at, to: at + 5 }),
    undefined,
    'code the source no longer holds there is not shown',
  );
  assert.equal(modelTools.attributeCodeRange(listed, { start: undefined, end: undefined }, 'class:list', { code: 'x', from: 0, to: 1 }), undefined);
  // "Add to chat": an element's code reads as it is laid out (its indent kept), a text selection is exactly what
  // was selected, and a tree that no longer matches the source gives nothing rather than a wrong slice.
  assert.deepEqual(modelTools.nodeSelectionOf(source, model, card.id, 'a.astro'), {
    code: '  <Card>\n    <h2>Hello</h2>\n  </Card>',
    startLine: 6,
    endLine: 8,
    element: 'Card',
  });
  assert.equal(modelTools.nodeSelectionOf(source, model, 'frontmatter', 'a.astro').element, undefined);
  assert.equal(modelTools.nodeSelectionOf(`x\n${source}`, model, card.id, 'a.astro'), undefined, 'a stale tree is refused');
  assert.equal(modelTools.nodeSelectionOf(source, model, 'missing', 'a.astro'), undefined);
  everyKindOfSelection(modelTools);
  const from = source.indexOf('Hello');
  assert.deepEqual(modelTools.textSelectionOf(source, { from, to: from + 3 }), { code: 'Hel', startLine: 7, endLine: 7, element: undefined });
  assert.equal(modelTools.textSelectionOf(source, { from, to: from }), undefined);
  assert.equal(modelTools.textSelectionOf(source, { from: 0, to: source.length + 1 }), undefined);
  console.log('code-panel-model: passed [selection, links, nesting, bounds, reveal]');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
