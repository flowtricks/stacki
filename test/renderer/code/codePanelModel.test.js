// Goal: keep code, navigator, and canvas selection on one source-range model.
// Methodology: parse a real Astro file with offsets, then exercise selection,
// component links, nested hit-testing, text inside tags, frontmatter, and
// invalid-range edges.

const assert = require('node:assert/strict');
const path = require('node:path');
const esbuild = require('esbuild');
const { parsePage } = require('#dist/electron/parse/astroParser.js');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/code-panel-model.cjs');

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
  console.log('code-panel-model: passed [selection, links, nesting, bounds]');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
