// Goal: navigator wrapping persists through the real edit engine and undoes exactly.
// Method: mount the app over temporary Astro files, invoke the navigator callback,
// and compare disk bytes for ordinary wrapping and named-slot preservation.
// Open the real canvas menu too, proving that it selects and edits the right source node.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gesture, mountApp, nodeAt, undo } = require('../../helpers/appGestures.js');

const source = [
  '---',
  "import Card from '../components/Card.astro';",
  '---',
  '<main><section class="hero"><span>Hello</span></section>',
  '<Card><h2 slot="heading">Heading</h2></Card></main>',
  '',
].join('\n');

test('navigator wrappers save and undo through the document engine', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-navigator-wrap-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src/pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/components'), { recursive: true });
  const file = path.join(root, 'src/pages/index.astro');
  const card = path.join(root, 'src/components/Card.astro');
  fs.writeFileSync(file, source);
  fs.writeFileSync(card, '<div><slot name="heading" /></div>\n');
  const scan = {
    pages: [{ name: 'index.astro', path: file, route: '/' }],
    components: [{ name: 'Card', path: card, folder: '' }],
    layouts: [],
    pageFolders: [],
  };
  const app = await mountApp(root, { scan }, 'navigator-wrap-save');
  context.after(app.unmount);
  const disk = () => fs.readFileSync(file, 'utf8');
  await gesture(app, () => __panels.StructurePanel.onWrapNode(nodeAt([0, 0]).id, 'div'));
  assert.equal(disk(), source.replace('<section', '<div>\n<section').replace('</section>', '</section>\n</div>'));
  assert.equal(nodeAt([0, 0]).name, 'div');
  assert.ok(nodeAt([0, 0]).children.some((node) => node.name === 'section'));
  await undo(app);
  assert.equal(disk(), source);
  await gesture(app, () => __panels.StructurePanel.onWrapNode(nodeAt([0, 0]).id, 'a'));
  assert.equal(disk(), source.replace('<section', '<a>\n<section').replace('</section>', '</section>\n</a>'));
  await undo(app);
  assert.equal(disk(), source);
  // Locate the component by kind because parser whitespace occupies sibling slots.
  const cardNode = nodeAt([0]).children.find((node) => node.kind === 'component');
  const heading = cardNode.children.find((node) => node.name === 'h2');
  await gesture(app, () => __panels.StructurePanel.onWrapNode(heading.id, 'div'));
  assert.match(disk(), /<div slot="heading">\s*<h2>Heading<\/h2>\s*<\/div>/);
  await undo(app);
  assert.equal(disk(), source);

  await app.act(() =>
    __panels.PreviewPane.onContextPath('0.0', {
      left: 300,
      top: 200,
      occurrence: 0,
      outside: false,
    }),
  );
  const menu = document.querySelector('[aria-label="Element actions"]');
  assert.ok(menu, 'the canvas opens the navigator action menu');
  assert.equal(document.activeElement, menu, 'no action is initially focused');
  assert.equal(__panels.StructurePanel.selectedId, nodeAt([0, 0]).id);
  const item = (label) => [...document.querySelectorAll('[role="menuitem"]')].find((entry) => entry.firstElementChild?.textContent === label);
  await app.act(() => item('Wrap in').click());
  await gesture(app, () => item('div').click());
  assert.equal(nodeAt([0, 0]).name, 'div');
  assert.match(disk(), /<div>\s*<section class="hero">/);
  await undo(app);
  assert.equal(disk(), source, 'canvas wrapping uses the same undoable edit');
  // An earlier menu's animated dismissal must not close a replacement right-click menu.
  await app.act(() =>
    __panels.PreviewPane.onContextPath('0.0', {
      left: 300,
      top: 200,
      occurrence: 0,
      outside: false,
    }),
  );
  await app.act(async () => {
    window.dispatchEvent(
      new window.MessageEvent('message', {
        data: { type: 'avb:context-node' },
      }),
    );
    await Promise.resolve();
    __panels.PreviewPane.onContextPath('0.0', {
      left: 300,
      top: 200,
      occurrence: 0,
      outside: false,
    });
  });
  await app.act(() => new Promise((resolve) => setTimeout(resolve, 200)));
  assert.ok(document.querySelector('[aria-label="Element actions"]'));
  assert.equal(document.querySelector('[data-popup-phase="closing"]') ?? undefined, undefined);
});
