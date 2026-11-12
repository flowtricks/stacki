// Goal: the Style panel's first styles reach disk as the one edit they are meant to be.
// A project with no `<style>` and no stylesheet gets, on the first style applied to an element,
// a `<style is:global>` block at the end of the page it is on and a class on the element, in one
// page edit and so one undo step; and nothing the person wrote is changed to do it.
//
// Method: the real App in jsdom over a real document host (test/helpers/appGestures.js), on a
// fixture project with NO style of any kind. The panel's callback is driven as the panel drives
// it (`onAddStyleBlock`, the host half of src/features/style/model/firstStyleBlock.ts), then the
// file is read back and compared byte for byte, and ⌘Z must restore the original bytes. Each
// shape of page and element the mode meets is a case: LF and CRLF files, tab and space
// indents, a class attribute, a class:list, a template literal, an element in a loop, a
// component instance, text with no tag, a page with markup at several roots, and a Markdown page
// that cannot hold a block. The panel half (what it chooses to write) is firstStylesPanel.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gesture, mountApp, select, undo } = require('../../helpers/appGestures.js');

const PAGE = ['---', 'const items = ["a", "b"];', '---', '<main>', '\t<h1>Hi</h1>', '\t<p class="intro">Intro</p>', '</main>', ''].join('\n');
const RULE = '.class {\n\tpadding: 1rem;\n}\n';
const BLOCK = '<style is:global>\n\t.class {\n\t\tpadding: 1rem;\n\t}\n</style>\n';
const PLACEMENT_END = { kind: 'end' };

const refusals = () => [...document.querySelectorAll('.toast.error')].map((toast) => toast.textContent);

// A project holding one page, with no stylesheet, and the app open on it.
async function openProject(context, { file = 'index.astro', text = PAGE, extra = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-first-styles-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src', 'pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'components'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"astro":"*"}}');
  const page = path.join(root, 'src', 'pages', file);
  fs.writeFileSync(page, text);
  const components = [];
  for (const [name, content] of Object.entries(extra)) {
    const componentPath = path.join(root, 'src', 'components', name);
    fs.writeFileSync(componentPath, content);
    components.push({ name: name.replace(/\.astro$/, ''), path: componentPath, folder: '' });
  }
  const scan = { pages: [{ name: file, path: page, route: '/' }], components, layouts: [], pageFolders: [] };
  const bridge = { resolveImport: async () => ({ path: components[0]?.path }), watchProject: async () => ({ ok: true }) };
  const app = await mountApp(root, { scan }, 'first-styles', { bridge });
  context.after(app.unmount);
  return { app, page };
}

// The first node, in document order, that `matches`.
function find(matches) {
  const pending = __panels.StructurePanel.pageState.model.nodes.map((node, index) => ({ node, at: [index] }));
  for (let visited = 0; visited < pending.length; visited++) {
    const { node, at } = pending[visited];
    if (matches(node)) {
      return { node, at };
    }
    (node.children ?? []).forEach((child, index) => pending.push({ node: child, at: [...at, index] }));
  }
  return assert.fail('a node matches');
}

// Select the node at `at` and send the panel's first-styles request for it.
async function firstStyles(app, at, request) {
  await select(app, at);
  let outcome;
  await gesture(app, async () => {
    outcome = await __panels.StylePanel.onAddStyleBlock({ placement: PLACEMENT_END, ...request });
  });
  return outcome;
}

test('the first styles add a global block and a class in one edit, and undo restores every byte', async (context) => {
  const { app, page } = await openProject(context);
  const outcome = await firstStyles(app, find((node) => node.name === 'h1').at, { css: RULE, className: 'class' });
  assert.deepEqual(outcome, { tag: 'applied' });
  assert.equal(fs.readFileSync(page, 'utf8'), PAGE.replace('<h1>', '<h1 class="class">') + BLOCK);
  assert.deepEqual(refusals(), []);
  // The shown model has the block too, so the panel's next scan finds it.
  const block = find((node) => node.kind === 'raw' && node.name === 'style').node;
  assert.ok(block.props['is:global'], 'the block is global');
  // One step: a single undo gives the file back exactly.
  await undo(app);
  assert.equal(fs.readFileSync(page, 'utf8'), PAGE, 'one undo removes the block and the class');
});

test('a class already on the element is kept: the new one is appended, never replacing', async (context) => {
  const { app, page } = await openProject(context);
  await firstStyles(app, find((node) => node.name === 'p').at, { css: RULE, className: 'class' });
  assert.equal(fs.readFileSync(page, 'utf8'), PAGE.replace('class="intro"', 'class="intro class"') + BLOCK);
  await undo(app);
  assert.equal(fs.readFileSync(page, 'utf8'), PAGE);
});

test('a block alone: the element already carries the selector, so no class is added', async (context) => {
  const { app, page } = await openProject(context);
  await firstStyles(app, find((node) => node.name === 'p').at, { css: '.intro {\n\tcolor: red;\n}\n', className: undefined });
  assert.equal(fs.readFileSync(page, 'utf8'), PAGE + '<style is:global>\n\t.intro {\n\t\tcolor: red;\n\t}\n</style>\n');
  await undo(app);
  assert.equal(fs.readFileSync(page, 'utf8'), PAGE);
});

test('a CRLF page keeps its line endings in the block', async (context) => {
  const crlf = PAGE.replace(/\n/g, '\r\n');
  const { app, page } = await openProject(context, { text: crlf });
  await firstStyles(app, find((node) => node.name === 'h1').at, { css: RULE, className: 'class' });
  const written = fs.readFileSync(page, 'utf8');
  assert.ok(written.includes('<style is:global>'), 'the block is written');
  assert.equal(written.replace(/\r\n/g, ''), written.replace(/\r\n/g, '').replace(/\n/g, ''), 'no bare LF is left in a CRLF file');
  assert.equal(written, crlf.replace('<h1>', '<h1 class="class">') + BLOCK.replace(/\n/g, '\r\n'));
  await undo(app);
  assert.equal(fs.readFileSync(page, 'utf8'), crlf);
});

test('a page indented with spaces gets a block indented with spaces', async (context) => {
  const spaced = PAGE.replace(/\t/g, '  ');
  const { app, page } = await openProject(context, { text: spaced });
  await firstStyles(app, find((node) => node.name === 'h1').at, { css: RULE, className: 'class' });
  assert.equal(
    fs.readFileSync(page, 'utf8'),
    spaced.replace('<h1>', '<h1 class="class">') + '<style is:global>\n  .class {\n    padding: 1rem;\n  }\n</style>\n',
  );
});

const SHAPES_PAGE = [
  '---',
  'const items = ["a"];',
  '---',
  '<main>',
  '\t<div class:list={["a", { b: true }]}>list</div>',
  '\t<div class={`x ${"y"}`}>template</div>',
  '\t{items.map((item) => <li>{item}</li>)}',
  '</main>',
  '',
].join('\n');

// One app per case: each case starts from the same file and ends with a single undo.
for (const shape of [
  { name: 'a class:list', pick: (node) => Boolean(node.props?.['class:list']), after: SHAPES_PAGE.replace('{ b: true }]', '{ b: true }, "class"]') },
  {
    name: 'a template literal',
    pick: (node) => String(node.props?.class?.value).startsWith('`'),
    after: SHAPES_PAGE.replace('`x ${"y"}`', '`x ${"y"} class`'),
  },
  { name: 'an element in a loop', pick: (node) => node.name === 'li', after: SHAPES_PAGE.replace('<li>', '<li class="class">') },
]) {
  test(`${shape.name} takes the class the way it writes its classes`, async (context) => {
    const { app, page } = await openProject(context, { text: SHAPES_PAGE });
    const outcome = await firstStyles(app, find(shape.pick).at, { css: RULE, className: 'class' });
    assert.deepEqual(outcome, { tag: 'applied' });
    assert.equal(fs.readFileSync(page, 'utf8'), shape.after + BLOCK);
    await undo(app);
    assert.equal(fs.readFileSync(page, 'utf8'), SHAPES_PAGE, 'one undo');
  });
}

test('a component instance takes the class on its own tag, as a typed class does', async (context) => {
  const text = ['---', "import Card from '../components/Card.astro';", '---', '<main>', '\t<Card />', '</main>', ''].join('\n');
  const { app, page } = await openProject(context, { text, extra: { 'Card.astro': '<div class="card"></div>\n' } });
  const outcome = await firstStyles(app, find((node) => node.kind === 'component').at, { css: RULE, className: 'class' });
  assert.deepEqual(outcome, { tag: 'applied' });
  assert.equal(fs.readFileSync(page, 'utf8'), text.replace('<Card />', '<Card class="class" />') + BLOCK);
});

test('text with no tag is refused with a reason and the page is untouched', async (context) => {
  const text = ['<main>', '\tplain words', '</main>', ''].join('\n');
  const { app, page } = await openProject(context, { text });
  const words = find((node) => node.kind === 'text' && String(node.value).includes('plain'));
  const outcome = await firstStyles(app, words.at, { css: RULE, className: 'class' });
  assert.equal(outcome.tag, 'refused');
  assert.match(outcome.message, /no tag to hold a class/);
  assert.equal(fs.readFileSync(page, 'utf8'), text);
});

test('a class name that cannot be written is refused before the block is queued', async (context) => {
  const { app, page } = await openProject(context);
  const outcome = await firstStyles(app, find((node) => node.name === 'h1').at, { css: RULE, className: 'two classes' });
  assert.equal(outcome.tag, 'refused');
  assert.equal(fs.readFileSync(page, 'utf8'), PAGE, 'no block without its class');
});

test('a Markdown page is refused: it has no place for a style block', async (context) => {
  const text = '# Title\n\nSome words.\n';
  const { app, page } = await openProject(context, { file: 'notes.md', text });
  await select(app, [0]);
  let outcome;
  await gesture(app, async () => {
    outcome = await __panels.StylePanel.onAddStyleBlock({ css: RULE, className: 'class', placement: PLACEMENT_END });
  });
  assert.equal(outcome.tag, 'refused');
  assert.equal(fs.readFileSync(page, 'utf8'), text);
});

test('inside an opened component the block and class land in the component, not the page', async (context) => {
  const text = ['---', "import Card from '../components/Card.astro';", '---', '<main>', '\t<Card />', '</main>', ''].join('\n');
  const card = '<div class="card">\n\t<h2>Title</h2>\n</div>\n';
  const { app, page } = await openProject(context, { text, extra: { 'Card.astro': card } });
  const cardPath = path.join(path.dirname(page), '..', 'components', 'Card.astro');
  await app.act(async () => {
    __panels.StructurePanel.onOpenComponent('Card', find((node) => node.kind === 'component').node.id);
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  const outcome = await firstStyles(app, find((node) => node.name === 'h2').at, { css: RULE, className: 'class' });
  assert.deepEqual(outcome, { tag: 'applied' });
  assert.equal(fs.readFileSync(cardPath, 'utf8'), card.replace('<h2>', '<h2 class="class">') + BLOCK);
  assert.equal(fs.readFileSync(page, 'utf8'), text, 'the page is untouched');
  await undo(app);
  assert.equal(fs.readFileSync(cardPath, 'utf8'), card, 'one undo restores the component');
});
