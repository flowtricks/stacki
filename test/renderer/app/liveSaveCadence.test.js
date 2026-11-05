// Goal: a style-panel drag reaches the canvas while it moves, not only when it
// stops. Dragging a padding or margin value of the open page's <style> block
// writes the block into the page model once per animation frame, with the
// 'live' urgency, and the canvas only changes when the page is saved: the
// preview is the dev server's render of the file. The 'live' save used to be a
// trailing debounce of 120 ms, and every frame of the drag (about 16 ms apart)
// cleared it and started it again, so a steady drag saved nothing at all until
// the pointer rested. The page "sometimes" updated: whenever the hand paused.
// A live request may no longer postpone a save that is already due.
// Method: the real useScheduleSave hook, mounted in jsdom with the state it
// reads stubbed, and node:test's mock timers standing in for the clock. A drag
// is replayed as one 'live' request per 16 ms frame for a second, and the
// autosave calls are counted while it moves: at least one per live delay, and
// one more for the final value once it stops. The negative space keeps the
// other urgencies as they were: typing (no urgency) still waits for a pause in
// the keystrokes, an immediate request still saves on the next tick and is not
// held back by a pending live one, and a save that ran leaves nothing pending.
const assert = require('node:assert/strict');
const { test, mock } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const FRAME_MS = 16;
const DRAG_FRAMES = 63; // About a second of steady movement.
const LIVE_DELAY_MS = 120;
const TYPING_DELAY_MS = 300;

const directory = repoPath('node_modules/.stacki-test/live-save-cadence');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'scheduleSave.cjs');
buildSync({
  stdin: {
    contents: "export { useScheduleSave } from './src/app/state/appHistory';",
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
});

// The hook, mounted once, with every save it starts counted.
async function mountScheduleSave() {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  Object.assign(global, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const { useScheduleSave } = require(output);
  const saves = { count: 0 };
  const coreState = {
    pageStateRef: { current: { currentPage: undefined, pageState: undefined } },
    saveTimer: { current: undefined },
    setLeftTab: () => {},
    setPageState: () => {},
  };
  const lifecycle = {
    autosave: () => {
      saves.count += 1;
      return Promise.resolve([undefined, undefined]);
    },
    editDrafts: {},
    showToast: () => {},
  };
  const typedParse = { scheduleSaveRef: { current: undefined } };
  const historyPush = { pushEditHistory: () => {} };
  const hook = { scheduleSave: undefined };
  function Probe() {
    hook.scheduleSave = useScheduleSave(coreState, lifecycle, typedParse, historyPush).scheduleSave;
    return undefined;
  }
  const root = createRoot(document.getElementById('root'));
  await act(() => root.render(React.createElement(Probe)));
  assert.equal(typeof hook.scheduleSave, 'function', 'the hook hands back scheduleSave');
  return { schedule: (urgency) => hook.scheduleSave(urgency), saves, unmount: () => act(() => root.unmount()) };
}

test('a steady drag saves while it moves, and once more for its final value', async () => {
  const mounted = await mountScheduleSave();
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    for (let frame = 0; frame < DRAG_FRAMES; frame += 1) {
      mounted.schedule('live');
      mock.timers.tick(FRAME_MS);
    }
    const duringDrag = mounted.saves.count;
    const dragMs = DRAG_FRAMES * FRAME_MS;
    assert.ok(duringDrag >= Math.floor(dragMs / LIVE_DELAY_MS) - 1, `the canvas hears the drag while it moves (saved ${duringDrag} times in ${dragMs} ms)`);
    assert.ok(duringDrag <= Math.ceil(dragMs / LIVE_DELAY_MS), `live saves stay throttled to one per ${LIVE_DELAY_MS} ms (saved ${duringDrag} times)`);
    mock.timers.tick(LIVE_DELAY_MS);
    assert.equal(mounted.saves.count, duringDrag + 1, 'the last frame of the drag is saved once the pointer rests');
    mock.timers.tick(LIVE_DELAY_MS * 4);
    assert.equal(mounted.saves.count, duringDrag + 1, 'nothing is left pending after the last save');
  } finally {
    mock.timers.reset();
    await mounted.unmount();
  }
});

test('typing still waits for a pause in the keystrokes', async () => {
  const mounted = await mountScheduleSave();
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    for (let key = 0; key < 20; key += 1) {
      mounted.schedule(false);
      mock.timers.tick(50);
    }
    assert.equal(mounted.saves.count, 0, 'keystrokes 50 ms apart are one batch');
    mock.timers.tick(TYPING_DELAY_MS);
    assert.equal(mounted.saves.count, 1, 'the batch saves once the typing stops');
  } finally {
    mock.timers.reset();
    await mounted.unmount();
  }
});

test('an immediate save is not held back by a pending live one', async () => {
  const mounted = await mountScheduleSave();
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    mounted.schedule('live');
    mock.timers.tick(FRAME_MS);
    mounted.schedule(true);
    mock.timers.tick(0);
    assert.equal(mounted.saves.count, 1, 'the commit saves on the next tick');
    mock.timers.tick(LIVE_DELAY_MS * 2);
    assert.equal(mounted.saves.count, 1, 'the commit replaced the live save rather than adding one');
    // A save that has run leaves nothing behind that a live request could
    // mistake for one still pending.
    mounted.schedule('live');
    mock.timers.tick(LIVE_DELAY_MS);
    assert.equal(mounted.saves.count, 2, 'a live request after a save schedules its own');
  } finally {
    mock.timers.reset();
    await mounted.unmount();
  }
});
