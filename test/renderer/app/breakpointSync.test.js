// Goal: changing a breakpoint in Settings offers to update the matching media queries elsewhere in the project, through a custom
// dialog that lists the places by file, starts the right ones checked, writes nothing until "Update N places" is pressed, and
// remembers nothing when "Just save the number" is chosen.
//
//   node test/renderer/app/breakpointSync.test.js
//
// Method: bundle the real BreakpointsSettings, the dialog and the selection rules with esbuild and mount them in jsdom over an
// in-memory breakpoints file and a fake `window.avb` whose scan, apply and restore calls are recorded (no real project and no
// files). Steps: the selection rules by table (default checks, file box states, toggles, the request and the unchecked list,
// path shortening, labels); committing a changed number scans and opens the dialog titled with the count; exact places start
// checked and inclusive 1px and "Not synced" places start unchecked and say so; the file box half-checks; All and None; places
// open with their line and before and after; skip sends nothing; update sends exactly the checked places and the unchecked ones;
// the undo step restores the files and the number; no dialog when nothing matches; a slow scan shows skeleton rows; an
// unavailable bridge (Studio) opens nothing. What a sync or a scan reports (done, failed, cut short) is a toast through the app's
// toast handoff (the bundle is injected with the toast capture), never a paragraph in the panel or the dialog.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { toastMessages } = require('../../helpers/toastCapture');

const directory = repoPath('node_modules/.stacki-test/breakpoint-sync');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'bundle.cjs');
buildSync({
  stdin: {
    contents: `
export { BreakpointsSettings } from './src/app/settings/BreakpointsSettings';
export { breakpointsStore, forgetBreakpointStores } from './src/ipc/projectBreakpoints';
export * from './shared/properties/breakpointSyncSelection';`,
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: output,
  inject: [repoPath('test/helpers/toastCaptureEntry.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  logLevel: 'silent',
  loader: { '.css': 'empty', '.svg': 'dataurl' },
  external: ['react', 'react-dom', 'react/jsx-runtime'],
});

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
const { window } = dom;
Object.assign(global, {
  window,
  document: window.document,
  HTMLElement: window.HTMLElement,
  HTMLDialogElement: window.HTMLDialogElement,
  Element: window.Element,
  Node: window.Node,
  // The Style tags section below the breakpoints holds a CodeMirror editor, which watches its DOM.
  MutationObserver: window.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  getComputedStyle: window.getComputedStyle.bind(window),
  matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
});
window.matchMedia = global.matchMedia;
window.Range.prototype.getClientRects = () => [];
window.Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
window.HTMLDialogElement.prototype.showModal = function showModal() {
  this.setAttribute('open', '');
};
window.HTMLDialogElement.prototype.close = function close() {
  this.removeAttribute('open');
};
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const api = require(output);

const settle = (ms = 30) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
const CARD_PATH = 'src/components/deeply/nested/folder/structure/with/a/very/long/path/Card.astro';

function occurrence(locator, line, overrides = {}) {
  return {
    locator,
    start: line * 10,
    end: line * 10 + 5,
    line,
    before: '64rem',
    after: '70rem',
    beforeText: '@media (min-width: 64rem)',
    afterText: '@media (min-width: 70rem)',
    reason: 'exact',
    excluded: false,
    checked: true,
    ...overrides,
  };
}

function scanFixture() {
  return {
    key: 'laptop',
    lumos: false,
    truncated: false,
    skipped: 0,
    recordProblem: undefined,
    files: [
      {
        rel: 'src/styles/site.css',
        kind: 'css',
        digest: 'a',
        occurrences: [occurrence('00000001:0', 2), occurrence('00000001:1', 5, { before: '1023px', reason: 'inclusive', checked: false })],
      },
      { rel: 'src/pages/index.astro', kind: 'page', digest: 'b', occurrences: [occurrence('00000002:0', 9)] },
      { rel: CARD_PATH, kind: 'component', digest: 'c', occurrences: [occurrence('00000003:0', 3, { excluded: true, checked: false })] },
    ],
  };
}

function memoryStorage(initial) {
  const state = { source: initial, writes: [] };
  return {
    state,
    read: async () => (state.source === undefined ? {} : { source: state.source }),
    write: async ({ source }) => {
      state.writes.push(source);
      state.source = source;
      return { source };
    },
  };
}

function fakeBridge(scan, options = {}) {
  const calls = { scan: [], apply: [], restore: [], usage: [], record: { source: undefined, writes: [] } };
  window.avb = {
    scanBreakpointSync: async (request) => {
      calls.scan.push(request);
      if (options.scanDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.scanDelayMs));
      }
      return { ok: true, scan };
    },
    applyBreakpointSync: async (request) => {
      calls.apply.push(request);
      return {
        ok: true,
        places: request.files.reduce((sum, file) => sum + file.edits.length, 0),
        files: request.files.length,
        skipped: [],
        journalId: 'journal-1',
      };
    },
    scanBreakpointUsage: async (request) => {
      calls.usage.push(request);
      return { ok: true, usage: options.usage ?? usageFixture() };
    },
    projectMetadata: async ({ kind }) => ({
      ok: true,
      value: kind === 'breakpointSync' && calls.record.source !== undefined ? { source: calls.record.source } : {},
    }),
    writeProjectMetadata: async ({ write }) => {
      calls.record.writes.push(write.source);
      calls.record.source = write.source;
      return { ok: true, value: { source: write.source } };
    },
    restoreBreakpointSync: async (request) => {
      calls.restore.push(request);
      return { ok: true, restored: 1, skipped: 0 };
    },
  };
  return calls;
}

async function mount(name, onRecordUndo) {
  document.body.innerHTML = '<div id="root"></div>';
  const root = createRoot(document.getElementById('root'));
  api.forgetBreakpointStores();
  const storage = memoryStorage(undefined);
  api.breakpointsStore(name, storage);
  await act(() => root.render(React.createElement(api.BreakpointsSettings, { projectPath: name, onRecordUndo })));
  await settle();
  return { root, storage };
}

const field = (label) => document.querySelector(`input[aria-label="${label} width in pixels"]`);
async function commit(label, text) {
  const input = field(label);
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, text);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await act(async () => input.blur());
  await settle(60);
}
const dialog = () => document.querySelector('.breakpoint-sync');
const rows = () => [...document.querySelectorAll('.breakpoint-sync-file')];
const click = (element) => act(async () => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
const button = (text) => [...document.querySelectorAll('.breakpoint-sync button')].find((candidate) => candidate.textContent.trim().startsWith(text));
const title = () => document.querySelector('.breakpoint-sync .modal-header').textContent;

test('the selection rules: defaults, file boxes, toggles, the request and the unchecked list', () => {
  const scan = scanFixture();
  const checked = api.initialChecked(scan);
  assert.deepEqual([...checked].sort(), [api.placeKey('src/pages/index.astro', '00000002:0'), api.placeKey('src/styles/site.css', '00000001:0')].sort());
  assert.equal(api.placeCount(scan), 4);
  assert.equal(api.checkedCount(scan, checked), 2);
  const [css, page, card] = scan.files;
  assert.equal(api.fileCheck(css, checked), 'some');
  assert.equal(api.fileCheck(page, checked), 'all');
  assert.equal(api.fileCheck(card, checked), 'none');
  assert.equal(api.fileCheck(css, api.toggledFile(css, checked)), 'all', 'a half-checked file box checks everything');
  assert.equal(api.fileCheck(page, api.toggledFile(page, checked)), 'none', 'a fully checked one unchecks everything');
  assert.equal(api.checkedCount(scan, api.toggledPlace(css, css.occurrences[1], checked)), 3);
  assert.equal(api.checkedCount(scan, api.allPlaces(scan)), 4);
  assert.deepEqual(
    [api.placeLabel(css.occurrences[0]), api.placeLabel(css.occurrences[1]), api.placeLabel(card.occurrences[0])],
    [undefined, 'inclusive', 'notSynced'],
  );
  const request = api.applyRequest('/project', 'laptop', scan, checked);
  assert.deepEqual(
    request.files.map((file) => [file.rel, file.digest, file.edits.map((edit) => edit.locator)]),
    [
      ['src/styles/site.css', 'a', ['00000001:0']],
      ['src/pages/index.astro', 'b', ['00000002:0']],
    ],
  );
  assert.deepEqual(
    request.unchecked.map((ref) => `${ref.file}:${ref.locator}`),
    ['src/styles/site.css:00000001:1', `${CARD_PATH}:00000003:0`],
  );
  assert.equal(api.middleEllipsis('src/a.css', 44), 'src/a.css');
  const shortened = api.middleEllipsis(card.rel, 44);
  assert.equal(shortened.length, 44);
  assert.ok(shortened.includes('…') && shortened.endsWith('Card.astro') && shortened.startsWith('src/'));
});

test('a changed number scans, opens the dialog with the count, and writes nothing until confirmed', async () => {
  const calls = fakeBridge(scanFixture());
  const { root } = await mount('sync-open');
  await commit('Laptop', '70rem');
  assert.equal(calls.scan.length, 1);
  assert.equal(calls.scan[0].id, 'laptop');
  assert.deepEqual(calls.scan[0].old, { direction: 'down', value: 64, unit: 'rem' });
  assert.deepEqual(calls.scan[0].next, { direction: 'down', value: 70, unit: 'rem' });
  assert.ok(dialog(), 'the dialog is up');
  assert.equal(title(), 'Update 4 media queries?');
  assert.equal(calls.apply.length, 0, 'nothing is written before the primary button');
  assert.deepEqual(
    rows().map((row) => row.querySelector('.breakpoint-sync-kind').getAttribute('aria-label')),
    ['CSS file', 'Page', 'Component'],
  );
  const boxes = rows().map((row) => row.querySelector('.breakpoint-sync-row input'));
  assert.deepEqual(
    boxes.map((box) => [box.checked, box.indeterminate]),
    [
      [false, true],
      [true, false],
      [false, false],
    ],
  );
  const longPath = rows()[2].querySelector('.breakpoint-sync-path');
  assert.ok(longPath.getAttribute('title').endsWith('Card.astro'), 'the full path is the tooltip');
  assert.ok(longPath.textContent.includes('…'), 'a long path is shortened in the middle');
  assert.equal(button('Update 2 places').disabled, false);
  assert.equal(button('Just save the number').disabled, false);
  root.unmount();
});

test('places open with their line and before and after, and carry their labels', async () => {
  fakeBridge(scanFixture());
  const { root } = await mount('sync-places');
  await commit('Laptop', '70rem');
  await click(rows()[0].querySelector('.breakpoint-sync-open'));
  const places = [...rows()[0].querySelectorAll('.breakpoint-sync-place')];
  assert.equal(places.length, 2);
  assert.equal(places[0].querySelector('.breakpoint-sync-line').textContent, 'Line 2');
  assert.equal(places[0].querySelector('.breakpoint-sync-before').textContent, '@media (min-width: 64rem)');
  assert.equal(places[0].querySelector('.breakpoint-sync-after').textContent, '@media (min-width: 70rem)');
  assert.ok(places[0].querySelector('.breakpoint-sync-flag') === null);
  assert.equal(places[1].querySelector('.breakpoint-sync-flag').textContent, 'Inclusive 1px form');
  assert.equal(places[1].querySelector('input').checked, false);
  await click(rows()[2].querySelector('.breakpoint-sync-open'));
  assert.equal(rows()[2].querySelector('.breakpoint-sync-flag').textContent, 'Not synced');
  root.unmount();
});

test('All, None, a file box and a place box change what the button says; nothing checked disables it', async () => {
  fakeBridge(scanFixture());
  const { root } = await mount('sync-select');
  await commit('Laptop', '70rem');
  await click(button('All'));
  assert.ok(button('Update 4 places'));
  await click(button('None'));
  assert.equal(button('Update 0 places').disabled, true, 'nothing checked, nothing to write');
  await click(rows()[1].querySelector('.breakpoint-sync-row input'));
  assert.ok(button('Update 1 place'), 'the singular is used for one');
  await click(rows()[0].querySelector('.breakpoint-sync-row input'));
  assert.ok(button('Update 3 places'));
  await click(rows()[1].querySelector('.breakpoint-sync-row input'));
  assert.ok(button('Update 2 places'));
  root.unmount();
});

test('Just save the number sends nothing and closes; the number stays saved', async () => {
  const calls = fakeBridge(scanFixture());
  const { root, storage } = await mount('sync-skip');
  await commit('Laptop', '70rem');
  await click(button('Just save the number'));
  await settle(300);
  assert.ok(dialog() === null);
  assert.equal(calls.apply.length, 0);
  assert.equal(calls.restore.length, 0);
  assert.equal(JSON.parse(storage.state.source).breakpoints[0].value, 70);
  root.unmount();
});

test('Update sends exactly the checked places and the unchecked ones to remember, and records one undo step', async () => {
  const calls = fakeBridge(scanFixture());
  const undo = [];
  const { root, storage } = await mount('sync-apply', (command) => undo.push(command));
  await commit('Laptop', '70rem');
  await click(button('Update 2 places'));
  await settle(60);
  assert.equal(calls.apply.length, 1);
  const request = calls.apply[0];
  assert.equal(request.key, 'laptop');
  assert.equal(request.projectPath, 'sync-apply');
  assert.deepEqual(
    request.files.map((file) => [file.rel, file.edits.map((edit) => [edit.start, edit.end, edit.before, edit.after])]),
    [
      ['src/styles/site.css', [[20, 25, '64rem', '70rem']]],
      ['src/pages/index.astro', [[90, 95, '64rem', '70rem']]],
    ],
  );
  assert.equal(request.unchecked.length, 2);
  assert.match(toastMessages(), /Updated 2 places\./, 'the result is a toast');
  assert.equal(document.querySelectorAll('[role="alert"], .app-settings-notice, .breakpoint-sync-note').length, 0, 'and no paragraph is added to the panel');
  assert.equal(undo.length, 1);
  assert.equal(undo[0].label, 'Sync breakpoint queries');
  await undo[0].undo();
  assert.deepEqual(calls.restore, [{ projectPath: 'sync-apply', journalId: 'journal-1', direction: 'undo' }]);
  assert.equal(JSON.parse(storage.state.source).breakpoints[0].value, 64, 'undo puts the old number back too');
  await undo[0].redo();
  assert.equal(calls.restore[1].direction, 'redo');
  assert.equal(JSON.parse(storage.state.source).breakpoints[0].value, 70);
  root.unmount();
});

test('no dialog when nothing matches, none when the number did not change, none without the bridge', async () => {
  const calls = fakeBridge({ ...scanFixture(), files: [] });
  const { root } = await mount('sync-none');
  await commit('Laptop', '70rem');
  assert.equal(calls.scan.length, 1);
  assert.ok(dialog() === null);
  await commit('Laptop', '70 rem');
  assert.equal(calls.scan.length, 1, 'the same value again is not a change');
  window.avb = undefined;
  await commit('Tablet', '40rem');
  assert.ok(dialog() === null, 'Studio has no bridge and offers nothing');
  root.unmount();
});

test('a slow scan opens the dialog on skeleton rows with nothing to press', async () => {
  fakeBridge(scanFixture(), { scanDelayMs: 600 });
  const { root } = await mount('sync-slow');
  await commit('Laptop', '70rem');
  await settle(350);
  assert.ok(dialog(), 'the dialog shows while the scan is still running');
  assert.equal(title(), 'Looking for media queries…');
  assert.equal(button('Update 0 places').disabled, true);
  await settle(500);
  assert.equal(title(), 'Update 4 media queries?');
  root.unmount();
});

test('the dialog keeps to its width: paths and queries wrap, nothing scrolls sideways, no borders', () => {
  const css = fs.readFileSync(repoPath('src/app/settings/breakpointSyncDialog.css'), 'utf8');
  assert.match(css, /\.breakpoint-sync-body \{[^}]*overflow-x: hidden/);
  assert.match(css, /overflow-wrap: anywhere/);
  const borders = [...css.matchAll(/(?:^|[\s;{])border\s*:\s*([^;\s]+)/g)].map((match) => match[1]);
  assert.ok(borders.every((value) => value === '0' || value === 'none'));
});

function usageFixture() {
  const place = (locator, line, overrides = {}) => occurrence(locator, line, { before: '64rem', after: '64rem', ...overrides });
  return {
    entries: [
      {
        id: 'laptop',
        files: [
          {
            rel: 'src/styles/site.css',
            kind: 'css',
            digest: 'a',
            occurrences: [place('00000001:0', 2), place('00000001:1', 5, { before: '1023px', reason: 'inclusive', checked: false })],
          },
          { rel: 'src/pages/index.astro', kind: 'page', digest: 'b', occurrences: [place('00000002:0', 9)] },
        ],
      },
      { id: 'tablet', files: [{ rel: 'src/components/Card.astro', kind: 'component', digest: 'c', occurrences: [place('00000003:0', 3)] }] },
      { id: 'phone', files: [] },
    ],
    lumos: false,
    truncated: false,
    skipped: 0,
    recordProblem: undefined,
  };
}

const usageLine = (label) => card(label).querySelector('.breakpoints-usage');
const card = (label) => field(label).closest('.breakpoints-card');
const open = (label) => click(card(label).querySelector('.breakpoints-usage-toggle'));

test('each card says where it is used, before anything is changed, and writes nothing', async () => {
  const calls = fakeBridge(scanFixture());
  const { root, storage } = await mount('usage-line');
  assert.equal(calls.usage.length, 1, 'one scan when the tab opens');
  assert.deepEqual(
    calls.usage[0].breakpoints.map((entry) => [entry.id, entry.direction, entry.value, entry.unit]),
    [
      ['laptop', 'down', 64, 'rem'],
      ['tablet', 'down', 48, 'rem'],
      ['phone', 'down', 30, 'rem'],
    ],
  );
  assert.equal(usageLine('Laptop').textContent, 'Used in 3 places · 2 files');
  assert.equal(usageLine('Tablet').textContent, 'Used in 1 place · 1 file');
  assert.equal(usageLine('Phone').textContent, 'Not used in any media query');
  assert.ok(card('Phone').querySelector('.breakpoints-usage-toggle') === null, 'nothing to open when there is nothing');
  assert.equal(calls.record.writes.length, 0, 'looking writes nothing');
  assert.equal(storage.state.writes.length, 0);
  assert.equal(calls.apply.length, 0);
  assert.ok(dialog() === null);
  root.unmount();
});

test('the chevron opens the files of one card: kind pills, paths, counts, boxes; ambiguous places start unchecked and say so', async () => {
  fakeBridge(scanFixture());
  const { root } = await mount('usage-open');
  assert.ok(card('Laptop').querySelector('.breakpoints-usage-list') === null);
  await open('Laptop');
  const list = card('Laptop').querySelector('.breakpoints-usage-list');
  assert.ok(list, 'the list opens inside the card');
  assert.ok(card('Tablet').querySelector('.breakpoints-usage-list') === null, 'only that card');
  const rows = [...list.querySelectorAll('.breakpoint-sync-file')];
  assert.deepEqual(
    rows.map((row) => [
      row.querySelector('.breakpoint-sync-kind').getAttribute('aria-label'),
      row.querySelector('.breakpoint-sync-path').getAttribute('title'),
      row.querySelector('.breakpoint-sync-count').textContent,
    ]),
    [
      ['CSS file', 'src/styles/site.css', '2'],
      ['Page', 'src/pages/index.astro', '1'],
    ],
  );
  assert.deepEqual(
    rows.map((row) => {
      const box = row.querySelector('.breakpoint-sync-row input');
      return [box.checked, box.indeterminate];
    }),
    [
      [false, true],
      [true, false],
    ],
  );
  await click(rows[0].querySelector('.breakpoint-sync-open'));
  const places = [...list.querySelectorAll('.breakpoint-sync-place')];
  assert.equal(places[1].querySelector('.breakpoint-sync-flag').textContent, 'Inclusive 1px form');
  assert.equal(places[1].querySelector('input').checked, false);
  assert.match(list.querySelector('.breakpoints-usage-files').className, /breakpoints-usage-files/);
  await open('Laptop');
  assert.ok(card('Laptop').querySelector('.breakpoints-usage-list') === null, 'the chevron closes it again');
  root.unmount();
});

test('a tick is saved at once, one write each, and a file box covers its places', async () => {
  const calls = fakeBridge(scanFixture());
  const { root } = await mount('usage-toggle');
  await open('Laptop');
  const files = () => [...card('Laptop').querySelectorAll('.breakpoint-sync-file')];
  await click(files()[1].querySelector('.breakpoint-sync-row input'));
  await settle(60);
  assert.equal(calls.record.writes.length, 1, 'one write for one toggle');
  const first = JSON.parse(calls.record.source);
  assert.deepEqual(first.laptop.excluded, [{ file: 'src/pages/index.astro', locator: '00000002:0' }], 'an unticked exact place is remembered as left alone');
  assert.ok(first.laptop.linked === undefined, 'nothing is recorded as synced yet');
  await click(files()[0].querySelector('.breakpoint-sync-row input'));
  await settle(60);
  assert.equal(calls.record.writes.length, 2);
  const second = JSON.parse(calls.record.source);
  assert.deepEqual(
    second.laptop.linked,
    [{ file: 'src/styles/site.css', locator: '00000001:1' }],
    'ticking a half-ticked file ticks the ambiguous place, which is remembered as wanted',
  );
  assert.equal(second.laptop.excluded.length, 1);
  assert.ok(second.tablet === undefined, 'other breakpoints are untouched');
  root.unmount();
});

test('All and None on a card save every place once; a second None changes nothing and writes nothing', async () => {
  const calls = fakeBridge(scanFixture());
  const { root } = await mount('usage-all-none');
  await open('Laptop');
  const bar = () => [...card('Laptop').querySelectorAll('.breakpoint-sync-bar button')];
  await click(bar()[1]);
  await settle(60);
  assert.equal(calls.record.writes.length, 1);
  assert.equal(JSON.parse(calls.record.source).laptop.excluded.length, 2, 'both exact places are left alone; the ambiguous one was never checked');
  await click(bar()[1]);
  await settle(60);
  assert.equal(calls.record.writes.length, 1, 'nothing to change, nothing written');
  root.unmount();
});

test('typing a different valid number says what the change will touch; the counts stay those of the saved value', async () => {
  const calls = fakeBridge(scanFixture());
  const { root } = await mount('usage-pending');
  const input = field('Laptop');
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, '70rem');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  assert.equal(usageLine('Laptop').textContent, 'Will update 2 places in 2 files', 'only the checked places count');
  assert.equal(usageLine('Tablet').textContent, 'Used in 1 place · 1 file', 'the others still describe what is saved');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'abc');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  assert.equal(usageLine('Laptop').textContent, 'Used in 3 places · 2 files', 'an invalid value is not a pending change');
  assert.equal(calls.record.writes.length, 0);
  root.unmount();
});

test('the files link opens the file when the app can, and a scan that fails says so once, quietly', async () => {
  const opened = [];
  fakeBridge(scanFixture());
  document.body.innerHTML = '<div id="root"></div>';
  const linkRoot = createRoot(document.getElementById('root'));
  api.forgetBreakpointStores();
  api.breakpointsStore('usage-link', memoryStorage(undefined));
  await act(() => linkRoot.render(React.createElement(api.BreakpointsSettings, { projectPath: 'usage-link', onOpenFile: (rel) => opened.push(rel) })));
  await settle();
  await open('Laptop');
  await click(card('Laptop').querySelector('.breakpoint-sync-link'));
  assert.deepEqual(opened, ['src/styles/site.css']);
  linkRoot.unmount();
  window.avb = {
    scanBreakpointSync: async () => ({ ok: false }),
    scanBreakpointUsage: async () => ({ ok: false, error: 'disk is busy' }),
  };
  const failing = await mount('usage-fails');
  await settle();
  assert.match(toastMessages(), /Could not look for where this is used\. disk is busy/, 'the failure is one toast');
  assert.doesNotMatch(document.body.textContent, /disk is busy/, 'and is not drawn in the card');
  assert.equal(document.querySelector('.breakpoints-usage-problem') ?? undefined, undefined);
  failing.root.unmount();
});

// A refused value takes the error look on its card and says why once, as a toast, when the field is committed: no paragraph is added to
// the card, so nothing below it moves. A value that is accepted says nothing (negative space).
test('a refused breakpoint value is an error look and one toast, never a paragraph; a valid one says nothing', async () => {
  fakeBridge(scanFixture());
  const view = await mount('refused-values');
  const card = () => document.querySelector('.breakpoints-card[data-breakpoint="laptop"]');
  globalThis.stackiCapturedToasts = [];
  await commit('Laptop', 'abc');
  assert.equal(toastMessages().split('\n').filter(Boolean).length, 1, 'one toast, said when the value is committed');
  assert.ok(toastMessages().length > 0);
  assert.equal(card().hasAttribute('data-invalid'), true, 'the card takes the error look (a fill)');
  assert.equal(field('Laptop').getAttribute('aria-invalid'), 'true');
  assert.equal(document.querySelectorAll('[role="alert"], .breakpoints-problem, .breakpoints-note, .app-settings-notice').length, 0, 'no paragraph is added');
  // Escape puts the saved value back and the look goes.
  await act(async () => {
    field('Laptop').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  assert.equal(card().hasAttribute('data-invalid'), false, 'the saved value shows no error look');
  globalThis.stackiCapturedToasts = [];
  await commit('Laptop', '65rem');
  assert.equal(toastMessages(), '', 'a valid value says nothing');
  view.root.unmount();
});

test('what a sync scan could not read is a warning toast in the dialog, not a note under the list', async () => {
  const scan = { ...scanFixture(), truncated: true, skipped: 2, recordProblem: 'the record is corrupt' };
  fakeBridge(scan);
  globalThis.stackiCapturedToasts = [];
  const view = await mount('sync-warnings');
  await commit('Laptop', '70rem');
  assert.ok(dialog(), 'the dialog opens');
  const said = toastMessages();
  assert.match(said, /some files were not read/);
  assert.match(said, /Large files were not read/);
  assert.match(said, /the record is corrupt/);
  assert.equal(document.querySelectorAll('.breakpoint-sync-note').length, 0, 'the dialog appends no note');
  view.root.unmount();
});
