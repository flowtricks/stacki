// Goal: text a component renders from a prop is editable on the canvas whatever markup the
// component wraps it in, and the edit lands on the prop of the one instance the person double
// clicked. The report that started it: a Card's heading and paragraph could not be typed into,
// though a Button's label could. Card prints them as `<Heading tag={headingTag}><Fragment
// set:html={heading} /></Heading>`: the fragment's parent is a component, which the finder
// used to refuse, so no target existed and the double click did nothing.
// Method: parse real Card-shaped components (a component that wraps the prop in another
// component through a slot, a dynamic tag, a prop with a default, a prop bound to a variable,
// repeated instances, instances in a loop), build the prop edits the way the desktop shell does,
// and check what each target names, what a save writes, and what is refused. A JSDOM frame then
// proves the frame finds the rendered words of a component-wrapped prop by position.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule');

const dom = new JSDOM('<body></body>');
for (const name of ['document', 'window', 'HTMLElement', 'Node', 'Element', 'Text', 'Comment', 'NodeFilter']) {
  global[name] = name === 'document' ? dom.window.document : name === 'window' ? dom.window : dom.window[name];
}
const { parsePage } = require('#dist/electron/parse/astroParser.js');
const { canvasPropEdits } = loadRenderer('src/app/model/canvasPropText.ts');
const { boundPropReader } = loadRenderer('src/app/model/canvasBoundText.ts');
const { createTreeIndex } = loadRenderer('src/editor/editorTree.ts');
const { matchCanvasText } = loadRenderer('electron/preload/frameTextMatch.ts');

const ROOT = '/site';
const PAGE = '/site/src/pages/index.astro';

// Card as the Lumos project writes it, reduced to what matters: the props are destructured
// from Astro.props and each is wrapped by another component's slot.
const CARD = [
  '---',
  'import Eyebrow from "@/components/typography/Eyebrow.astro";',
  'import Heading from "@/components/typography/Heading.astro";',
  'import Paragraph from "@/components/typography/Paragraph.astro";',
  'import Button from "@/components/Button.astro";',
  'const { eyebrow, heading, headingTag = "h3", text, buttonLabel, class: className, ...rest } = Astro.props;',
  'const hasContent = !!(eyebrow || heading || text || buttonLabel);',
  '---',
  '{hasContent && (',
  '  <div class="card_content">',
  '    <Eyebrow><Fragment set:html={eyebrow} /></Eyebrow>',
  '    <Heading tag={headingTag} variant="h5">',
  '      <Fragment set:html={heading} />',
  '    </Heading>',
  '    <Paragraph>',
  '      <Fragment set:html={text} />',
  '    </Paragraph>',
  '    <Button>{buttonLabel}</Button>',
  '  </div>',
  ')}',
].join('\n');

const FILES = {
  '/site/src/components/item/Card.astro': CARD,
  '/site/src/components/typography/Heading.astro': '---\nconst { tag: Tag = "h2" } = Astro.props;\n---\n<Tag><slot /></Tag>',
  '/site/src/components/typography/Paragraph.astro': '<p><slot /></p>',
  '/site/src/components/typography/Eyebrow.astro': '<p><slot /></p>',
  '/site/src/components/Button.astro': '<a><slot /></a>',
  // A prop with a default, wrapped the same way.
  '/site/src/components/item/Note.astro': [
    '---',
    'import Paragraph from "@/components/typography/Paragraph.astro";',
    'const { text = "Default words" } = Astro.props;',
    '---',
    '<Paragraph><Fragment set:html={text} /></Paragraph>',
  ].join('\n'),
  // The element is a variable the component picks: a dynamic tag.
  '/site/src/components/item/Title.astro': ['---', 'const { heading, tag: Tag = "h2" } = Astro.props;', '---', '<Tag set:html={heading} />'].join('\n'),
  // An imported component takes `set:html` as its own prop and renders nothing from it here.
  '/site/src/components/item/Passthrough.astro': [
    '---',
    'import Heading from "@/components/typography/Heading.astro";',
    'const { heading } = Astro.props;',
    '---',
    '<Heading set:html={heading} />',
  ].join('\n'),
  // A fragment placed in a named slot is placed by that slot.
  '/site/src/components/item/Slotted.astro': [
    '---',
    'import Paragraph from "@/components/typography/Paragraph.astro";',
    'const { heading } = Astro.props;',
    '---',
    '<Paragraph><Fragment slot="aside" set:html={heading} /></Paragraph>',
  ].join('\n'),
  // The caller's own words beside the fragment would shift the position the frame counts by.
  '/site/src/components/item/Beside.astro': [
    '---',
    'import Paragraph from "@/components/typography/Paragraph.astro";',
    'const { heading } = Astro.props;',
    '---',
    '<Paragraph>Before <Fragment set:html={heading} /></Paragraph>',
  ].join('\n'),
};

const field = (name, extra) => ({ name, type: 'string', ...extra });
const component = (name, file, schema) => ({ name, path: `${ROOT}/src/components/${file}`, schema });
const COMPONENTS = [
  component('Card', 'item/Card.astro', [field('eyebrow'), field('heading'), field('text'), field('buttonLabel')]),
  component('Heading', 'typography/Heading.astro', [field('tag')]),
  component('Paragraph', 'typography/Paragraph.astro', []),
  component('Eyebrow', 'typography/Eyebrow.astro', []),
  component('Button', 'Button.astro', []),
  component('Note', 'item/Note.astro', [field('text', { default: 'Default words' })]),
  component('Title', 'item/Title.astro', [field('heading')]),
  component('Passthrough', 'item/Passthrough.astro', [field('heading')]),
  component('Slotted', 'item/Slotted.astro', [field('heading')]),
  component('Beside', 'item/Beside.astro', [field('heading')]),
];
const IMPORTS = Object.fromEntries(
  COMPONENTS.map(({ name, path }) => [name, `import ${name} from "@/components/${path.slice(`${ROOT}/src/components/`.length)}";`]),
);

function parsed(text) {
  const result = parsePage(text, { locs: true });
  assert.equal(result.editable, true, 'the source parses');
  return result.model;
}

function pageSource(body, frontmatter = '', used = ['Card']) {
  return ['---', ...used.map((name) => IMPORTS[name]), frontmatter, '---', body].join('\n');
}

async function edits(source, bound) {
  const page = parsed(source);
  const tree = createTreeIndex(page.nodes);
  const writes = [];
  const document = { file: 'src/pages/index.astro', source, nodes: page.nodes, pathFor: (id) => tree.path(id) };
  const found = await canvasPropEdits(document, {
    projectPath: ROOT,
    file: PAGE,
    nodes: page.nodes,
    imports: page.imports,
    components: COMPONENTS,
    label: 'Component text',
    relative: (file) => file.slice(ROOT.length + 1),
    read: async (file) => (FILES[file] === undefined ? undefined : parsed(FILES[file])),
    setProp: (nodeId, prop, value) => writes.push({ nodeId, prop, value }),
    ...(bound === undefined ? {} : { bound: bound(document) }),
  });
  return { found, writes, page };
}

const host = { readModule: async () => undefined, readFile: async () => undefined };
const WORDS = { saved: (path, file) => `${path} in ${file}`, undo: 'Undo', sourceChanged: 'The data changed on disk while editing' };
const withBinding = (document) => boundPropReader(document, host, WORDS);
const named = (found, prop) => found.filter((entry) => entry.prop?.name === prop || entry.target.key.includes(`:${prop}:`));

test('a Card heading and paragraph are editable, though a component wraps each in its slot', async () => {
  const { found } = await edits(pageSource('<Card heading="Lorem ipsum" text="Body words" />'));
  const [heading] = named(found, 'heading');
  const [body] = named(found, 'text');
  assert.ok(heading, 'the heading has a target');
  assert.ok(body, 'the paragraph has a target');
  assert.deepEqual(
    [heading.target.kind, heading.target.tag, heading.target.value, heading.target.segment, heading.target.from],
    ['component', 'Heading', 'Lorem ipsum', 0, 'prop'],
    'the words sit in the component that draws the heading, found by position',
  );
  assert.deepEqual([body.target.kind, body.target.tag, body.target.value], ['component', 'Paragraph', 'Body words']);
  assert.ok(heading.target.path.startsWith('src/components/item/Card.astro|'), 'printed in Card');
  assert.deepEqual(found.map((entry) => entry.prop?.name).sort(), ['heading', 'text'], 'the eyebrow and button label the page sets nothing for show no target');
});

test('typing in the heading writes that attribute on the instance, and unchanged words write nothing', async () => {
  const { found, writes } = await edits(pageSource('<Card heading="Lorem ipsum" text="Body words" />'));
  const [heading] = named(found, 'heading');
  await heading.apply('Lorem ipsum');
  assert.deepEqual(writes, [], 'a look is never an edit');
  await heading.apply('A new <b>title</b>'.replace(/<[^>]+>/g, ''));
  assert.equal(writes.length, 1);
  assert.deepEqual([writes[0].prop, writes[0].value], ['heading', { type: 'string', value: 'A new title' }]);
});

test('repeated instances each own their words: editing one writes only that instance', async () => {
  const { found, writes, page } = await edits(pageSource('<Card heading="First" text="One" />\n<Card heading="Second" text="Two" />'));
  const headings = named(found, 'heading');
  assert.deepEqual(
    headings.map((entry) => entry.target.value),
    ['First', 'Second'],
  );
  assert.notEqual(headings[0].target.key, headings[1].target.key);
  assert.notEqual(headings[0].target.scope, headings[1].target.scope, 'each is marked inside its own instance');
  await headings[1].apply('Changed');
  const ids = page.nodes.filter((node) => node.kind === 'component').map((node) => node.id);
  assert.deepEqual(
    writes.map((write) => [write.nodeId, write.prop]),
    [[ids[1], 'heading']],
    'the second Card alone',
  );
});

test('a prop left to its default shows the default and adds the attribute when typed into', async () => {
  const { found, writes } = await edits(pageSource('<Note />', '', ['Note']));
  assert.equal(found.length, 1);
  assert.equal(found[0].target.value, 'Default words');
  await found[0].apply('Mine');
  assert.deepEqual(writes[0].value, { type: 'string', value: 'Mine' });
});

test('a dynamic tag that holds the prop as HTML is editable like an element', async () => {
  const { found } = await edits(pageSource('<Title heading="Dynamic" />', '', ['Title']));
  assert.equal(found.length, 1);
  assert.deepEqual([found[0].target.kind, found[0].target.tag, found[0].target.value], ['component', 'Tag', 'Dynamic']);
});

test('shapes whose rendered position the frame could not count are left alone', async () => {
  for (const [name, used] of [
    ['Passthrough', 'an imported component takes set:html as a prop'],
    ['Slotted', 'a fragment in a named slot'],
    ['Beside', 'words of the caller beside the fragment'],
  ].map(([name, why]) => [name, why])) {
    const { found } = await edits(pageSource(`<${name} heading="Words" />`, '', [name]));
    assert.deepEqual(found, [], used);
  }
});

test('instances in a loop get no target: one attribute would stand for every copy', async () => {
  const { found } = await edits(pageSource('{[1, 2].map(() => <Card heading="Same" />)}'));
  assert.deepEqual(found, []);
});

test('a prop bound to a constant is edited in that constant, escaped as the HTML it prints, and not in the attribute', async () => {
  const { found, writes } = await edits(pageSource('<Card heading={title} text="Body" />', 'const title = "From data";'), withBinding);
  const heading = named(found, 'heading')[0];
  assert.deepEqual([heading.bound.kind, heading.bound.expression, heading.target.value, heading.target.segment], ['source', 'title', 'From data', 0]);
  assert.deepEqual(writes, [], 'nothing writes the attribute');
});

test('data that holds markup is named, not written: its tags are the source to edit', async () => {
  const { found } = await edits(pageSource('<Card heading={title} />', 'const title = "Hello <b>there</b>";'), withBinding);
  const heading = named(found, 'heading')[0];
  assert.deepEqual([heading.bound.kind, heading.bound.reason], ['blocked', 'computed']);
  await assert.rejects(heading.apply('x'));
});

test('a prop bound to code the editor cannot follow is refused with its reason, and never written', async () => {
  const frontmatter = 'const title = "a" + "b";\nconst flag = true;';
  const cases = [
    ['{title}', 'concatenation'],
    ['{flag ? "x" : "y"}', 'computed'],
    ['{make("x")}', 'call'],
  ];
  for (const [expression, reason] of cases) {
    const { found, writes } = await edits(pageSource(`<Card heading=${expression} text="Body" />`, frontmatter), withBinding);
    const heading = named(found, 'heading')[0];
    assert.ok(heading, `${expression} has a refusal entry`);
    assert.equal(heading.bound.kind, 'blocked', expression);
    assert.equal(heading.bound.reason, reason, expression);
    await assert.rejects(heading.apply('Typed'), expression);
    assert.deepEqual(writes, [], 'a refusal never writes the attribute');
  }
});

test('without a binding reader a bound prop stays the page code and gives no target', async () => {
  const { found } = await edits(pageSource('<Card heading={title} />', 'const title = "x";'));
  assert.deepEqual(found, []);
});

test('the frame finds the rendered words of a component-wrapped prop by position', async () => {
  const { found } = await edits(pageSource('<Card heading="Lorem ipsum" text="Body words" />'));
  const [{ target }] = named(found, 'heading');
  const host = document.createElement('div');
  host.setAttribute('data-avb-p', `${target.scope} src/components/item/Card.astro|0.0`);
  host.innerHTML = '<h3 class="heading">Lorem ipsum</h3>';
  const heading = host.querySelector('h3');
  heading.setAttribute('data-avb-p', target.parent);
  document.body.append(host);
  try {
    const match = matchCanvasText(target, heading);
    assert.ok(match, 'the words are matched although the heading is drawn by another component');
    assert.equal(match.element, heading);
    assert.deepEqual(
      match.nodes.map((node) => node.data),
      ['Lorem ipsum'],
    );
    heading.textContent = 'Something else';
    assert.equal(matchCanvasText(target, heading), undefined, 'other words are never this target');
  } finally {
    host.remove();
  }
});
