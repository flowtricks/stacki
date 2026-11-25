// Goal: the main window reopens where it was (electron/app/windowState.ts, windowStateStore.ts): its windowed
// size and place, maximized or full screen, on a display that still exists, and never in a spot a person cannot
// reach.
// Method: the boundary parser is driven with a known-good value and every bad shape; the fit step is a pure
// function, driven with an off-screen window, a huge one, a tiny one, a secondary display left of the primary
// (negative origin), a removed display and a smaller one; the debounce runs on a fake clock and is held to its
// bound; the file round trip uses a temporary folder. Nothing here depends on a real display or the wall clock.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  WINDOW_STATE_LIMITS,
  WINDOW_STATE_VERSION,
  createDebouncedSaver,
  fitWindowState,
  parseWindowState,
  parseWindowStateText,
} = require('#dist/electron/app/windowState.js');
const { HEIGHT_PX_MIN, WIDTH_PX_MIN } = require('#dist/electron/app/windowBounds.js');
const { WINDOW_STATE_FILE, readWindowState, snapshotWindow, trackWindowState, writeWindowState } = require('#dist/electron/app/windowStateStore.js');

const primary = { id: 1, scaleFactor: 2, workArea: { x: 0, y: 38, width: 1728, height: 1079 } };
const leftMonitor = { id: 2, scaleFactor: 1, workArea: { x: -2560, y: 0, width: 2560, height: 1415 } };
const good = {
  version: WINDOW_STATE_VERSION,
  bounds: { x: 100, y: 120, width: 1300, height: 800 },
  maximized: false,
  fullScreen: false,
  displayId: 1,
  scaleFactor: 2,
};

test('a good state parses to itself', () => {
  const parsed = parseWindowState(good);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value, good);
});

test('every bad shape is an error value, never a crash', () => {
  const bad = [
    undefined,
    'text',
    42,
    [],
    {},
    { ...good, version: 2 },
    { ...good, version: undefined },
    { ...good, bounds: undefined },
    { ...good, bounds: 'x' },
    { ...good, bounds: { ...good.bounds, x: 1.5 } },
    { ...good, bounds: { ...good.bounds, x: '1' } },
    { ...good, bounds: { ...good.bounds, x: WINDOW_STATE_LIMITS.coordinateAbsPxMax + 1 } },
    { ...good, bounds: { ...good.bounds, y: -WINDOW_STATE_LIMITS.coordinateAbsPxMax - 1 } },
    { ...good, bounds: { ...good.bounds, y: Number.NaN } },
    { ...good, bounds: { ...good.bounds, width: 0 } },
    { ...good, bounds: { ...good.bounds, width: -5 } },
    { ...good, bounds: { ...good.bounds, height: WINDOW_STATE_LIMITS.sizePxMax + 1 } },
    { ...good, bounds: { ...good.bounds, height: Number.POSITIVE_INFINITY } },
    { ...good, maximized: 'yes' },
    { ...good, fullScreen: 1 },
    { ...good, displayId: 'a' },
    { ...good, displayId: 1.5 },
    { ...good, scaleFactor: 0 },
    { ...good, scaleFactor: -1 },
    { ...good, scaleFactor: WINDOW_STATE_LIMITS.scaleFactorMax + 1 },
    { ...good, scaleFactor: Number.NaN },
  ];
  for (const input of bad) {
    const parsed = parseWindowState(input);
    assert.equal(parsed.ok, false, JSON.stringify(input));
    assert.equal(parsed.error.code, 'window-state-invalid');
  }
  assert.equal(parseWindowStateText('{not json').ok, false);
  assert.equal(parseWindowStateText(' '.repeat(WINDOW_STATE_LIMITS.fileBytesMax + 1)).ok, false);
});

test('a window still on a display stays where it was', () => {
  const fitted = fitWindowState(parseWindowState(good).value, [primary], primary);
  assert.equal(fitted.placement, 'saved');
  assert.deepEqual(fitted.bounds, good.bounds);
  assert.equal(fitted.minWidth, WIDTH_PX_MIN);
  assert.equal(fitted.minHeight, HEIGHT_PX_MIN);
});

test('a window entirely off every display is centred on the primary one', () => {
  const state = { ...good, bounds: { x: 9000, y: 9000, width: 1300, height: 800 } };
  const fitted = fitWindowState(state, [primary], primary);
  assert.equal(fitted.placement, 'primary');
  assert.equal(fitted.bounds.width, 1300);
  assert.equal(fitted.bounds.x, Math.floor((1728 - 1300) / 2));
  assert.equal(fitted.bounds.y, 38 + Math.floor((1079 - 800) / 2));
});

test('a window with only a sliver on a display counts as off it', () => {
  const state = { ...good, bounds: { x: 1700, y: 200, width: 1300, height: 800 } };
  assert.equal(fitWindowState(state, [primary], primary).placement, 'primary');
});

test('a window larger than its display is cut to the display', () => {
  const state = { ...good, bounds: { x: -300, y: -300, width: 9000, height: 9000 } };
  const fitted = fitWindowState(state, [primary], primary);
  assert.equal(fitted.placement, 'saved');
  assert.deepEqual(fitted.bounds, { x: 0, y: 38, width: 1728, height: 1079 });
});

test('a window hanging over the bottom edge is moved up inside the work area', () => {
  const state = { ...good, bounds: { x: 100, y: 700, width: 1300, height: 800 } };
  const fitted = fitWindowState(state, [primary], primary);
  assert.equal(fitted.bounds.y + fitted.bounds.height, 38 + 1079);
});

test('a tiny window is raised to the minimum size', () => {
  const state = { ...good, bounds: { x: 100, y: 100, width: 10, height: 10 } };
  const fitted = fitWindowState(state, [primary], primary);
  assert.equal(fitted.bounds.width, WIDTH_PX_MIN);
  assert.equal(fitted.bounds.height, HEIGHT_PX_MIN);
});

test('a display smaller than the minimum still gets a minimum-size window', () => {
  const small = { id: 3, scaleFactor: 1, workArea: { x: 0, y: 0, width: 800, height: 500 } };
  const fitted = fitWindowState({ ...good, bounds: { x: 0, y: 0, width: 800, height: 500 } }, [small], small);
  assert.equal(fitted.bounds.width, WIDTH_PX_MIN);
  assert.equal(fitted.bounds.height, HEIGHT_PX_MIN);
});

test('a secondary display left of the primary (negative origin) keeps its window', () => {
  const state = { ...good, bounds: { x: -2200, y: 100, width: 1400, height: 900 }, displayId: 2 };
  const fitted = fitWindowState(state, [primary, leftMonitor], primary);
  assert.equal(fitted.placement, 'saved');
  assert.deepEqual(fitted.bounds, state.bounds);
});

test('when that secondary display is gone the window comes back on the primary one', () => {
  const state = { ...good, bounds: { x: -2200, y: 100, width: 1400, height: 900 }, displayId: 2 };
  const fitted = fitWindowState(state, [primary], primary);
  assert.equal(fitted.placement, 'primary');
  assert.ok(fitted.bounds.x >= 0 && fitted.bounds.x + fitted.bounds.width <= 1728);
});

test('a display that is now smaller in device-independent units cuts the window to it', () => {
  const scaled = { ...primary, scaleFactor: 1, workArea: { x: 0, y: 0, width: 1280, height: 720 } };
  const fitted = fitWindowState(parseWindowState(good).value, [scaled], scaled);
  assert.ok(fitted.bounds.width <= 1280 && fitted.bounds.height <= 720);
});

test('maximized and full screen are carried through for the caller to apply before it shows the window', () => {
  const maximized = fitWindowState({ ...good, maximized: true }, [primary], primary);
  assert.equal(maximized.maximized, true);
  assert.deepEqual(maximized.bounds, good.bounds, 'the normal bounds are what un-maximizing returns to');
  assert.equal(fitWindowState({ ...good, fullScreen: true }, [primary], primary).fullScreen, true);
});

test('fitting with no display is a programmer error that crashes', () => {
  assert.throws(() => fitWindowState(parseWindowState(good).value, [], primary), /at least one display/);
});

function fakeClock() {
  let nowMs = 0;
  let pending;
  return {
    clock: {
      now: () => nowMs,
      setTimer: (task, delayMs) => {
        pending = { task, dueMs: nowMs + delayMs };
        return pending;
      },
      clearTimer: (timer) => {
        if (pending === timer) {
          pending = undefined;
        }
      },
    },
    advance: (durationMs) => {
      nowMs += durationMs;
      if (pending !== undefined && pending.dueMs <= nowMs) {
        const { task } = pending;
        pending = undefined;
        task();
      }
    },
    pending: () => pending !== undefined,
  };
}

test('a burst of events writes once, after it stops', () => {
  const time = fakeClock();
  let writes = 0;
  const saver = createDebouncedSaver(time.clock, () => (writes += 1));
  for (let event = 0; event < 50; event += 1) {
    saver.schedule();
    time.advance(10);
  }
  assert.equal(writes, 0, 'nothing is written while the drag goes on and is quick');
  time.advance(WINDOW_STATE_LIMITS.saveDelayMs);
  assert.equal(writes, 1);
  assert.equal(time.pending(), false);
});

test('a drag that never pauses still writes within the bound', () => {
  const time = fakeClock();
  let writes = 0;
  const saver = createDebouncedSaver(time.clock, () => (writes += 1));
  const stepMs = 100;
  const durationMs = WINDOW_STATE_LIMITS.saveWaitMsMax * 3;
  for (let elapsedMs = 0; elapsedMs < durationMs; elapsedMs += stepMs) {
    saver.schedule();
    time.advance(stepMs);
  }
  assert.ok(writes >= 2, `writes during a long drag: ${writes}`);
  assert.ok(writes <= 4, `not once per event: ${writes}`);
});

test('flush writes a waiting save now and does nothing when none waits', () => {
  const time = fakeClock();
  let writes = 0;
  const saver = createDebouncedSaver(time.clock, () => (writes += 1));
  saver.flush();
  assert.equal(writes, 0);
  saver.schedule();
  saver.flush();
  assert.equal(writes, 1);
  assert.equal(time.pending(), false);
  saver.flush();
  assert.equal(writes, 1);
});

test('the state file round trips, and a missing or damaged one reads as no state', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-window-state-'));
  try {
    assert.equal(readWindowState(directory).ok, false);
    assert.equal(writeWindowState(directory, parseWindowState(good).value), true);
    assert.deepEqual(readWindowState(directory).value, good);
    fs.writeFileSync(path.join(directory, WINDOW_STATE_FILE), '{"version":1,"bounds":', 'utf8');
    assert.equal(readWindowState(directory).ok, false);
    fs.writeFileSync(path.join(directory, WINDOW_STATE_FILE), 'x'.repeat(WINDOW_STATE_LIMITS.fileBytesMax + 10), 'utf8');
    assert.equal(readWindowState(directory).ok, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('tracking stores the normal bounds and flags, saves when the window closes, and ignores a destroyed window', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-window-state-'));
  try {
    const listeners = new Map();
    let destroyed = false;
    const window = {
      getNormalBounds: () => ({ x: 10.4, y: 20.6, width: 1200, height: 700 }),
      isMaximized: () => true,
      isFullScreen: () => false,
      isDestroyed: () => destroyed,
      on: (event, listener) => listeners.set(event, listener),
    };
    const screen = { getDisplayMatching: () => ({ id: 7, scaleFactor: 1.5, workArea: primary.workArea }) };
    const time = fakeClock();
    trackWindowState(window, screen, directory, time.clock);
    listeners.get('resize')();
    listeners.get('move')();
    listeners.get('close')();
    const saved = readWindowState(directory).value;
    assert.deepEqual(saved.bounds, { x: 10, y: 21, width: 1200, height: 700 });
    assert.equal(saved.maximized, true);
    assert.equal(saved.displayId, 7);
    assert.deepEqual(snapshotWindow(window, screen).bounds, saved.bounds);
    fs.rmSync(path.join(directory, WINDOW_STATE_FILE));
    destroyed = true;
    listeners.get('resize')();
    time.advance(WINDOW_STATE_LIMITS.saveDelayMs);
    assert.equal(readWindowState(directory).ok, false, 'a destroyed window writes nothing');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
