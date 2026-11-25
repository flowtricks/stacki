// Goal: on the Lumos example page, a Card's heading and paragraph are editable on the canvas. The
// report: double-clicking them did nothing in the running app, though the finder passed on
// hand-written markup. Two real causes sat outside that markup: the page holds 350+ component
// instances and the finder read only the first 64 of them in tree order (every Card sits deeper),
// and the heading it wrote back carried the line breaks Heading's own template puts around the slot.
// Method: the fixtures are real. `test/fixtures/lumos-card/` holds the project's Card, Heading,
// Paragraph, Eyebrow and Button sources, its example-components page, and the markup the preview
// rendered for the first Card (captured from the running app on a copy of the project: the
// `data-avb-p` tags are the preview's own). The real finder runs over the real page; the frame
// matches its targets on the real markup.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule');
const { repoPath } = require('../../helpers/sources.js');

const dom = new JSDOM('<body></body>');
for (const name of ['document', 'window', 'HTMLElement', 'Node', 'Element', 'Text', 'Comment', 'NodeFilter']) {
  global[name] = name === 'document' ? dom.window.document : name === 'window' ? dom.window : dom.window[name];
}
const { parsePage } = require('#dist/electron/parse/astroParser.js');
const { canvasPropEdits } = loadRenderer('src/app/model/canvasPropText.ts');
const { createTreeIndex } = loadRenderer('src/editor/editorTree.ts');
const { matchCanvasText } = loadRenderer('electron/preload/frameTextMatch.ts');

const FIXTURES = repoPath('test/fixtures/lumos-card');
const ROOT = '/site';
const read = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const PAGE = read('example-components.astro');
const SOURCES = {
  '/site/src/components/item/Card.astro': read('Card.astro'),
  '/site/src/components/typography/Heading.astro': read('Heading.astro'),
  '/site/src/components/typography/Paragraph.astro': read('Paragraph.astro'),
  '/site/src/components/typography/Eyebrow.astro': read('Eyebrow.astro'),
  '/site/src/components/Button.astro': read('Button.astro'),
};
const field = (name) => ({ name, type: 'string' });
const COMPONENTS = [
  { name: 'Card', path: '/site/src/components/item/Card.astro', schema: ['eyebrow', 'heading', 'text', 'buttonLabel', 'buttonHref'].map(field) },
  { name: 'Heading', path: '/site/src/components/typography/Heading.astro', schema: [field('tag')] },
  { name: 'Paragraph', path: '/site/src/components/typography/Paragraph.astro', schema: [] },
  { name: 'Eyebrow', path: '/site/src/components/typography/Eyebrow.astro', schema: [] },
  { name: 'Button', path: '/site/src/components/Button.astro', schema: [] },
];

function parsed(text) {
  const result = parsePage(text, { locs: true });
  assert.equal(result.editable, true);
  return result.model;
}

async function edits() {
  const page = parsed(PAGE);
  const tree = createTreeIndex(page.nodes);
  const writes = [];
  const found = await canvasPropEdits(
    { pathFor: (id) => tree.path(id) },
    {
      projectPath: ROOT,
      file: '/site/src/pages/index.astro',
      nodes: page.nodes,
      imports: page.imports,
      components: COMPONENTS,
      label: 'Component text',
      relative: (file) => file.slice(ROOT.length + 1),
      read: async (file) => (SOURCES[file] === undefined ? undefined : parsed(SOURCES[file])),
      setProp: (nodeId, prop, value) => writes.push({ prop, value }),
    },
  );
  return { found, writes };
}

test('the page is deep enough that its first Cards sit past the old 64-instance cap', async () => {
  const page = parsed(PAGE);
  const instances = [];
  const queue = [...page.nodes];
  for (let index = 0; index < queue.length && index < 20_000; index++) {
    const node = queue[index];
    if (node.kind === 'component') {
      instances.push(node.name);
    }
    queue.push(...(node.children ?? []));
  }
  assert.ok(instances.length > 200, `${instances.length} component instances`);
  assert.ok(instances.indexOf('Card') > 64, `the first Card is instance ${instances.indexOf('Card')} in tree order`);
});

test('every Card with a literal heading or text gets a target, the first Card included', async () => {
  const { found } = await edits();
  const headings = found.filter((edit) => edit.prop?.name === 'heading');
  const texts = found.filter((edit) => edit.prop?.name === 'text');
  assert.ok(headings.length >= 20, `${headings.length} heading targets`);
  assert.ok(texts.length >= 20, `${texts.length} text targets`);
  const first = headings.find((edit) => edit.target.scope === '0.1.0.0');
  assert.ok(first, 'the Card of the first stack');
  assert.equal(first.target.value, 'Lorem ipsum dolor sit amet elit');
});

test('the frame matches the first Card heading on the markup the real preview rendered', async () => {
  const { found } = await edits();
  const heading = found.find((edit) => edit.target.scope === '0.1.0.0' && edit.prop?.name === 'heading');
  const text = found.find((edit) => edit.target.scope === '0.1.0.0' && edit.prop?.name === 'text');
  const host = document.createElement('div');
  host.innerHTML = read('card-preview.html');
  document.body.append(host);
  try {
    const headingElement = host.querySelector('h3');
    const paragraph = host.querySelector('p');
    const headingMatch = matchCanvasText(heading.target, headingElement);
    assert.ok(headingMatch, 'the heading is matched on the preview markup, whitespace from Heading included');
    assert.equal(headingMatch.element, headingElement);
    const textMatch = matchCanvasText(text.target, paragraph);
    assert.ok(textMatch, 'the paragraph is matched');
    assert.equal(textMatch.element, paragraph);
  } finally {
    host.remove();
  }
});

test('typing writes the words alone: the whitespace Heading draws around its slot is not the prop', async () => {
  const { found, writes } = await edits();
  const heading = found.find((edit) => edit.target.scope === '0.1.0.0' && edit.prop?.name === 'heading');
  await heading.apply('\n    Lorem ipsum dolor sit amet elit Z\n  ');
  assert.deepEqual(writes, [{ prop: 'heading', value: { type: 'string', value: 'Lorem ipsum dolor sit amet elit Z' } }]);
});

test('words the page writes inside a Button on the real page are slot targets of that instance', async () => {
  const page = parsed(PAGE);
  const tree = createTreeIndex(page.nodes);
  const { canvasTextPlans } = loadRenderer('src/features/preview/canvasTextSource.ts');
  const plans = canvasTextPlans(PAGE, page.nodes, (id) => tree.path(id));
  const labels = plans.filter((plan) => plan.target.value.trim() === 'Button Text');
  assert.ok(labels.length > 0, 'the page has Button Text children');
  for (const plan of labels) {
    assert.equal(plan.target.from, 'slot');
    assert.equal(plan.target.tag, 'Button');
    assert.ok(plan.target.scope, 'owned by the Button instance');
  }
});
