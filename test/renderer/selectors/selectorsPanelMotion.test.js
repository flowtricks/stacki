// Goal: a lock click animates its row instead of making it vanish. In a
// filtered tab the row stays through the change (lock and colour) and the
// collapse, then is removed; in the All tab it stays and only its lock and
// colour change; a double click writes once and neither duplicates nor loses
// a row; unmounting mid-animation leaves no timer behind. A stylesheet lock
// moves its rows the same way: rows leaving the tab change colour, then close
// with their group; rows arriving open in.
// Method: render the real panel in JSDOM over an in-memory bridge (the report
// is recomputed from the keep list each read, as the main process does), with
// Node's mock timers standing in for setTimeout so each phase can be stepped
// exactly. Promises and React's scheduler run on the real event loop, flushed
// with setImmediate.
const assert = require('node:assert/strict');
const { test, mock } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { repoPath } = require('../../helpers/sources.js');

const PROJECT = path.join(os.tmpdir(), 'stacki-selectors-motion');
// [id, selector, names, verdict when the names are not locked]
const ENTRIES = [
  ['src/a.css|0|0|0', '.hero', ['hero'], 'used'],
  ['src/a.css|0|1|0', '.ghost', ['ghost'], 'unused'],
  ['src/a.css|0|2|0', '.is-open', ['is-open'], 'unused'],
  ['src/a.css|0|3|0', '.tail', ['tail'], 'unused'],
  ['src/a.css|0|4|0', '.maybe', ['maybe'], 'unknown'],
];

function report(keep, sheets) {
  const entries = ENTRIES.map(([id, selector, names, base]) => {
    const locked = base !== 'used' && (sheets.includes('src/a.css') || names.every((name) => keep.includes(name)));
    const verdict = locked
      ? { kind: 'kept', names }
      : base === 'used'
        ? { kind: 'used' }
        : base === 'unknown'
          ? { kind: 'unknown', names, reason: 'built from pieces' }
          : { kind: base, names };
    return { id, rel: 'src/a.css', line: 1, selector, scope: 'global', verdict };
  });
  return { entries, notes: [], files: [] };
}

function bridge(store) {
  const keep = () => (store.source === undefined ? [] : JSON.parse(store.source).keep);
  const sheets = () => (store.source === undefined ? [] : (JSON.parse(store.source).lockedStylesheets ?? []));
  return {
    selectorUsage: async () => ({ ok: true, value: report(keep(), sheets()) }),
    projectMetadata: async () => ({ ok: true, value: store.source === undefined ? {} : { source: store.source } }),
    writeProjectMetadata: async (input) => {
      store.writes += 1;
      store.source = input.write.source;
      return { ok: true, value: { source: store.source } };
    },
    onCssChanged: () => () => {},
    onFsChanged: () => () => {},
  };
}

async function load() {
  const esbuild = require('esbuild');
  const bundle = repoPath('node_modules/.stacki-test/selectors-panel-motion.bundle.js');
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  await esbuild.build({
    entryPoints: [repoPath('src/features/selectors/SelectorsPanel.tsx')],
    outfile: bundle,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });
  return bundle;
}

test('a lock click keeps its row through the change and the collapse', async () => {
  const bundle = await load();
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const store = { source: undefined, writes: 0 };
  dom.window.avb = bridge(store);
  mock.timers.enable({ apis: ['setTimeout'] });
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const SelectorsPanel = require(bundle).default;
  const container = document.getElementById('root');
  const reactRoot = createRoot(container);

  // Promises (the bridge, the coalesced re-read) settle on the real event loop.
  const flush = () =>
    act(async () => {
      for (let turn = 0; turn < 40; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    });
  const tick = async (ms) => {
    await act(async () => mock.timers.tick(ms));
    await flush();
  };
  // Each row as selector:verdict:phase, the phase read from its slot.
  const rows = () =>
    [...container.querySelectorAll('.selectors-row-slot')].map((slot) => {
      const row = slot.querySelector('.selectors-row');
      const phase = slot.classList.contains('is-collapsing') ? 'collapsing' : slot.classList.contains('is-entering') ? 'entering' : 'shown';
      return `${row.querySelector('.selectors-selector').textContent}:${/is-(\w+)/.exec(row.className)[1]}:${phase}`;
    });
  const rowOf = (selector) =>
    [...container.querySelectorAll('.selectors-row')].find((row) => row.querySelector('.selectors-selector').textContent === selector);
  const lockOf = (selector) => rowOf(selector).querySelector('.selectors-lock');
  const lockOpen = (selector) => lockOf(selector).querySelector('.selectors-lock-icon').classList.contains('is-open');
  const openTab = async (label) => {
    await act(async () => [...container.querySelectorAll('.selectors-tab')].find((tab) => tab.textContent.startsWith(label)).click());
    await flush();
  };
  try {
    await act(async () => {
      reactRoot.render(React.createElement(SelectorsPanel, { project: { path: PROJECT }, showToast: () => undefined, onRecordUndo: () => undefined }));
    });
    await flush();
    assert.deepEqual(rows(), ['.ghost:unused:shown', '.is-open:unused:shown', '.tail:unused:shown'], 'opens on Unused');

    // Locking from Unused: the lock closes at once, the colour follows the saved verdict.
    assert.equal(lockOpen('.is-open'), true);
    await act(async () => lockOf('.is-open').click());
    assert.equal(lockOpen('.is-open'), false, 'the lock shows where the click is going before the save answers');
    await flush();
    assert.equal(store.writes, 1);
    assert.deepEqual(rows(), ['.ghost:unused:shown', '.is-open:kept:shown', '.tail:unused:shown'], 'the row stays, now blue, while it changes');
    await tick(199);
    assert.deepEqual(rows(), ['.ghost:unused:shown', '.is-open:kept:shown', '.tail:unused:shown'], 'the change takes its full 200ms');
    await tick(1);
    assert.deepEqual(rows(), ['.ghost:unused:shown', '.is-open:kept:collapsing', '.tail:unused:shown'], 'then it collapses in place');
    assert.equal(rowOf('.is-open').parentElement.getAttribute('aria-hidden'), 'true', 'a collapsing row is gone for assistive tech');
    // With no layout in JSDOM no transitionend fires; the fallback timer ends the collapse.
    await tick(319);
    assert.equal(rows().length, 3);
    await tick(1);
    assert.deepEqual(rows(), ['.ghost:unused:shown', '.tail:unused:shown'], 'then it is removed');

    // A transitionend on the slot ends a collapse without waiting for the fallback.
    await act(async () => lockOf('.tail').click());
    await flush();
    await tick(200);
    assert.deepEqual(rows(), ['.ghost:unused:shown', '.tail:kept:collapsing']);
    const ended = new dom.window.Event('transitionend', { bubbles: true });
    Object.defineProperty(ended, 'propertyName', { value: 'grid-template-rows' });
    await act(async () => rowOf('.tail').parentElement.dispatchEvent(ended));
    assert.deepEqual(rows(), ['.ghost:unused:shown'], 'the row goes when its height transition ends');
    await tick(320);
    assert.deepEqual(rows(), ['.ghost:unused:shown'], 'the fallback that follows changes nothing');

    // In All a row never leaves: only the lock and the colour change.
    await openTab('All');
    assert.deepEqual(rows(), ['.hero:used:shown', '.ghost:unused:shown', '.is-open:kept:shown', '.tail:kept:shown', '.maybe:unknown:shown']);
    await act(async () => lockOf('.ghost').click());
    await flush();
    await tick(600);
    assert.deepEqual(rows(), ['.hero:used:shown', '.ghost:kept:shown', '.is-open:kept:shown', '.tail:kept:shown', '.maybe:unknown:shown']);
    assert.equal(lockOpen('.ghost'), false);

    // A double click on Locked writes once and moves exactly one row out.
    await openTab('Locked');
    assert.deepEqual(rows(), ['.ghost:kept:shown', '.is-open:kept:shown', '.tail:kept:shown']);
    const writes = store.writes;
    await act(async () => {
      lockOf('.is-open').click();
      lockOf('.is-open').click();
    });
    assert.equal(lockOpen('.is-open'), true, 'unlocking: the shackle opens at once');
    await flush();
    await act(async () => lockOf('.is-open').click());
    await flush();
    assert.equal(store.writes, writes + 1, 'clicks while a row animates are ignored');
    assert.deepEqual(JSON.parse(store.source).keep, ['ghost', 'tail']);
    assert.deepEqual(rows(), ['.ghost:kept:shown', '.is-open:unused:shown', '.tail:kept:shown'], 'now orange, still in place');
    await tick(200);
    await act(async () => lockOf('.is-open').click());
    assert.deepEqual(rows(), ['.ghost:kept:shown', '.is-open:unused:collapsing', '.tail:kept:shown']);
    await tick(320);
    assert.deepEqual(rows(), ['.ghost:kept:shown', '.tail:kept:shown']);
    assert.equal(store.writes, writes + 1, 'a click on a collapsing row is ignored too');

    // "Can't tell": a locked row stays in its reason group while it leaves.
    await openTab('Can');
    assert.deepEqual(rows(), ['.maybe:unknown:shown']);
    await act(async () => lockOf('.maybe').click());
    await flush();
    await tick(200);
    assert.deepEqual(rows(), ['.maybe:kept:collapsing']);
    assert.equal(container.querySelector('.selectors-reason').textContent, 'Built from pieces.');
    await tick(320);
    assert.deepEqual(rows(), []);

    // A stylesheet lock from Unused: its row turns blue in place, then the row and its group close together.
    const sheetLock = (label) => act(async () => container.querySelector(`[aria-label="${label}"]`).click());
    const group = () => container.querySelector('.selectors-group');
    await openTab('Unused');
    assert.deepEqual(rows(), ['.is-open:unused:shown']);
    await sheetLock('Lock a.css from cleanup');
    await flush();
    assert.deepEqual(rows(), ['.is-open:kept:shown'], 'the row stays, now blue, while it changes');
    assert.equal(group().classList.contains('is-collapsing'), false);
    await tick(200);
    assert.deepEqual(rows(), ['.is-open:kept:collapsing']);
    assert.equal(group().classList.contains('is-collapsing'), true, 'a group whose rows all leave closes with them');
    await tick(320);
    assert.deepEqual(rows(), []);
    assert.equal(group() ?? undefined, undefined, 'and the group with it');

    // The sheet lock took in the name locks, so unlocking it from Locked moves every row out, and the group closes with them.
    await openTab('Locked');
    assert.deepEqual(rows(), ['.ghost:kept:shown', '.is-open:kept:shown', '.tail:kept:shown', '.maybe:kept:shown']);
    await sheetLock('Unlock a.css');
    await flush();
    assert.deepEqual(rows(), ['.ghost:unused:shown', '.is-open:unused:shown', '.tail:unused:shown', '.maybe:unknown:shown']);
    await tick(200);
    assert.deepEqual(rows(), ['.ghost:unused:collapsing', '.is-open:unused:collapsing', '.tail:unused:collapsing', '.maybe:unknown:collapsing']);
    assert.equal(group().classList.contains('is-collapsing'), true);
    await tick(320);
    assert.deepEqual(rows(), []);

    // Locking it from Locked with one row already there: the rows it brings in open; the one there does not.
    const lockInAll = async (selector) => {
      await act(async () => lockOf(selector).click());
      await flush();
      await tick(600);
    };
    await openTab('All');
    await lockInAll('.ghost');
    await openTab('Locked');
    assert.deepEqual(rows(), ['.ghost:kept:shown']);
    await sheetLock('Lock a.css from cleanup');
    await flush();
    assert.deepEqual(rows(), ['.ghost:kept:shown', '.is-open:kept:entering', '.tail:kept:entering', '.maybe:kept:entering']);
    assert.equal(group().classList.contains('is-entering'), false, 'a group that was already there does not open again');
    await tick(520);
    await sheetLock('Unlock a.css');
    await flush();
    await tick(200);
    await tick(320);
    assert.deepEqual(rows(), []);
    assert.deepEqual(JSON.parse(store.source).lockedStylesheets ?? [], []);
    // Back to the names locked before the sheet.
    await openTab('All');
    for (const selector of ['.ghost', '.tail', '.maybe']) {
      await lockInAll(selector);
    }
    assert.deepEqual(JSON.parse(store.source).keep, ['ghost', 'maybe', 'tail']);

    // Leaving a tab mid-animation drops its held rows; the new tab lists by verdict alone.
    await openTab('Locked');
    await act(async () => lockOf('.ghost').click());
    await flush();
    await openTab('Unused');
    assert.deepEqual(rows(), ['.ghost:unused:shown', '.is-open:unused:shown']);
    await tick(600);
    assert.deepEqual(rows(), ['.ghost:unused:shown', '.is-open:unused:shown']);

    // Unmounting mid-animation clears its timers.
    await act(async () => lockOf('.ghost').click());
    await flush();
  } finally {
    await act(async () => reactRoot.unmount());
    await act(async () => mock.timers.tick(1_000));
    mock.timers.reset();
    dom.window.close();
  }
});
