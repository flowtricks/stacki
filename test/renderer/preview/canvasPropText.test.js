// Goal: text a component prop sets is editable on the canvas for exactly the instances whose
// attribute it would change, printed as text or rendered as HTML (`set:html`), and is marked
// only while that instance is selected.
// Method: parse a real page and its components, build the prop edits the way the desktop shell
// does, then check which instances get targets, what their values are, what a save writes,
// how HTML runs format and preview, and that the frame's selection focus contract accepts good
// messages and rejects malformed ones. A JSDOM document stands in for the renderer's.
// A Webflow-exported page (ButtonMain beside TypographyHeading) checks that a prop read
// under a renamed local still yields a target, and that the frame finds its rendered words.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule');

const dom = new JSDOM('<body></body>');
for (const name of ['document', 'window', 'HTMLElement', 'Node', 'Element', 'Text', 'Comment']) {
  global[name] = name === 'document' ? dom.window.document : name === 'window' ? dom.window : dom.window[name];
}
const { parsePage } = require('#dist/electron/parse/astroParser.js');
const { canvasPropEdits, propName } = loadRenderer('src/app/model/canvasPropText.ts');
const { createTreeIndex } = loadRenderer('src/editor/editorTree.ts');
const { canvasTextFocus, parseCanvasTextFocus } = loadRenderer('shared/properties/canvasTextOverlay.ts');
const { marked } = loadRenderer('electron/preload/frameTextMarks.ts');
const { matchCanvasText } = loadRenderer('electron/preload/frameTextMatch.ts');
const { canvasTextPlans } = loadRenderer('src/features/preview/canvasTextSource.ts');

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
  '/site/src/components/Card.astro': '---\nconst { body } = Astro.props;\n---\n<p set:html={body} />',
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
  const [unset, set] = [...byScope.values()].map((targets) => [...targets].sort((left, right) => left.path.localeCompare(right.path)));
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
  assert.deepEqual(parseCanvasTextFocus({ type: 'avb:text-focus', paths: [''] }).paths, [], 'an empty path is no path');
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

// ButtonMain's shape from a Webflow export: each prop is renamed as it is read
// (`text: propText = "Button Text"`), the template sits behind a visibility
// branch, the words behind a second branch, and the same prop is also handed
// on as another component's attribute.
const BUTTON_SOURCES = {
  '/site/src/pages/index.astro': [
    '---',
    "import ButtonMain from '../components/ButtonMain.astro';",
    "import TypographyHeading from '../components/TypographyHeading.astro';",
    '---',
    '<div>',
    '<TypographyHeading textTag="h1">',
    'Find hope. Live with purpose.',
    '</TypographyHeading>',
    '<ButtonMain link="/campuses" text="Choose a campus" variant="primary" />',
    '</div>',
  ].join('\n'),
  '/site/src/components/ButtonMain.astro': [
    '---',
    "import Clickable from './Clickable.astro';",
    'const {',
    '  text2: propText2 = "",',
    '  link: propLink = "#",',
    '  text: propText = "Button Text",',
    '  visibility: propVisibility = true',
    '} = Astro.props;',
    '---',
    '{propVisibility && (<div class="button_main_wrap">',
    '<Clickable link={propLink} screenReaderText={propText} />',
    '<div class="button_main_element">',
    '{!propText2 && (<div aria-hidden="true" class="button_main_text">',
    '{propText}',
    '</div>)}',
    '{propText2 && (<div aria-hidden="true" class="button_main_text">',
    '<span>',
    '{propText}',
    '</span>',
    '<span>',
    '{propText2}',
    '</span>',
    '</div>)}',
    '</div>',
    // The prop's own name is not its local here, so this prints some other variable.
    '<p>{link}</p>',
    '</div>)}',
  ].join('\n'),
  '/site/src/components/TypographyHeading.astro': [
    '---',
    'const { textTag: propTextTag = "h2", visibility: propVisibility = true } = Astro.props;',
    'const propText = "Lorem ipsum dolor sit amet elit";',
    'const Tag = propTextTag;',
    '---',
    '{propVisibility && (<div class="w-richtext"><Tag><slot>{propText}</slot></Tag></div>)}',
  ].join('\n'),
  '/site/src/components/Clickable.astro': [
    '---',
    'const { link: propLink = "#", screenReaderText: propScreenReaderText = "" } = Astro.props;',
    '---',
    '<div><a aria-label={propScreenReaderText} href={propLink}></a></div>',
  ].join('\n'),
};
const BUTTON_COMPONENTS = [
  {
    name: 'ButtonMain',
    path: `${ROOT}/src/components/ButtonMain.astro`,
    schema: [
      { name: 'text2', type: 'string', default: '' },
      { name: 'link', type: 'string', default: '#' },
      { name: 'text', type: 'string', default: 'Button Text' },
      { name: 'visibility', type: 'boolean', default: true },
    ],
  },
  {
    name: 'Clickable',
    path: `${ROOT}/src/components/Clickable.astro`,
    schema: [
      { name: 'link', type: 'string', default: '#' },
      { name: 'screenReaderText', type: 'string', default: '' },
    ],
  },
];

function buttonPage() {
  return readButton('/site/src/pages/index.astro');
}

function readButton(file) {
  const result = parsePage(BUTTON_SOURCES[file], { locs: true });
  assert.equal(result.editable, true, `${file} parses`);
  return result.model;
}

async function buttonEdits() {
  const read = readButton;
  const page = buttonPage();
  const tree = createTreeIndex(page.nodes);
  return canvasPropEdits(
    { pathFor: (id) => tree.path(id) },
    {
      projectPath: ROOT,
      file: '/site/src/pages/index.astro',
      nodes: page.nodes,
      imports: page.imports,
      components: BUTTON_COMPONENTS,
      relative: (file) => file.slice(ROOT.length + 1),
      read: async (file) => (BUTTON_SOURCES[file] ? read(file) : undefined),
      setProp: () => undefined,
    },
  );
}

test('a prop renamed as it is read is found where the component prints its local name', async () => {
  const found = await buttonEdits();
  const texts = found.filter((entry) => entry.prop.name === 'text');
  assert.deepEqual(
    texts.map(({ target }) => [target.value, target.tag, target.from]),
    [
      ['Choose a campus', 'div', 'prop'],
      ['Choose a campus', 'span', 'prop'],
    ],
    'both branches that print `propText` show the instance text',
  );
  assert.ok(
    texts.every(({ target }) => target.path.startsWith('src/components/ButtonMain.astro|')),
    'printed in ButtonMain',
  );
  assert.deepEqual(
    found.filter((entry) => entry.prop.name !== 'text').map((entry) => entry.prop.name),
    [],
    'an attribute that is no text (aria-label) and an unset prop with no words give no target',
  );
});

test('the heading beside the button keeps its slot text target', () => {
  const page = buttonPage();
  const tree = createTreeIndex(page.nodes);
  const plans = canvasTextPlans(BUTTON_SOURCES['/site/src/pages/index.astro'], page.nodes, (id) => tree.path(id));
  assert.deepEqual(
    plans.map(({ target }) => [target.value.trim(), target.tag, target.from]),
    [['Find hope. Live with purpose.', 'TypographyHeading', 'slot']],
    "the control: page text inside an instance is marked as that instance's content",
  );
});

test("the frame finds the button's rendered words for its prop target", async () => {
  const found = await buttonEdits();
  const [shown] = found.filter((entry) => entry.prop.name === 'text');
  assert.ok(shown, 'the button has a text target');
  const { target } = shown;
  assert.deepEqual(target.siblings, [], 'the text div holds only the words');
  const host = document.createElement('div');
  host.setAttribute('data-avb-p', `${target.scope} src/components/ButtonMain.astro|0.0`);
  host.innerHTML = '<div class="button_main_element"><div aria-hidden="true">\nChoose a campus\n</div></div>';
  const words = host.querySelector('[aria-hidden]');
  words.setAttribute('data-avb-p', target.parent);
  document.body.append(host);
  try {
    assert.equal(marked(target, new Set([target.scope])), true, 'marked while the instance is selected');
    const match = matchCanvasText(target, words);
    assert.ok(match, 'the words are matched');
    assert.equal(match.element, words);
    assert.deepEqual(
      match.nodes.map((node) => node.data.trim()),
      ['Choose a campus'],
    );
    words.textContent = 'Plan your visit';
    assert.equal(matchCanvasText(target, words), undefined, 'other words are not this target');
  } finally {
    host.remove();
  }
});
