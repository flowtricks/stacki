// Goal: page navigation, watcher reloads and saves never let an older read or
// an outside edit replace the user's current edit, and a refused save keeps the
// edit, stops autosave and asks the user (plan §7). Since step 9 every edit of
// an .astro page reaches disk as edit requests stated against the bytes the
// app last read or wrote, a burst of watcher events shares one scan and one
// read (src/lib/coalescedRun.ts), and node handles are carried from one read to
// the next by the byte diff (src/editor/nodeHandles.ts).
// Method: render the real App in jsdom with stub panels that capture their
// props, drive it through those callbacks, and hold every disk read on a
// deferred so each interleaving is chosen by the test. Each page is a real
// source text parsed by the real parser; `page:edit` applies requests with
// main's own translation and planner against the text the fake disk holds.
// Which read a page shows is told by its tag's `data-label`.
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
const { applyCodePatch } = require('#dist/shared/engine/codePatch.js');
const { repoPath, stubPanels } = require('../../helpers/sources.js');

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const textOf = (label) => `<div data-label="${label}"></div>\n`;
// A page read of `label`'s text, as main's page:read replies.
const pageState = (label) => {
  const source = textOf(label);
  return { ...parsePage(source, { locs: true }), source, checksum: sha256(source) };
};

// Main's page:edit on the text the fake disk holds for `file`.
function applyEdit(file, text, edit) {
  if (edit.tag === 'code-patch') {
    return { text: applyCodePatch(text, edit.hunks), inverse: [] };
  }
  const snapshot = NODE_PROJECTOR.snapshot(file, Buffer.from(text));
  const draft = buildEditIntent(edit, snapshot);
  assert.ok(draft.ok, `the edit is built (${draft.ok ? '' : draft.error})`);
  const intent = toIntent({ id: 't', file, authoredChecksum: snapshot.checksum, ...draft.value });
  const planned = planIntent({ authored: snapshot, current: snapshot }, intent);
  assert.ok(planned.ok, `the edit plans (${planned.ok ? '' : planned.error})`);
  const written = Buffer.from(applySplices(snapshot.bytes, planned.value.splices)).toString('utf8');
  return { text: written, inverse: inverseEdits(planned.value.splices) };
}

test('out-of-order page reads and external reads cannot replace the current edit', async () => {
  const directory = repoPath('node_modules/.stacki-test/page-navigation');
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
  const url = 'http://localhost/';
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url, pretendToBeVisual: true });
  const { window } = dom;
  const shared = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Element',
    'Node',
    'MutationObserver',
  ];
  for (const key of shared) {
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
  const pages = ['index', 'second', 'third'].map((name) => ({
    name: `${name}.astro`,
    path: `/project/src/pages/${name}.astro`,
    route: name === 'index' ? '/' : `/${name}`,
  }));
  const card = { name: 'Card', path: '/project/src/components/Card.astro', folder: '' };
  const scan = { pages, components: [card], layouts: [], pageFolders: [] };
  const reads = [];
  const scans = [];
  let deferScans = false;
  // The fake disk: what page:edit applies requests to. Reads are held and
  // answered by the test; answering one with a label puts that text on disk.
  const disk = new Map();
  const edits = [];
  const previews = [];
  let editError;
  // The real preload supports independent subscribers for navigation and publishing status.
  const fileListeners = new Set();
  const onFsChanged = (event) => Promise.all([...fileListeners].map((listener) => listener(event)));
  const refused = (reason, diskChecksum) => ({
    ok: false,
    error: { code: 'rejected', reason, message: reason, diskChecksum },
  });
  const bridge = new Proxy(
    {
      pendingProject: async () => undefined,
      scanProject: async () => {
        if (!deferScans) {
          return scan;
        }
        const request = deferred();
        scans.push(request);
        return request.promise;
      },
      startDevServer: async () => ({ url: 'http://localhost:4321' }),
      listProjectClasses: async () => [],
      readPage: (file) => {
        const request = deferred();
        reads.push({ path: file, ...request });
        return request.promise;
      },
      editPage: async ({ pagePath, authoredChecksum, edit }) => {
        if (editError) {
          throw editError;
        }
        edits.push({ pagePath, authoredChecksum, edit });
        const held = disk.get(pagePath);
        if (sha256(held) !== authoredChecksum) {
          return refused('anchor-moved', sha256(held));
        }
        const applied = applyEdit(pagePath, held, edit);
        disk.set(pagePath, applied.text);
        const page = {
          ...parsePage(applied.text, { locs: true }),
          source: applied.text,
          checksum: sha256(applied.text),
        };
        return { ok: true, ...page, inverse: applied.inverse };
      },
      // Review plans the queued gestures against the bytes they were stated
      // on, and writes nothing (page:previewEdit).
      previewPageEdit: async ({ pagePath, authoredChecksum, edit, source }) => {
        assert.equal(sha256(source), authoredChecksum, 'a preview sends the bytes it names');
        previews.push({ pagePath, edit });
        const applied = applyEdit(pagePath, source, edit);
        const page = {
          ...parsePage(applied.text, { locs: true }),
          source: applied.text,
          checksum: sha256(applied.text),
        };
        return { ok: true, ...page, inverse: applied.inverse };
      },
      onFsChanged: (callback) => {
        assert.ok(fileListeners.size < 8, 'The fixture has at most eight file subscribers');
        fileListeners.add(callback);
        return () => fileListeners.delete(callback);
      },
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
  // Answer read `index` with `label`'s text, which is then what disk holds.
  const answer = (index, label) => {
    disk.set(reads[index].path, textOf(label));
    reads[index].resolve(pageState(label));
  };
  const shown = () => __panels.PropsPanel.node?.props?.['data-label']?.value;
  const wait = (ms) =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  await act(async () => {
    root.render(React.createElement(App));
    await tick();
  });
  await act(async () => {
    await __panels.WelcomeScreen.onOpen('/project');
    await tick();
  });
  assert.equal(reads[0].path, pages[0].path);
  await act(async () => {
    answer(0, 'first');
    await tick();
  });
  assert.equal(shown(), 'first');
  const firstId = __panels.PropsPanel.node.id;
  await act(async () => {
    __panels.StructurePanel.onHoverNode(firstId);
    await tick();
  });
  assert.equal(__panels.PreviewPane.navHoverPath, '0');
  // Use the actual page switcher callback through the editor's URL input.
  const navigate = async (route) => {
    const input = document.querySelector('.url-bar input, input[spellcheck="false"]');
    assert.ok(input, 'URL input is available');
    const prototype = window.HTMLInputElement.prototype;
    const setValue = Object.getOwnPropertyDescriptor(prototype, 'value').set;
    await act(async () => {
      setValue.call(input, route);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      input.dispatchEvent(new window.Event('change', { bubbles: true }));
      await tick();
    });
    await act(async () => {
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await tick();
    });
  };
  await navigate('/second');
  await navigate('/third');
  assert.equal(reads.length, 3);
  await act(async () => {
    answer(2, 'third');
    await tick();
  });
  assert.equal(shown(), 'third');
  assert.equal(
    __panels.PreviewPane.navHoverPath,
    undefined,
    'Installing a page clears navigator hover so canvas hover can take over',
  );
  await act(async () => {
    reads[1].resolve(pageState('stale-second'));
    await tick();
  });
  assert.equal(shown(), 'third', 'a read the navigation superseded installs nothing');
  assert.equal(__panels.PropsPanel.filePath, pages[2].path);
  // Two watcher events in a burst: one reconcile reads, and the one asked
  // after it reads again — the later disk text is the one shown.
  let olderReload, newerReload;
  await act(async () => {
    olderReload = onFsChanged({ files: [pages[2].path] });
    await tick();
  });
  await act(async () => {
    newerReload = onFsChanged({ files: [pages[2].path] });
    await tick();
  });
  assert.equal(reads.length, 4, 'the second event waits behind the reconcile in flight');
  await act(async () => {
    answer(3, 'older-disk');
    await olderReload;
    await tick();
  });
  assert.equal(reads.length, 5, 'the reconcile asked after it reads again');
  await act(async () => {
    answer(4, 'latest-disk');
    await newerReload;
    await tick();
  });
  assert.equal(shown(), 'latest-disk');
  // An event whose read finds the bytes already shown is the app's own write
  // heard late: nothing reloads, and an edit made meanwhile is kept.
  let external;
  await act(async () => {
    external = onFsChanged({ files: [pages[2].path] });
    await tick();
  });
  assert.equal(reads.length, 6);
  await act(async () => {
    __panels.PropsPanel.onSetProp('title', { type: 'string', value: 'keep this' });
    await tick();
  });
  await act(async () => {
    answer(5, 'latest-disk');
    await external;
    await tick();
  });
  assert.equal(shown(), 'latest-disk');
  assert.equal(__panels.PropsPanel.node.props.title.value, 'keep this');
  await act(async () => {
    window.dispatchEvent(new window.Event('focus'));
    await tick();
  });
  assert.equal(reads.length, 6, 'returning during a draft does not re-read over the edit');
  assert.equal(__panels.SaveConflictNotice, undefined, 'focus alone is not an outside conflict');
  await wait(350);
  assert.equal(edits.at(-1).pagePath, pages[2].path);
  assert.equal(edits.at(-1).edit.tag, 'set-attribute', 'saved as a request, never a whole model');
  assert.equal(
    edits.at(-1).authoredChecksum,
    sha256(textOf('latest-disk')),
    'the save names the bytes it edited',
  );
  assert.equal(disk.get(pages[2].path), '<div data-label="latest-disk" title="keep this"></div>\n');
  let openComponent;
  await act(async () => {
    openComponent = __panels.StructurePanel.onOpenComponent('Card');
    await tick();
  });
  assert.equal(reads[6].path, card.path);
  await act(async () => {
    answer(6, 'card');
    await openComponent;
    await tick();
  });
  let componentReload;
  await act(async () => {
    componentReload = onFsChanged({ files: [card.path] });
    await tick();
  });
  assert.equal(reads[7].path, card.path, 'an open component is reloaded, not treated as deleted');
  await act(async () => {
    answer(7, 'card-updated');
    await componentReload;
    await tick();
  });
  assert.equal(shown(), 'card-updated');
  assert.equal(__panels.PropsPanel.filePath, card.path);
  editError = new Error('disk full');
  await act(async () => {
    __panels.PropsPanel.onSetProp('title', { type: 'string', value: 'unsaved card' });
    await tick();
  });
  await navigate('/second');
  assert.equal(reads.length, 8, 'a failed save blocks navigation before reading the next page');
  assert.equal(__panels.PropsPanel.filePath, card.path);
  assert.equal(__panels.PreviewPane.route, '/third');
  assert.match(document.querySelector('.toast.error').textContent, /disk full/);
  editError = undefined;
  await navigate('/second');
  assert.equal(reads[8].path, pages[1].path);
  assert.equal(disk.get(card.path), '<div data-label="card-updated" title="unsaved card"></div>\n');
  await act(async () => {
    answer(8, 'second-retry');
    await tick();
  });
  assert.equal(shown(), 'second-retry');
  // A relevant page change is followed by an unrelated file change while the
  // first scan is pending. The superseded scan decides nothing — not even that
  // the page was deleted, as it says — and the newest reconcile, with every
  // file named so far, reads the page.
  deferScans = true;
  let earlierScanEvent, laterScanEvent;
  await act(async () => {
    earlierScanEvent = onFsChanged({ files: [pages[1].path] });
    await tick();
  });
  await act(async () => {
    laterScanEvent = onFsChanged({ files: ['/project/src/components/New.astro'] });
    await tick();
  });
  assert.equal(scans.length, 1, 'the later event waits behind the scan in flight');
  const deleted = { ...scan, pages: pages.filter((page) => page.path !== pages[1].path) };
  await act(async () => {
    scans[0].resolve(deleted);
    await earlierScanEvent;
    await tick();
  });
  // Its lists may show until the newer scan lands (the burst's first scan was
  // the latest asked for when it ended); its verdict on the page decides nothing.
  assert.equal(__panels.StructurePanel.currentPage.path, pages[1].path, 'the page stays open');
  assert.equal(scans.length, 2, 'the reconcile the later event asked for scans again');
  const newLayout = {
    name: 'NewLayout',
    path: '/project/src/layouts/NewLayout.astro',
    folder: 'layouts',
  };
  const latestScan = { ...scan, layouts: [newLayout] };
  await act(async () => {
    scans[1].resolve(latestScan);
    await tick();
  });
  assert.equal(reads[9].path, pages[1].path, 'a later unrelated event keeps the page change');
  await act(async () => {
    answer(9, 'after-newest-scan');
    await laterScanEvent;
    await tick();
  });
  assert.equal(__panels.StructurePanel.currentPage.path, pages[1].path);
  assert.equal(shown(), 'after-newest-scan');
  assert.deepEqual(__panels.StructurePanel.layouts, latestScan.layouts);
  deferScans = false;
  // The same holds across a pending read: the page read lands whatever event
  // came after it, and an unrelated event reads nothing of its own.
  let pendingReadEvent, unrelatedEvent;
  await act(async () => {
    pendingReadEvent = onFsChanged({ files: [pages[1].path] });
    await tick();
  });
  assert.equal(reads[10].path, pages[1].path);
  await act(async () => {
    unrelatedEvent = onFsChanged({ files: ['/project/src/components/New.astro'] });
    await tick();
  });
  await act(async () => {
    answer(10, 'page-change');
    await pendingReadEvent;
    await unrelatedEvent;
    await tick();
  });
  assert.equal(shown(), 'page-change');
  assert.equal(reads.length, 11, 'the unrelated event reads no page');

  // --- A refused save (plan §7) ---------------------------------------------
  // Main refuses the edit: the page turns conflicted, the notice appears, and
  // the edit stays on screen. Later edits apply locally but never autosave.
  // Separate acts: the save timer relies on React committing the edit first.
  const typeTitle = async (value) => {
    await act(async () => {
      __panels.PropsPanel.onSetProp('title', { type: 'string', value });
      await tick();
    });
    await wait(350);
  };
  // Another writer changes the page: the next edit, stated against the bytes
  // the app read, is refused over the bytes that changed.
  const theirs = '<div data-label="outside"></div>\n';
  disk.set(pages[1].path, theirs);
  const attempted = edits.length;
  delete __panels.SaveConflictNotice;
  await typeTitle('mine');
  assert.equal(edits.length, attempted + 1);
  assert.equal(__panels.SaveConflictNotice.fileName, pages[1].name);
  assert.equal(__panels.SaveConflictNotice.reviewing, false);
  await typeTitle('mine, again');
  assert.equal(edits.length, attempted + 1, 'autosave stays off while conflicted');
  assert.equal(__panels.PropsPanel.node.props.title.value, 'mine, again');
  // Leaving would drop the edits, so navigation stops and says why.
  const readsBefore = reads.length;
  await navigate('/third');
  assert.equal(reads.length, readsBefore, 'a conflicted page blocks navigation before any read');
  assert.match(
    document.querySelector('.toast.error').textContent,
    /conflict with a change on disk/,
  );
  // Review shows the local version as text; keeping it saves that text as a
  // patch of the bytes on disk — read when the save is sent — deliberately,
  // never as a whole model.
  await act(async () => {
    await __panels.SaveConflictNotice.onReview();
    await tick();
  });
  assert.equal(__panels.SaveConflictNotice.reviewing, true);
  assert.ok(previews.length > 0, 'the queued gestures were planned as splices');
  assert.equal(disk.get(pages[1].path), theirs, 'a review writes nothing');
  // The page the gestures were stated on, with them spliced in.
  const reviewed = '<div data-label="page-change" title="mine, again"></div>\n';
  // A synchronous act commits the click's state before the zero-delay save
  // timer runs, as a real discrete event does.
  act(() => {
    __panels.SaveConflictNotice.onKeep();
  });
  await act(async () => {
    await tick();
  });
  const keepRead = reads.length - 1;
  assert.equal(reads[keepRead].path, pages[1].path, 'the save reads the disk it patches');
  await act(async () => {
    answer(keepRead, 'outside');
    await tick();
  });
  await wait(50);
  assert.equal(edits.length, attempted + 2);
  assert.equal(edits.at(-1).edit.tag, 'code-patch');
  assert.equal(edits.at(-1).authoredChecksum, sha256(theirs), 'against the bytes on disk');
  assert.equal(disk.get(pages[1].path), reviewed, 'the reviewed text is on disk');
  delete __panels.SaveConflictNotice;
  await typeTitle('clean again');
  assert.equal(__panels.SaveConflictNotice, undefined, 'the notice leaves with the conflict');
  assert.equal(edits.length, attempted + 3);
  const cleanAgain = '<div data-label="page-change" title="clean again"></div>\n';
  assert.equal(disk.get(pages[1].path), cleanAgain);

  // An outside edit while the page has unsaved edits: the pending edit names
  // the bytes the app read, and main refuses it over bytes that changed — the
  // outside edit is never overwritten, and the user's input stays.
  await act(async () => {
    __panels.PropsPanel.onSetProp('title', { type: 'string', value: 'typing' });
    await tick();
  });
  disk.set(pages[1].path, '<div data-label="outside-again"></div>\n');
  await wait(350);
  assert.equal(disk.get(pages[1].path), '<div data-label="outside-again"></div>\n', 'kept');
  assert.equal(__panels.SaveConflictNotice.fileName, pages[1].name);
  assert.equal(__panels.PropsPanel.node.props.title.value, 'typing');
  // Reload from disk is the deliberate way out; it discards the local edit.
  const saved = edits.length;
  await act(async () => {
    __panels.SaveConflictNotice.onReload();
    await tick();
  });
  const reload = reads.length - 1;
  assert.equal(reads[reload].path, pages[1].path);
  delete __panels.SaveConflictNotice;
  await act(async () => {
    answer(reload, 'outside-again');
    await tick();
  });
  assert.equal(__panels.SaveConflictNotice, undefined);
  assert.equal(shown(), 'outside-again');
  await wait(350);
  assert.equal(edits.length, saved, 'reloading writes nothing');
  const beforeReturn = reads.length;
  await act(async () => {
    window.dispatchEvent(new window.Event('focus'));
    await tick();
  });
  assert.equal(reads.length, beforeReturn + 1, 'returning to Stacki rechecks the open file');
  await act(async () => {
    answer(beforeReturn, 'changed-while-away');
    await tick();
  });
  assert.equal(shown(), 'changed-while-away');
  const beforeUnnamed = reads.length;
  await act(async () => {
    onFsChanged({ files: [] });
    await tick();
  });
  assert.equal(reads.length, beforeUnnamed + 1, 'an unnamed edit still rechecks the open file');
  await act(async () => {
    answer(beforeUnnamed, 'unnamed-change');
    await tick();
  });
  assert.equal(shown(), 'unnamed-change');
  await act(async () => root.unmount());
  dom.window.close();
});
