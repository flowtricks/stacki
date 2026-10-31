// Goal: text a component prop sets is editable on the canvas for exactly the instances whose
// attribute it would change, printed as text or rendered as HTML (`set:html`), and is marked
// only while that instance is selected.
// Method: parse a real page and its components, build the prop edits the way the desktop shell
// does, then check which instances get targets, what their values are, what a save writes,
// how HTML runs format and preview, and that the frame's selection focus contract accepts good
// messages and rejects malformed ones. A JSDOM document stands in for the renderer's.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule');

const dom = new JSDOM('<body></body>');
for (const name of ['document', 'window', 'HTMLElement', 'Node', 'Element', 'Text', 'Comment']) {
  global[name] =
    name === 'document' ? dom.window.document : name === 'window' ? dom.window : dom.window[name];
}
const { parsePage } = require('#dist/electron/parse/astroParser.js');
const { canvasPropEdits, propName } = loadRenderer('src/app/model/canvasPropText.ts');
const { createTreeIndex } = loadRenderer('src/editor/editorTree.ts');
const { canvasTextFocus, parseCanvasTextFocus } = loadRenderer(
  'shared/properties/canvasTextOverlay.ts',
);
const { marked } = loadRenderer('electron/preload/frameTextMarks.ts');

const ROOT = '/site';
const SOURCES = {
  '/site/src/pages/index.astro': [
    '---',
    "import Slider from '../components/Slider.astro';",
    "import Card from '../components/Card.astro';",
    'const items = [1, 2];',
    'const title = "Code";',
    '---',
    '<Slider />',
    '<Slider headingText="Hello" />',
    '{items.map(() => <Slider />)}',
    '<Slider headingText={title} />',
    '<Card body="Hello <strong>world</strong>" />',
  ].join('\n'),
  '/site/src/components/Slider.astro': [
    '---',
    "import Heading from './Heading.astro';",
    "import Title from './Title.astro';",
    'const { render = true, headingText = "We\'re here" } = Astro.props;',
    '---',
    '{render && <section><Heading>{headingText}</Heading><Title text={headingText} /></section>}',
  ].join('\n'),
  '/site/src/components/Heading.astro': '<h2><slot /></h2>',
  '/site/src/components/Card.astro':
    '---\nconst { body } = Astro.props;\n---\n<p set:html={body} />',
  '/site/src/components/Title.astro': '---\nconst { text } = Astro.props;\n---\n<h3>{text}</h3>',
};
const COMPONENTS = [
  component('Slider', [
    { name: 'render', type: 'boolean', default: true },
    { name: 'headingText', type: 'string', default: "We're here" },
  ]),
  component('Heading', []),
  component('Title', [{ name: 'text', type: 'string' }]),
  component('Card', [{ name: 'body', type: 'string' }]),
];

function component(name, schema) {
  return { name, path: `${ROOT}/src/components/${name}.astro`, schema };
}

function parsed(file) {
  const result = parsePage(SOURCES[file], { locs: true });
  assert.equal(result.editable, true, `${file} parses`);
  return result.model;
}

async function edits() {
  const page = parsed('/site/src/pages/index.astro');
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
      relative: (file) => file.slice(ROOT.length + 1),
      read: async (file) => (SOURCES[file] ? parsed(file) : undefined),
      setProp: (nodeId, prop, value) => writes.push({ nodeId, prop, value }),
    },
  );
  return { found, writes };
}

test('each single instance gets its own prop text, printed directly or handed on', async () => {
  const { found } = await edits();
  const byScope = new Map();
  for (const edit of found.filter((entry) => entry.prop.name === 'headingText')) {
    byScope.set(edit.target.scope, [...(byScope.get(edit.target.scope) ?? []), edit.target]);
  }
  assert.equal(byScope.size, 2, 'the looped and the expression instances are left alone');
  // Slider's own text before the text it hands to Title.
  const [unset, set] = [...byScope.values()].map((targets) =>
    [...targets].sort((left, right) => left.path.localeCompare(right.path)),
  );
  assert.deepEqual(
    unset.map((target) => [target.value, target.tag, target.from]),
    [
      ["We're here", 'Heading', 'prop'],
      ["We're here", 'h3', 'prop'],
    ],
    'an unset prop shows the default; a handed-on prop is found in the nested component',
  );
  assert.deepEqual(
    set.map((target) => target.value),
    ['Hello', 'Hello'],
  );
  assert.ok(unset[0].path.startsWith('src/components/Slider.astro|'), 'printed in Slider');
  assert.ok(unset[1].path.startsWith('src/components/Title.astro|'), 'printed in Title');
  assert.notEqual(unset[0].key, set[0].key, 'one key per instance');
});

test('a save writes trimmed words to that instance only, and nothing unchanged', async () => {
  const { found, writes } = await edits();
  const [first] = found;
  await first.apply("\n   We're here  \n");
  assert.deepEqual(writes, [], 'the rendered whitespace around unchanged words writes nothing');
  await first.apply('  We are here  ');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].prop, 'headingText');
  assert.deepEqual(writes[0].value, { type: 'string', value: 'We are here' });
});

test('a prop expression names its prop with or without braces', () => {
  assert.equal(propName('{headingText}'), 'headingText');
  assert.equal(propName(' { headingText } '), 'headingText');
  assert.equal(propName('headingText'), 'headingText');
  assert.equal(propName('{headingText.trim()}'), 'headingText.trim()', 'code is not a prop');
});

test('prop text is marked only inside the selected instance', () => {
  const target = { from: 'prop', scope: '0.3' };
  assert.equal(marked(target, new Set(['0', '0.3'])), true);
  assert.equal(marked(target, new Set(['0', '0.4'])), false, 'another instance');
  assert.equal(marked(target, new Set()), false, 'nothing selected');
  assert.equal(marked({ scope: '0.3' }, new Set(['0.3'])), false, 'literal text');
  assert.equal(marked({ from: 'prop' }, new Set(['0.3'])), false, 'no instance');
});

test('the selection focus contract accepts paths and rejects malformed messages', () => {
  assert.deepEqual(parseCanvasTextFocus({ type: 'avb:text-focus', paths: ['0', '0.3'] }), {
    type: 'avb:text-focus',
    paths: ['0', '0.3'],
  });
  assert.equal(parseCanvasTextFocus({ type: 'avb:text-close' }), undefined, 'other messages');
  assert.deepEqual(
    parseCanvasTextFocus({ type: 'avb:text-focus', paths: [''] }).paths,
    [],
    'an empty path is no path',
  );
  assert.throws(() => parseCanvasTextFocus({ type: 'avb:text-focus', paths: '0' }));
  assert.throws(() => parseCanvasTextFocus({ type: 'avb:text-focus', paths: [3] }));
  const deep = Array.from({ length: 257 }, (_, index) => String(index));
  assert.throws(() => parseCanvasTextFocus({ type: 'avb:text-focus', paths: deep }));
  assert.deepEqual(canvasTextFocus(['0']), { type: 'avb:text-focus', paths: ['0'] });
  assert.throws(() => canvasTextFocus(['']), /Canvas text focus names real paths/);
  assert.throws(() => canvasTextFocus(deep), /Canvas text focus stays within its bound/);
});

test('a prop rendered as HTML edits each text run and saves the HTML back', async () => {
  const { found, writes } = await edits();
  const runs = found.filter((entry) => entry.prop.name === 'body');
  assert.deepEqual(
    runs.map(({ target }) => [target.value, target.segment, target.nested, target.tag]),
    [
      ['Hello ', 0, false, 'p'],
      ['world', 1, true, 'p'],
    ],
    'one target per text run, told apart by position inside the paragraph',
  );
  const [plain, bold] = runs;
  assert.deepEqual(plain.format.states().bold, false);
  assert.deepEqual(bold.format.states().bold, true, 'the bar lights what the run sits in');
  assert.equal(bold.prop.value('there'), 'Hello <strong>there</strong>', 'the live field value');
  await bold.apply('world');
  assert.deepEqual(writes, [], 'unchanged words write nothing');
  await bold.apply('there');
  assert.deepEqual(writes, [
    {
      nodeId: writes[0].nodeId,
      prop: 'body',
      value: { type: 'string', value: 'Hello <strong>there</strong>' },
    },
  ]);
});
