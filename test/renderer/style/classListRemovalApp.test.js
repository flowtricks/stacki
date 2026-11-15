// Goal: a class chip selected in the Style panel, then Delete, takes the class
// off the element even when the element writes it inside `class:list` — the
// friend's report: a class:list class answered with "Stacki leaves it for you
// to remove in code" and nothing else. Every shape Stacki can rewrite reaches
// disk as one minimal edit (only the class's own text changes, CRLF and tabs
// and comments kept), as one undo step that gives back the exact bytes, and
// redo puts the edit back. A class only computed code could give is refused
// with that code named, the file untouched, and a 'Show in code' action that
// opens the Code panel on the exact piece of code.
//
// Method: the real App in jsdom over a real document host
// (test/helpers/appGestures.js), on a fixture project. The Style panel's
// removal callback is driven as the panel's Delete drives it
// (`onRemoveClass`, SelectorPicker.tsx removeChipFromElement); then the file is
// read back and compared byte for byte, ⌘Z must restore the original bytes and
// ⇧⌘Z the edit. The panel's own keyboard half (focus, key repeat, the chip
// going at once) is selectorCaret.test.js; the shapes one by one are
// test/shared/engine/classExpressionRemoval.test.ts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gesture, mountApp, select, undo } = require('../../helpers/appGestures.js');

const errorToasts = () => [...document.querySelectorAll('.toast.error')];

// A project holding one page, and the app open on it.
async function openProject(context, text, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-class-list-removal-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  fs.mkdirSync(path.join(root, 'src', 'pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'components'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"astro":"*"}}');
  const page = path.join(root, 'src', 'pages', 'index.astro');
  fs.writeFileSync(page, text);
  const components = [];
  for (const [name, content] of Object.entries(extra)) {
    const componentPath = path.join(root, 'src', 'components', name);
    fs.writeFileSync(componentPath, content);
    components.push({ name: name.replace(/\.astro$/, ''), path: componentPath, folder: '' });
  }
  const scan = { pages: [{ name: 'index.astro', path: page, route: '/' }], components, layouts: [], pageFolders: [] };
  const bridge = { resolveImport: async () => ({ path: components[0]?.path }), watchProject: async () => ({ ok: true }) };
  const app = await mountApp(root, { scan }, 'class-list-removal', { bridge });
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

async function removeClass(app, at, name) {
  await select(app, at);
  let outcome;
  await gesture(app, async () => {
    outcome = await __panels.StylePanel.onRemoveClass(name, __panels.StylePanel.node.id);
  });
  return outcome;
}

async function redo(app) {
  await gesture(app, async () => {
    document.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: true, bubbles: true }));
  });
}

const page = (...body) => ['---', 'const open = true;', 'const { class: className } = Astro.props;', '---', ...body, ''].join('\n');

const SHAPES = [
  {
    name: 'a list of strings',
    text: page("<div class:list={['card', 'is-open']}>x</div>"),
    remove: 'is-open',
    after: page("<div class:list={['card']}>x</div>"),
  },
  {
    name: 'one word of several',
    text: page("<a class:list={['btn btn-primary', { active: open }]}>x</a>"),
    remove: 'btn-primary',
    after: page("<a class:list={['btn', { active: open }]}>x</a>"),
  },
  {
    name: 'an object key',
    text: page("<a class:list={['btn', { active: open, 'is-wide': open }]}>x</a>"),
    remove: 'active',
    after: page("<a class:list={['btn', { 'is-wide': open }]}>x</a>"),
  },
  {
    name: 'a guarded entry',
    text: page('<a class:list={["btn", open && "is-open"]}>x</a>'),
    remove: 'is-open',
    after: page('<a class:list={["btn"]}>x</a>'),
  },
  {
    name: 'a ternary arm',
    text: page("<a class:list={['btn', open ? 'is-open' : 'is-closed']}>x</a>"),
    remove: 'is-open',
    after: page("<a class:list={['btn', open ? '' : 'is-closed']}>x</a>"),
  },
  {
    name: 'a template word',
    text: page('<a class:list={[`btn ${className}`]}>x</a>'),
    remove: 'btn',
    after: page('<a class:list={[`${className}`]}>x</a>'),
  },
  {
    name: 'the only entry',
    text: page("<div class:list={['card']}>x</div>"),
    remove: 'card',
    after: page('<div>x</div>'),
  },
  {
    name: 'class and class:list both',
    text: page("<div class=\"card\" class:list={['card', 'is-open']}>x</div>"),
    remove: 'card',
    after: page("<div class:list={['is-open']}>x</div>"),
  },
  {
    name: 'a list broken over lines, with tabs and a comment',
    text: page('<div', '\tclass:list={[', "\t\t'card',", "\t\t'is-open', // toggled", '\t\tclassName,', '\t]}', '>x</div>'),
    remove: 'is-open',
    after: page('<div', '\tclass:list={[', "\t\t'card',", '\t\tclassName,', '\t]}', '>x</div>'),
  },
  {
    name: 'Tailwind names',
    text: page("<div class:list={['md:flex', 'w-[10px]', 'hover:bg-red-500']}>x</div>"),
    remove: 'w-[10px]',
    after: page("<div class:list={['md:flex', 'hover:bg-red-500']}>x</div>"),
  },
];

for (const shape of SHAPES) {
  test(`${shape.name}: Delete takes the class out of class:list in one undo step`, async (context) => {
    const { app, page: file } = await openProject(context, shape.text);
    const element = find((node) => node.kind === 'element' && (node.name === 'div' || node.name === 'a'));
    const outcome = await removeClass(app, element.at, shape.remove);
    assert.deepEqual(outcome, { tag: 'applied' });
    assert.equal(fs.readFileSync(file, 'utf8'), shape.after);
    assert.deepEqual(
      errorToasts().map((toast) => toast.textContent),
      [],
      'no refusal on a shape Stacki can rewrite',
    );
    await undo(app);
    assert.equal(fs.readFileSync(file, 'utf8'), shape.text, 'one undo gives back every byte');
    await redo(app);
    assert.equal(fs.readFileSync(file, 'utf8'), shape.after, 'redo puts the edit back');
  });
}

test('a CRLF file keeps its line endings', async (context) => {
  const text = page('<div class:list={[', "  'card',", "  'is-open',", ']}>x</div>').replace(/\n/g, '\r\n');
  const { app, page: file } = await openProject(context, text);
  await removeClass(app, find((node) => node.name === 'div').at, 'card');
  assert.equal(fs.readFileSync(file, 'utf8'), page('<div class:list={[', "  'is-open',", ']}>x</div>').replace(/\n/g, '\r\n'));
  await undo(app);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
});

test('a component instance loses the class at its call site', async (context) => {
  const text = ['---', "import Card from '../components/Card.astro';", '---', "<Card class:list={['a', 'b']} />", ''].join('\n');
  const { app, page: file } = await openProject(context, text, { 'Card.astro': '<div class="card"></div>\n' });
  const outcome = await removeClass(app, find((node) => node.kind === 'component').at, 'a');
  assert.deepEqual(outcome, { tag: 'applied' });
  assert.equal(fs.readFileSync(file, 'utf8'), text.replace("['a', 'b']", "['b']"));
});

test('a class only computed code could give is refused, the file untouched, with Show in code', async (context) => {
  const text = page("<div class:list={['card', className]}>x</div>");
  const { app, page: file } = await openProject(context, text);
  const element = find((node) => node.name === 'div');
  const outcome = await removeClass(app, element.at, 'from-prop');
  assert.equal(outcome.tag, 'refused');
  assert.match(outcome.message, /“from-prop” may come from className in class:list/);
  assert.equal(fs.readFileSync(file, 'utf8'), text, 'nothing is written');
  const toast = errorToasts().find((candidate) => candidate.textContent.includes('from-prop'));
  assert.ok(toast, 'the refusal is shown');
  const action = [...toast.querySelectorAll('.toast-recovery')].find((button) => button.textContent === 'Show in code');
  assert.ok(action, 'with a Show in code action');
  await app.act(async () => {
    action.dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  const code = __panels.CodePanel;
  assert.ok(code, 'the Code panel opens');
  assert.equal(code.selectedId, element.node.id, 'on the element');
  assert.ok(code.revealRange, 'at a range of its own');
  assert.equal(text.slice(code.revealRange.from, code.revealRange.to), 'className', 'the exact code the class may come from');
  // Asking again does not stack the same message: the toast stack keeps one of each.
  await removeClass(app, element.at, 'from-prop');
  assert.equal(errorToasts().filter((candidate) => candidate.textContent.includes('from-prop')).length, 1);
});

test('a class written nowhere on the element says so, with nothing to show', async (context) => {
  const text = page("<div class:list={['card']}>x</div>");
  const { app, page: file } = await openProject(context, text);
  const outcome = await removeClass(app, find((node) => node.name === 'div').at, 'elsewhere');
  assert.equal(outcome.tag, 'refused');
  assert.match(outcome.message, /isn’t written on this element/);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
});
