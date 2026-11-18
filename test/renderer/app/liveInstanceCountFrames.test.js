// Goal: removing a component instance from the open page changes the Components panel's count in
// the same render as the tree — "Div 1 instance" becomes "0 instances" with no frame between —
// through delete, undo, redo, cut and paste, and no scan, stale or fresh, ever puts the old number
// back, on the page or after leaving it.
//
// Methodology: the real App in jsdom over a real document host (test/helpers/appGestures.js) on a
// temporary project. The scan is computed from the files on disk by main's own counter
// (electron/properties/componentUsage.ts), as project:scan does, and only when asked: the app's
// own saves never cause one, as in the app. Every render of the Components panel is recorded
// through a setter on the stub's props, with the panel's count beside the number of instances its
// own `pageInstances` reads from the editor's live tree in that same render; the invariant is that
// in every render the count is the other page's share plus the live tree's, so the count can never
// trail the tree by a render. A stale scan is one held in flight across the edit and released
// after it; a fresh scan is asked through the file watcher's event.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gesture, mountApp, tick, undo } = require('../../helpers/appGestures.js');
const { instanceCounts } = require('#dist/electron/properties/componentUsage.js');

const IMPORT = "---\nimport Div from '../components/Div.astro';\n---\n";

function fixture(context) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-live-counts-')));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, text) => {
    const file = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  const index = write('src/pages/index.astro', `${IMPORT}<main><Div /><p>Text</p></main>\n`);
  const about = write('src/pages/about.astro', `${IMPORT}<main><Div /></main>\n`);
  const div = write('src/components/Div.astro', '<div><slot /></div>\n');
  return { root, index, about, div };
}

// project:scan's count, per file, from the bytes on disk now.
function scanFromDisk(setup) {
  const sources = [setup.index, setup.about];
  const uses = [];
  for (const file of sources) {
    const count = instanceCounts(fs.readFileSync(file, 'utf8'), file, [])({ targetPath: setup.div, name: 'Div' });
    if (count > 0) {
      uses.push({ file: path.relative(setup.root, file).split(path.sep).join('/'), count });
    }
  }
  const instances = uses.reduce((total, use) => total + use.count, 0);
  return {
    pages: [
      { name: 'index.astro', path: setup.index, route: '/' },
      { name: 'about.astro', path: setup.about, route: '/about' },
    ],
    pageFolders: [],
    layouts: [],
    components: [{ name: 'Div', path: setup.div, file: 'src/components/Div.astro', folder: '', instances, uses, schema: [], slots: ['default'] }],
  };
}

// Records every render of the Components panel: its count and the live tree's, side by side.
function recordPanel() {
  const renders = [];
  let props;
  Object.defineProperty(globalThis.__panels, 'PalettePanel', {
    configurable: true,
    get: () => props,
    set: (value) => {
      props = value;
      const div = value.components.find((component) => component.name === 'Div');
      renders.push({ count: div?.instances, live: value.pageInstances('Div').length });
    },
  });
  return renders;
}

async function openComponentsTab(app) {
  const palette = [...document.querySelectorAll('.rail-btn')].find((button) => String(button.getAttribute('aria-label')).startsWith('Components'));
  assert.ok(palette, 'the Components rail button shows');
  await app.act(async () => {
    palette.click();
    await tick();
  });
}

async function redo(app) {
  await gesture(app, async () => {
    document.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: true, bubbles: true }));
  });
}

function lastCount(renders) {
  const last = renders.at(-1);
  assert.ok(last, 'the panel rendered');
  return last.count;
}

// Every render since `from` shows the other page's share plus the live tree's: never a frame behind.
function assertSameFrame(renders, from, otherShare, step) {
  const since = renders.slice(from);
  assert.ok(since.length > 0, `${step}: the panel rendered`);
  for (const [offset, render] of since.entries()) {
    assert.equal(render.count, otherShare + render.live, `${step}: render ${offset} shows the live tree's count`);
  }
}

test('the count follows delete, undo, redo, cut and paste in the same render as the tree', async (context) => {
  const setup = fixture(context);
  let scans = 0;
  const app = await mountApp(setup.root, {}, 'live-instance-count-frames', {
    bridge: {
      scanProject: async () => {
        scans += 1;
        return scanFromDisk(setup);
      },
    },
  });
  context.after(app.unmount);
  const renders = recordPanel();
  await openComponentsTab(app);
  assert.equal(lastCount(renders), 2, 'one Div on this page, one on about');
  const scansAtStart = scans;
  const panel = () => globalThis.__panels.PalettePanel;
  const structure = () => globalThis.__panels.StructurePanel;
  const firstDiv = () => {
    const [instance] = panel().pageInstances('Div');
    assert.ok(instance, 'a Div is on the page');
    return instance.id;
  };

  // Each row: the gesture and the count the panel shows once it is made.
  const steps = [
    { name: 'delete', run: () => gesture(app, async () => structure().onRemoveNode(firstDiv())), count: 1 },
    { name: 'undo', run: () => undo(app), count: 2 },
    { name: 'redo', run: () => redo(app), count: 1 },
    { name: 'undo again', run: () => undo(app), count: 2 },
    {
      name: 'cut',
      run: () =>
        gesture(app, async () => {
          structure().onCutNode(firstDiv());
        }),
      count: 1,
    },
    {
      name: 'paste',
      run: async () => {
        const main = structure().pageState.model.nodes.find((node) => node.name === 'main');
        assert.ok(main, 'the page holds its main');
        await app.act(async () => {
          structure().onSelect(main.id);
          await tick();
        });
        await gesture(app, async () => {
          await structure().onPasteNode();
        });
      },
      count: 2,
    },
  ];
  for (const step of steps) {
    const from = renders.length;
    await step.run();
    assertSameFrame(renders, from, 1, step.name);
    assert.equal(lastCount(renders), step.count, `${step.name}: the panel shows ${step.count}`);
  }
  assert.equal(scans, scansAtStart, 'no count waited for a scan: the app’s own saves cause none');
});

test('a scan that read the page before the delete never brings the old count back', async (context) => {
  const setup = fixture(context);
  let release;
  let held = false;
  const fsListeners = [];
  const app = await mountApp(setup.root, {}, 'live-instance-count-frames', {
    bridge: {
      scanProject: async () => {
        // Read now, as main reads the files when the scan begins.
        const read = scanFromDisk(setup);
        if (held) {
          await new Promise((resolve) => {
            release = resolve;
          });
        }
        return read;
      },
      onFsChanged: (listener) => {
        fsListeners.push(listener);
        return () => {};
      },
    },
  });
  context.after(app.unmount);
  const renders = recordPanel();
  await openComponentsTab(app);
  assert.equal(lastCount(renders), 2);
  const changed = (files) =>
    app.act(async () => {
      for (const listener of fsListeners) {
        listener({ files });
      }
      await tick();
    });

  // A scan begins (an outside change to another file) and reads index.astro with its Div.
  held = true;
  await changed([setup.about]);
  assert.ok(release, 'the scan is in flight');
  held = false;
  const [instance] = globalThis.__panels.PalettePanel.pageInstances('Div');
  const from = renders.length;
  await gesture(app, async () => globalThis.__panels.StructurePanel.onRemoveNode(instance.id));
  assert.equal(lastCount(renders), 1, 'the delete shows at once');
  assert.match(fs.readFileSync(setup.index, 'utf8'), /<main><p>Text<\/p><\/main>/, 'the delete is saved');

  // The stale scan lands after the save: its index.astro share is swapped for the live tree's.
  await app.act(async () => {
    release();
    await tick();
    await tick();
  });
  assertSameFrame(renders, from, 1, 'stale scan');
  assert.equal(
    renders.slice(from).findIndex((render) => render.count === 2),
    -1,
    'not one render shows the old count',
  );

  // A fresh scan agrees.
  await changed([setup.about]);
  await app.act(() => tick());
  assert.equal(lastCount(renders), 1, 'a fresh scan shows the same count');

  // Leaving the page keeps its live share until a scan that began after leaving: about.astro
  // opens, and the panel still counts index.astro as it was left.
  const leave = renders.length;
  await app.act(async () => {
    // The panel's own way to a page: a row of the instances popup.
    globalThis.__panels.PalettePanel.onOpenUsage({ path: setup.about, rel: 'src/pages/about.astro', kind: 'page', count: 1 });
    await tick();
  });
  await app.act(() => tick());
  assert.equal(globalThis.__panels.PalettePanel.pageInstances('Div').length, 1, 'about.astro is open');
  assert.equal(
    renders.slice(leave).findIndex((render) => render.count !== 1),
    -1,
    'leaving the page never shows the old count',
  );
});
