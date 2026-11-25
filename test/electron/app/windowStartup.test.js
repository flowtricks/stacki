// Goal: the main window starts without an empty-looking frame and says how long its start took.
// It is created hidden with the app's panel colour and shown when the renderer reports its first REAL frame
// (never on an empty first paint), or after a fallback when no frame ever comes (electron/app/windowReveal.ts),
// and the start's milestones
// are recorded as bounded, path-free durations (electron/app/startupTiming.ts).
// Method: the reveal runs against a fake window whose `ready-to-show` the test fires or withholds,
// with fake timers for the fallback; main.ts is read as text for the three window options that
// cannot run without Electron; the timing table is driven past its bound and with repeats.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const { repoPath } = require('../../helpers/sources.js');
const { REVEAL_FALLBACK_MS, createFirstFrameSignal, revealOnFirstFrame } = require('#dist/electron/app/windowReveal.js');
const { STARTUP_MARKS_MAX, describeStartup, markStartup, startupMarks } = require('#dist/electron/app/startupTiming.js');

function fakeWindow(destroyed = false) {
  let shownCount = 0;
  return {
    show: () => {
      shownCount += 1;
    },
    isDestroyed: () => destroyed,
    shownCount: () => shownCount,
  };
}

test('the window is not shown before the first real frame, and is shown once when it arrives', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const window = fakeWindow();
  const frame = createFirstFrameSignal();
  let reported = 0;
  revealOnFirstFrame(window, frame, () => {
    reported += 1;
  });
  assert.equal(window.shownCount(), 0, 'hidden until the frame');
  context.mock.timers.tick(REVEAL_FALLBACK_MS - 1);
  assert.equal(window.shownCount(), 0, 'and a page that has painted nothing real is not shown by its first paint');
  frame.fire();
  assert.equal(window.shownCount(), 1);
  context.mock.timers.tick(REVEAL_FALLBACK_MS * 2);
  assert.equal(window.shownCount(), 1, 'the fallback does not show it a second time');
  assert.equal(reported, 1);
});

test('a first frame that arrives before the reveal is armed still shows the window', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const window = fakeWindow();
  const frame = createFirstFrameSignal();
  frame.fire();
  revealOnFirstFrame(window, frame, () => undefined);
  assert.equal(window.shownCount(), 1);
});

test('a page that never reports a frame still shows the window after the fallback', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const window = fakeWindow();
  const frame = createFirstFrameSignal();
  revealOnFirstFrame(window, frame, () => undefined);
  context.mock.timers.tick(REVEAL_FALLBACK_MS - 1);
  assert.equal(window.shownCount(), 0, 'not before the fallback');
  context.mock.timers.tick(1);
  assert.equal(window.shownCount(), 1);
  frame.fire();
  assert.equal(window.shownCount(), 1, 'a late first frame does not show it again');
});

test('a window destroyed before its frame is never shown', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let destroyed = false;
  const window = { ...fakeWindow(), isDestroyed: () => destroyed };
  revealOnFirstFrame(window, createFirstFrameSignal(), () => assert.fail('no report for a destroyed window'));
  destroyed = true;
  context.mock.timers.tick(REVEAL_FALLBACK_MS);
  assert.equal(window.shownCount(), 0);
  assert.throws(() => revealOnFirstFrame(fakeWindow(true), createFirstFrameSignal(), () => undefined), /alive when its reveal is armed/);
});

test('main.ts creates the window hidden, in the panel colour, and reveals it on the renderer first real frame', () => {
  const source = readFileSync(repoPath('electron/main.ts'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.match(source, /backgroundColor: '#111111'/, 'the panel surface, --bg-panel');
  assert.match(source, /show: false/);
  assert.match(source, /revealOnFirstFrame\(mainWindow, firstFrame,/);
  assert.doesNotMatch(source, /ready-to-show/, 'an empty first paint is not a reason to show the window');
  assert.match(source, /import '\.\/lib\/compileCache';/);
  assert.ok(source.indexOf("import './lib/compileCache'") < source.indexOf("from './handlers/"), 'the compile cache starts before the handlers load');
});

test('startup milestones are recorded once each, as durations, and bounded', () => {
  markStartup('appReady');
  const first = startupMarks().find(([name]) => name === 'appReady');
  assert.ok(first !== undefined);
  markStartup('appReady');
  assert.equal(startupMarks().filter(([name]) => name === 'appReady').length, 1, 'a repeat is ignored');
  assert.equal(startupMarks().find(([name]) => name === 'appReady')?.[1], first[1], 'the first time stands');
  assert.match(describeStartup(), /^\[startup\] appReady=\d+ms/);
  assert.doesNotMatch(describeStartup(), /[/\\]/, 'no paths');
  assert.ok(startupMarks().length <= STARTUP_MARKS_MAX);
});
