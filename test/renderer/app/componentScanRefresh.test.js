// Goal: backing out of a component whose file was edited while it was open
// shows that component's instances with its current slots and props at once.
// The app's own saves never reach the project scan through the watcher — main
// drops a write it hears coming back (electron/project/projectWatcher.ts) — so
// before the fix an instance's Settings kept the scan from before the edit, and
// a `<slot>` typed into Button.astro left the page's <Button /> without a
// Content field until some unrelated event happened to rescan.
// Method: render the real App in jsdom with stub panels that capture their
// props, open a page holding <Button />, drill into Button, save an edit to it,
// let the fake main answer later scans with the slot the edit added (the
// watcher stays silent, as it does for the app's own write), and press Back.
// The Settings panel must then report that the instance takes slot content,
// with no further event, and the scan that says so must have begun after the
// save landed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { createHash } = require('node:crypto');
const { JSDOM } = require('jsdom');
const { parsePage } = require('#dist/electron/parse/astroParser.js');
const { NODE_PROJECTOR } = require('#dist/electron/documents/documentDisk.js');
const { buildEditIntent } = require('#dist/electron/documents/editRequests.js');
const { toIntent } = require('#dist/shared/engine/intent.js');
const { planIntent } = require('#dist/shared/engine/planner.js');
const { applySplices, inverseEdits } = require('#dist/shared/engine/splice.js');
const { repoPath, stubPanels } = require('../../helpers/sources.js');

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const pageRead = (source) => ({ ...parsePage(source, { locs: true }), source, checksum: sha256(source) });

// Main's page:edit on the text the fake disk holds for `file`.
function applyEdit(file, text, edit) {
  const snapshot = NODE_PROJECTOR.snapshot(file, Buffer.from(text));
  const draft = buildEditIntent(edit, snapshot);
  assert.ok(draft.ok, `the edit is built (${draft.ok ? '' : draft.error})`);
  const intent = toIntent({ id: 't', file, authoredChecksum: snapshot.checksum, ...draft.value });
  const planned = planIntent({ authored: snapshot, current: snapshot }, intent);
  assert.ok(planned.ok, `the edit plans (${planned.ok ? '' : planned.error})`);
  const written = Buffer.from(applySplices(snapshot.bytes, planned.value.splices)).toString('utf8');
  return { text: written, inverse: inverseEdits(planned.value.splices) };
}

test('backing out of an edited component rescans before its instance is shown', async () => {
  const directory = repoPath('node_modules/.stacki-test/component-scan-refresh');
  fs.mkdirSync(directory, { recursive: true });
  await esbuild.build({
    entryPoints: [repoPath('src/app/App.tsx')],
    outfile: path.join(directory, 'app.js'),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty' },
    logLevel: 'silent',
    plugins: [
      stubPanels('capture-panels', (name) => {
        const contents =
          "export const relativeTime = () => ''; " +
          'export default function Panel(props) { ' +
          `globalThis.__panels[${JSON.stringify(name)}] = props; return null; }`;
        return { contents, loader: 'jsx' };
      }),
    ],
  });
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const { window } = dom;
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver']) {
    global[key] = key === 'window' ? window : window[key];
  }
  global.getComputedStyle = window.getComputedStyle;
  global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  global.cancelAnimationFrame = clearTimeout;
  global.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  window.ResizeObserver = global.ResizeObserver;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  global.__panels = {};
  global.IS_REACT_ACT_ENVIRONMENT = true;

  const page = { name: 'index.astro', path: '/project/src/pages/index.astro', route: '/' };
  const buttonPath = '/project/src/components/Button.astro';
  const button = { name: 'Button', path: buttonPath, folder: '', instances: 1, schema: [], slots: [], slotText: false };
  const disk = new Map([
    [page.path, '<Button />\n'],
    [buttonPath, '<a href="#" class="button"><span>→</span></a>\n'],
  ]);
  // What main's scan reads from disk: the slots the component's file declares.
  // A scan that begins after the save sees the slot; none is pushed to the app.
  const scanCalls = [];
  const scanProject = async () => {
    const slots = disk.get(buttonPath).includes('<slot') ? ['default'] : [];
    scanCalls.push({ slots });
    return { pages: [page], components: [{ ...button, slots, slotText: slots.length > 0 }], layouts: [], pageFolders: [] };
  };
  const edits = [];
  const bridge = new Proxy(
    {
      pendingProject: async () => undefined,
      scanProject,
      startDevServer: async () => ({ url: 'http://localhost:4321' }),
      listProjectClasses: async () => [],
      readPage: async (file) => pageRead(disk.get(file)),
      editPage: async ({ pagePath, authoredChecksum, edit }) => {
        const held = disk.get(pagePath);
        assert.equal(sha256(held), authoredChecksum, 'the save names the bytes it edits');
        const applied = applyEdit(pagePath, held, edit);
        edits.push({ pagePath, scansBefore: scanCalls.length });
        // The edit that matters to the scan: the slot typed into the code
        // pane lands with this save. The watcher never reports it.
        const written = pagePath === buttonPath ? applied.text.replace('<span>', '<slot></slot><span>') : applied.text;
        disk.set(pagePath, written);
        return { ok: true, ...pageRead(written), inverse: applied.inverse };
      },
      onFsChanged: () => () => {},
      gitInfo: async () => ({ isRepo: false }),
      publishAvailability: async () => ({ github: 'unknown', hosting: 'unconfigured' }),
      onCssChanged: () => () => {},
    },
    {
      get: (target, key) => {
        if (key in target) {
          return target[key];
        }
        return String(key).startsWith('on') ? () => () => {} : async () => undefined;
      },
    },
  );
  window.avb = bridge;
  global.avb = bridge;
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const root = createRoot(document.getElementById('root'));
  const App = require(path.join(directory, 'app.js')).default;
  const wait = (ms) =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });

  // A failed assertion must still unmount, or the open handles keep the
  // runner waiting for the process to end.
  try {
    await act(async () => {
      root.render(React.createElement(App));
      await tick();
    });
    await act(async () => {
      await __panels.WelcomeScreen.onOpen('/project');
      await tick();
    });
    assert.equal(__panels.PropsPanel.filePath, page.path);
    assert.equal(__panels.PropsPanel.node?.name, 'Button', 'the page opens with its instance selected');
    assert.equal(__panels.PropsPanel.takesSlotText, false, 'the component has no slot yet');

    await act(async () => {
      await __panels.StructurePanel.onOpenComponent('Button', '0', 0);
      await tick();
    });
    assert.equal(__panels.PropsPanel.filePath, buttonPath, 'the component is open');
    await act(async () => {
      __panels.PropsPanel.onSetProp('title', { type: 'string', value: 'Go' });
      await tick();
    });
    await wait(350);
    const save = edits.find((entry) => entry.pagePath === buttonPath);
    assert.ok(save, 'the component edit is saved');
    assert.ok(disk.get(buttonPath).includes('<slot></slot>'), 'the slot is on disk');
    const scansAfterSave = scanCalls.length;

    const back = document.querySelector('.comp-back');
    assert.ok(back, 'the Back button shows inside a component');
    await act(async () => {
      back.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await tick();
    });
    await wait(50);
    assert.equal(__panels.PropsPanel.filePath, page.path, 'Back returns to the page');
    assert.equal(__panels.PropsPanel.node?.name, 'Button', 'the instance is selected again');
    assert.ok(scanCalls.length > scansAfterSave, 'leaving the component rescans the project');
    assert.deepEqual(scanCalls.at(-1).slots, ['default'], 'the scan began after the save landed');
    assert.equal(__panels.PropsPanel.takesSlotText, true, 'the instance offers the slot it gained, with no further event');

    // Drilling in leaves a page, whose saves change no scan: nothing rescans.
    const scansOnPage = scanCalls.length;
    await act(async () => {
      await __panels.StructurePanel.onOpenComponent('Button', '0', 0);
      await tick();
    });
    assert.equal(scanCalls.length, scansOnPage, 'drilling into a component from a page does not rescan');
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
