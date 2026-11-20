// Create component with "Move styles", driven through the real App (test/helpers/appGestures.js), then the user's ⌘Z.
// Goal: the move is whole (the page uses the component, the moved rule left the page's `<style>`, the journal written
// and cleared), the new instance is selected under an id of its own, so the Style panel takes it as a new selection,
// and one ⌘Z takes the whole move back: the page byte for byte and the new file gone. Methodology: the page's own
// `<style>` holds the moved rule, so the move needs no stylesheet; the bridge logs its create, scan and journal calls
// in order, and the assertions read that log, the Navigator's props and the files on disk.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gesture, mountApp, nodeAt, select, sha256, tick, undo } = require('../../helpers/appGestures.js');

const PAGE = '---\n---\n<main>\n  <div class="portfolio"><p>One</p></div>\n</main>\n<style>\n  .portfolio { display: grid; }\n</style>\n';
const COMPONENT = '<div class="portfolio"><p>One</p></div>\n<style is:global>\n  .portfolio { display: grid; }\n</style>\n';

test('Move styles: the move is whole, the instance is a new selection, and ⌘Z takes the move back', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-move-flow-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src/pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/components'), { recursive: true });
  const file = path.join(root, 'src/pages/index.astro');
  const created = path.join(root, 'src/components/Portfolio.astro');
  fs.writeFileSync(file, PAGE);
  const scan = { pages: [{ name: 'index.astro', path: file, route: '/' }], components: [], layouts: [], pageFolders: [] };
  const events = [];
  const journal = [];
  const bridge = {
    scanProject: async () => {
      events.push(scan.components.length > 0 ? 'scan:with-component' : 'scan');
      return scan;
    },
    listStyleFiles: async () => ({ files: [] }),
    // As main resolves it: a path inside the project, relative to its root or absolute.
    readSourceText: async ({ rel }) => ({ text: fs.readFileSync(path.resolve(root, rel), 'utf8') }),
    recordStyleMove: async () => {
      journal.push('record');
      return { ok: true };
    },
    clearStyleMove: async () => {
      journal.push('clear');
      return { ok: true };
    },
    createComponent: async () => {
      events.push('create');
      fs.writeFileSync(created, COMPONENT);
      // As main's scan finds it from now on.
      scan.components = [{ name: 'Portfolio', path: created, folder: 'components' }];
      return { path: created, rel: 'src/components/Portfolio.astro', name: 'Portfolio', checksum: sha256(COMPONENT), folders: [] };
    },
    discardComponent: async () => {
      fs.rmSync(created);
      scan.components = [];
      return { outcome: 'deleted' };
    },
  };
  const app = await mountApp(root, { scan }, 'component-move-flow', { bridge });
  context.after(app.unmount);
  await select(app, [0, 0]);
  const selectedBefore = __panels.StructurePanel.selectedId;
  const components = [...document.querySelectorAll('.rail-btn')].find((button) => String(button.getAttribute('aria-label')).startsWith('Components'));
  assert.ok(components, 'the Components rail button');
  await app.act(async () => {
    components.click();
    await tick();
  });
  await gesture(app, async () => {
    await __panels.PalettePanel.onCreateComponent('Portfolio', { asProp: [], folder: 'src/components', moveStyles: ['portfolio'] });
  });
  // Back to the Navigator: its props are what the app shows now, not what it showed when the Components panel opened.
  const navigator = [...document.querySelectorAll('.rail-btn')].find((button) => String(button.getAttribute('aria-label')).startsWith('Navigator'));
  assert.ok(navigator, 'the Navigator rail button');
  await app.act(async () => {
    navigator.click();
    await tick();
  });
  assert.equal(
    fs.readFileSync(file, 'utf8'),
    "---\nimport Portfolio from '../components/Portfolio.astro';\n---\n<main>\n  <Portfolio />\n</main>\n",
    'the page uses the component, and its `<style>`, left empty by the move, is gone',
  );
  assert.deepEqual(journal, ['record', 'record', 'clear'], 'the journal is written, learns the saved page, and goes once the move is whole');
  const instance = nodeAt([0, 0]);
  assert.equal(instance.kind, 'component');
  assert.equal(instance.name, 'Portfolio', 'the instance is where the markup was');
  assert.equal(__panels.StructurePanel.selectedId, instance.id, 'the instance is selected');
  assert.notEqual(instance.id, selectedBefore, 'under an id of its own: the Style panel reads it as a new selection');
  assert.ok(events.indexOf('scan:with-component') > events.indexOf('create'), 'the project is scanned again once the component exists');
  await undo(app);
  assert.equal(fs.readFileSync(file, 'utf8'), PAGE, '⌘Z puts the page back byte for byte');
  assert.equal(fs.existsSync(created), false, '⌘Z takes the new component file back');
});
