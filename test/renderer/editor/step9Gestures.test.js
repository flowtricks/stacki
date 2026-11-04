// Goal: every gesture the whole-model save used to carry reaches disk as edit
// requests (plan §11 step 9): rewording a note, renaming a prop, changing a
// tag or a component, setting content, a condition's test and its else
// branch, and picking, renaming or removing a layout — each writes only its
// own bytes (the whole-model save no longer exists: step 10 retired
// `page:write`), and undoing every gesture restores the file byte for byte.
// Method: the real App in jsdom with stub panels that capture their props, as
// in pageNavigation.test.js. The bridge serves a real file in a temporary
// folder: `page:read` parses it with the real parser, and `page:edit` does
// what main's handler does — the real document host (electron/documents/documentActors.ts)
// submits each request through main's own translation (editRequests.ts), so
// requests of one gesture rebase through the host's commit log exactly as in
// the app. Undo is the ⌘Z the user presses.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gesture, mountApp, nodeAt, select, tick, undo } = require('../../helpers/appGestures.js');
const { digestOf } = require('#dist/electron/documents/atomicWrite.js');

const PAGE = [
  '---',
  "import Card from '../components/Card.astro';",
  '---',
  '<main>',
  '  <!-- Hero note -->',
  '  <section class="hero" title="Hi">',
  '    <p>Hello</p>',
  '  </section>',
  '  <div id="box">text</div>',
  '  {show && (<p>Shown</p>)}',
  '  <Card />',
  '</main>',
  '',
].join('\n');

const LAYOUT_PAGE = ['---', "import Base from '../layouts/Base.astro';", '---', '<Base>', '  <main>m</main>', '</Base>', ''].join('\n');

test('each converted gesture writes only its bytes; undo restores every byte', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-step9-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src/pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/components'), { recursive: true });
  const file = path.join(root, 'src/pages/index.astro');
  const card = path.join(root, 'src/components/Card.astro');
  fs.writeFileSync(file, PAGE);
  fs.writeFileSync(card, '<div><slot /></div>\n');
  const scan = {
    pages: [{ name: 'index.astro', path: file, route: '/' }],
    components: [{ name: 'Card', path: card, folder: '' }],
    layouts: [],
    pageFolders: [],
  };
  const app = await mountApp(root, { scan }, 'step9-gestures');
  context.after(app.unmount);
  const disk = () => fs.readFileSync(file, 'utf8');
  const expectDisk = (lines, what) => assert.equal(disk(), lines.join('\n'), what);
  const body = (rest) => ['---', "import Card from '../components/Card.astro';", '---', ...rest, ''];

  // The note above the section, reworded: its words only.
  await select(app, [0, 1]);
  await gesture(app, async () => {
    __panels.PropsPanel.onSetComment('Hero section');
  });
  expectDisk(
    body([
      '<main>',
      '  <!-- Hero section -->',
      '  <section class="hero" title="Hi">',
      '    <p>Hello</p>',
      '  </section>',
      '  <div id="box">text</div>',
      '  {show && (<p>Shown</p>)}',
      '  <Card />',
      '</main>',
    ]),
    'the note is reworded in place',
  );
  // A prop renamed: its name only.
  await gesture(app, async () => {
    __panels.PropsPanel.onRenameProp('title', 'aria-label');
  });
  // The tag changed: both names; its global and aria attributes stay.
  await gesture(app, async () => {
    await __panels.PropsPanel.onChangeTag('article');
  });
  expectDisk(
    body([
      '<main>',
      '  <!-- Hero section -->',
      '  <article class="hero" aria-label="Hi">',
      '    <p>Hello</p>',
      '  </article>',
      '  <div id="box">text</div>',
      '  {show && (<p>Shown</p>)}',
      '  <Card />',
      '</main>',
    ]),
    'the prop and the tag are renamed where they are written',
  );
  // Content set on the box: its text only.
  await select(app, [0, 2]);
  await gesture(app, async () => {
    __panels.PropsPanel.onSetContent('new text');
  });
  // The box becomes a Card: its names, and the import it already has.
  await gesture(app, async () => {
    await __panels.PropsPanel.onChangeTag('Card');
  });
  expectDisk(
    body([
      '<main>',
      '  <!-- Hero section -->',
      '  <article class="hero" aria-label="Hi">',
      '    <p>Hello</p>',
      '  </article>',
      '  <Card id="box">new text</Card>',
      '  {show && (<p>Shown</p>)}',
      '  <Card />',
      '</main>',
    ]),
    'the content and the component change land on their bytes',
  );
  // The condition: its test, then an else branch.
  await select(app, [0, 3]);
  await gesture(app, async () => {
    __panels.PropsPanel.onSetText('visible');
  });
  assert.match(disk(), /\{visible && \(<p>Shown<\/p>\)\}/, 'the test is rewritten in place');
  await gesture(app, async () => {
    __panels.PropsPanel.onToggleElse(true);
  });
  assert.match(disk(), /\{visible \? \(/, 'the else branch is added');
  // Undo every gesture, newest first: the file comes back byte for byte.
  for (let step = 0; step < 7; step++) {
    await undo(app);
  }
  assert.equal(disk(), PAGE, 'undo restores every byte');
});

test('paste and extract-to-component insert, remove and import as requests', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-step9-paste-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src/pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/components'), { recursive: true });
  const file = path.join(root, 'src/pages/index.astro');
  const start = '---\n---\n<main>\n  <p class="a">One</p>\n  <div>Two</div>\n</main>\n';
  fs.writeFileSync(file, start);
  const scan = {
    pages: [{ name: 'index.astro', path: file, route: '/' }],
    components: [],
    layouts: [],
    pageFolders: [],
  };
  const app = await mountApp(root, { scan }, 'step9-gestures');
  context.after(app.unmount);
  const disk = () => fs.readFileSync(file, 'utf8');
  // Copy the paragraph, select the div, paste: a new node after the div.
  await gesture(app, async () => {
    __panels.StructurePanel.onCopyNode(nodeAt([0, 0]).id);
  });
  await select(app, [0, 1]);
  await gesture(app, async () => {
    await __panels.StructurePanel.onPasteNode();
  });
  // A tag that holds children takes the paste as its last child (the rule
  // the whole-model paste had): one insertion, inside the selection.
  assert.equal(
    disk(),
    '---\n---\n<main>\n  <p class="a">One</p>\n  <div>Two<p class="a">One</p></div>\n</main>\n',
    'the paste is one insertion inside the selection',
  );
  // The div becomes a component of its own: the instance goes in, the markup
  // comes out, and the page imports it.
  const created = path.join(root, 'src/components/Two.astro');
  global.avb.createComponent = async () => {
    const bytes = '<div>Two<p class="a">One</p></div>\n';
    fs.writeFileSync(created, bytes);
    // The checksum of what was written: undo deletes the file only while it still holds it.
    return { path: created, rel: 'src/components/Two.astro', name: 'Two', checksum: digestOf(bytes) };
  };
  await select(app, [0, 1]);
  const components = [...document.querySelectorAll('.rail-btn')].find((button) => String(button.getAttribute('aria-label')).startsWith('Components'));
  assert.ok(components, 'the Components rail button');
  await app.act(async () => {
    components.click();
    await tick();
  });
  await gesture(app, async () => {
    await __panels.PalettePanel.onCreateComponent('Two');
  });
  assert.equal(
    disk(),
    "---\nimport Two from '../components/Two.astro';\n---\n" + '<main>\n  <p class="a">One</p>\n  <Two />\n</main>\n',
    'extract: an instance where the markup was, and its import',
  );
});

test('a layout renamed, removed and picked again reaches disk as requests', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-step9-layout-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src/pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/layouts'), { recursive: true });
  const file = path.join(root, 'src/pages/index.astro');
  const base = path.join(root, 'src/layouts/Base.astro');
  const other = path.join(root, 'src/layouts/Other.astro');
  fs.writeFileSync(file, LAYOUT_PAGE);
  fs.writeFileSync(base, '<slot />\n');
  fs.writeFileSync(other, '<slot />\n');
  const scan = {
    pages: [{ name: 'index.astro', path: file, route: '/' }],
    components: [],
    layouts: [
      { name: 'Base', path: base, folder: 'layouts' },
      { name: 'Other', path: other, folder: 'layouts' },
    ],
    pageFolders: [],
  };
  const app = await mountApp(root, { scan }, 'step9-gestures');
  context.after(app.unmount);
  const disk = () => fs.readFileSync(file, 'utf8');
  await gesture(app, async () => {
    await __panels.StructurePanel.onChangeLayout('Other');
  });
  assert.equal(
    disk(),
    "---\nimport Other from '../layouts/Other.astro';\n---\n<Other>\n  <main>m</main>\n</Other>\n",
    'the wrapper is renamed and its import follows',
  );
  await gesture(app, async () => {
    await __panels.StructurePanel.onChangeLayout('');
  });
  assert.equal(disk(), '---\n---\n  <main>m</main>\n', 'removed: its tags and its import go, the page stays');
  await gesture(app, async () => {
    await __panels.StructurePanel.onChangeLayout('Base');
  });
  assert.equal(
    disk(),
    "---\nimport Base from '../layouts/Base.astro';\n---\n  <Base>\n  <main>m</main>\n  </Base>\n",
    'picked again: the page is wrapped as written, and the import added',
  );
});
