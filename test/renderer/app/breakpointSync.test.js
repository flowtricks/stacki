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
// unavailable bridge (Studio) opens nothing.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');

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
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  getComputedStyle: window.getComputedStyle.bind(window),
  matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
});
window.matchMedia = global.matchMedia;
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
  const calls = { scan: [], apply: [], restore: [] };
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
    rows().map((row) => row.querySelector('.breakpoint-sync-pill').textContent),
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
  assert.match(document.body.textContent, /Updated 2 places\./);
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
