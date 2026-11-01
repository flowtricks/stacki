// Goal: every write the style panel makes through the open file lands on disk,
// in the file it was meant for, and none reports a refusal after it succeeded.
// The panel reaches the page model three ways — a <style> block's CSS, a class
// put on the selected element, and an inline style from the props panel — and
// each is checked where users meet it: an element of the page, a component
// instance, an element inside a loop, and an element inside an opened
// component. Two defects once made nearly every <style> edit report a save
// failure: the projection classed a <style> as opaque code, so
// the planner refused every rewrite of it; and the panel's commit restates the
// CSS its live writes already put in the model, a request that changes
// nothing, which the planner refuses too. A third wrote a page's CSS into a
// component's <style>: node ids are tree paths, so both files' first block is
// `n1`, and the write named only the id.
// Method: the real App in jsdom with stub panels (test/helpers/appGestures.js), over
// a bridge whose edits go through main's own translation and a real document
// host. The style panel's callbacks are driven exactly as the panel drives
// them: live writes while a value is typed, then the commit of the same CSS;
// a typed class through `onAddClass`. Each case reads the file back and checks
// the toasts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gesture, mountApp, nodeAt, select, tick } = require('../../helpers/appGestures.js');

const PAGE = [
  '---',
  "import Card from '../components/Card.astro';",
  'const items = ["a", "b"];',
  '---',
  '<main>',
  '  <h1 class="hero">Hi</h1>',
  '  <p>No class</p>',
  '  <div class:list={["a", { b: true }]}>list</div>',
  '  <div class={`x ${"y"}`}>template</div>',
  '  <div class={items.join(" ")}>code</div>',
  '  <span style="color: red">inline</span>',
  '  <Card />',
  '  <Card class="c" />',
  '  {items.map((item) => <li class="item">{item}</li>)}',
  '</main>',
  '<style>',
  '  .hero {',
  '    font-size: 48px;',
  '  }',
  '</style>',
  '',
].join('\n');

const CARD = ['<div class="card"><h2 class="title">T</h2><slot /></div>', '<style>', '  .card {', '    padding: 1px;', '  }', '</style>', ''].join('\n');

const refusals = () => [...document.querySelectorAll('.toast.error')].map((toast) => toast.textContent);

// A project with the page and the Card component, the app open on the page.
async function openProject(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-style-writes-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src', 'pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'components'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"astro":"*"}}');
  const page = path.join(root, 'src', 'pages', 'index.astro');
  const card = path.join(root, 'src', 'components', 'Card.astro');
  fs.writeFileSync(page, PAGE);
  fs.writeFileSync(card, CARD);
  const scan = {
    pages: [{ name: 'index.astro', path: page, route: '/' }],
    components: [{ name: 'Card', path: card, folder: '' }],
    layouts: [],
    pageFolders: [],
  };
  const bridge = {
    resolveImport: async () => ({ path: card }),
    watchProject: async () => ({ ok: true }),
  };
  const app = await mountApp(root, { scan }, 'style-writes', { bridge });
  context.after(app.unmount);
  return { app, page, card };
}

// The first node of the open file's model, in document order, that `matches`.
function find(matches) {
  const pending = __panels.StructurePanel.pageState.model.nodes.map((node, index) => ({
    node,
    at: [index],
  }));
  for (let visited = 0; visited < pending.length; visited++) {
    const { node, at } = pending[visited];
    if (matches(node)) {
      return { node, at };
    }
    (node.children ?? []).forEach((child, index) => pending.push({ node: child, at: [...at, index] }));
  }
  assert.fail('a node matches');
}

async function openCard(app) {
  const instance = find((node) => node.kind === 'component');
  await app.act(async () => {
    __panels.StructurePanel.onOpenComponent('Card', instance.node.id);
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  assert.equal(find((node) => node.kind === 'element').node.name, 'div', 'the Card is open');
}

async function addClass(app, at, className) {
  await select(app, at);
  let outcome;
  await gesture(app, async () => {
    outcome = await __panels.StylePanel.onAddClass(className);
  });
  return outcome;
}

test("a page's <style> takes writes; a commit reports none refused", async (context) => {
  const { app, page } = await openProject(context);
  await select(app, [0, 0]);
  const style = nodeAt([1]);
  assert.equal(style.kind, 'raw');
  assert.equal(style.name, 'style');
  const target = { nodeId: style.id, filePath: page };
  const write = (css, immediate) => __panels.StylePanel.onWriteStyleNode(target, css, immediate);
  const typed = style.inner.replace('48px', '30px');

  // Typing: live writes as the value changes, then Enter commits the value.
  await gesture(app, async () => {
    assert.notEqual(write(style.inner.replace('48px', '3px'), false), false);
    assert.notEqual(write(typed, false), false);
  });
  await gesture(app, async () => {
    assert.notEqual(write(typed, true), false, 'the commit names a node of the open file');
  });
  assert.equal(fs.readFileSync(page, 'utf8'), PAGE.replace('48px', '30px'), 'the rule changed');
  assert.deepEqual(refusals(), [], 'no refusal is reported for an edit that applied');

  // Re-entering the value the rule already has changes nothing and says nothing.
  await gesture(app, async () => {
    write(typed, true);
  });
  assert.equal(fs.readFileSync(page, 'utf8'), PAGE.replace('48px', '30px'));
  assert.deepEqual(refusals(), [], 'a value left as it was is not a refused edit');
});

test("an opened component's <style> takes writes; the page's block is refused", async (context) => {
  const { app, page, card } = await openProject(context);
  const pageStyle = nodeAt([1]);
  await openCard(app);
  const cardStyle = find((node) => node.kind === 'raw' && node.name === 'style').node;
  // The collision the file in the target guards against: both blocks are `n1`.
  assert.equal(cardStyle.id, pageStyle.id, 'the two files share the id');

  await gesture(app, async () => {
    const target = { nodeId: cardStyle.id, filePath: card };
    const css = cardStyle.inner.replace('1px', '2px');
    assert.notEqual(__panels.StylePanel.onWriteStyleNode(target, css, true), false);
  });
  assert.equal(fs.readFileSync(card, 'utf8'), CARD.replace('1px', '2px'), 'the Card rule changed');

  // The page's block, written while the Card is open: refused, not misplaced.
  let written;
  await gesture(app, async () => {
    const target = { nodeId: pageStyle.id, filePath: page };
    written = __panels.StylePanel.onWriteStyleNode(target, '.page { color: red; }', true);
  });
  assert.equal(written, false, 'a block of another file is reported, not written');
  assert.equal(fs.readFileSync(card, 'utf8'), CARD.replace('1px', '2px'), 'the Card is untouched');
  assert.equal(fs.readFileSync(page, 'utf8'), PAGE, 'the page is untouched');
  assert.deepEqual(refusals(), []);
});

test('a typed class lands on every kind of element the panel can select', async (context) => {
  const { app, page } = await openProject(context);
  const cases = [
    { name: 'a class attribute', matches: (node) => node.name === 'h1' },
    { name: 'no class at all', matches: (node) => node.name === 'p' },
    { name: 'a class:list', matches: (node) => Boolean(node.props?.['class:list']) },
    {
      name: 'a template literal',
      matches: (node) => String(node.props?.class?.value).startsWith('`'),
    },
    {
      name: 'a component without a class',
      matches: (node) => node.kind === 'component' && !node.props?.class,
    },
    {
      name: 'a component with a class',
      matches: (node) => node.kind === 'component' && node.props?.class?.value === 'c',
    },
    { name: 'an element in a loop', matches: (node) => node.name === 'li' },
  ];
  for (const { name, matches } of cases) {
    const outcome = await addClass(app, find(matches).at, 'added');
    assert.deepEqual(outcome, { tag: 'applied' }, name);
  }
  assert.equal(
    fs.readFileSync(page, 'utf8'),
    PAGE.replace('class="hero"', 'class="hero added"')
      .replace('<p>', '<p class="added">')
      .replace('{ b: true }]', '{ b: true }, "added"]')
      .replace('`x ${"y"}`', '`x ${"y"} added`')
      .replace('<Card />', '<Card class="added" />')
      .replace('class="c"', 'class="c added"')
      .replace('class="item"', 'class="item added"'),
    'each class is written the way that element writes its classes',
  );
  assert.deepEqual(refusals(), []);
});

test('a computed class stays intact when the style panel adds another class', async (context) => {
  const { app, page } = await openProject(context);
  const coded = find((node) => String(node.props?.class?.value).includes('join'));
  const outcome = await addClass(app, coded.at, 'added');
  assert.equal(outcome.tag, 'applied');
  assert.equal(fs.readFileSync(page, 'utf8'), PAGE.replace('class={items.join(" ")}', 'class:list={[(items.join(" ")), "added"]}'));
  assert.deepEqual(refusals(), []);
});

test('an invalid class name reports an error without changing the page', async (context) => {
  const { app, page } = await openProject(context);
  const heading = find((node) => node.name === 'h1');
  const outcome = await addClass(app, heading.at, 'two classes');
  assert.equal(outcome.tag, 'refused');
  assert.equal(fs.readFileSync(page, 'utf8'), PAGE);
  assert.deepEqual(refusals(), ['Stacki couldn’t add the class “two classes”. Check the class name and retry.']);
});

test('a typed class lands on an element inside an opened component', async (context) => {
  const { app, page, card } = await openProject(context);
  await openCard(app);
  const title = find((node) => node.name === 'h2');
  assert.deepEqual(await addClass(app, title.at, 'added'), { tag: 'applied' });
  assert.equal(fs.readFileSync(card, 'utf8'), CARD.replace('class="title"', 'class="title added"'));
  assert.equal(fs.readFileSync(page, 'utf8'), PAGE, 'the page is untouched');
  assert.deepEqual(refusals(), []);
});

test('an inline style is edited in place, and added where there is none', async (context) => {
  const { app, page } = await openProject(context);
  const style = (value) => ({ type: 'string', value });
  await select(app, find((node) => node.name === 'span').at);
  await gesture(app, async () => {
    __panels.PropsPanel.onSetProp('style', style('color: blue'), true);
  });
  await select(app, find((node) => node.name === 'p').at);
  await gesture(app, async () => {
    __panels.PropsPanel.onSetProp('style', style('color: blue'), true);
    await tick();
  });
  assert.equal(fs.readFileSync(page, 'utf8'), PAGE.replace('style="color: red"', 'style="color: blue"').replace('<p>', '<p style="color: blue">'));
  assert.deepEqual(refusals(), []);
});
