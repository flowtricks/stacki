// Goal: the main window starts without an empty-looking frame and says how long its start took.
// It is created hidden with the app's panel colour and shown on its first painted frame, or after
// a fallback when no frame ever comes (electron/app/windowReveal.ts), and the start's milestones
// are recorded as bounded, path-free durations (electron/app/startupTiming.ts).
// Method: the reveal runs against a fake window whose `ready-to-show` the test fires or withholds,
// with fake timers for the fallback; main.ts is read as text for the three window options that
// cannot run without Electron; the timing table is driven past its bound and with repeats.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const { repoPath } = require('../../helpers/sources.js');
const { REVEAL_FALLBACK_MS, revealWhenPainted } = require('#dist/electron/app/windowReveal.js');
const { STARTUP_MARKS_MAX, describeStartup, markStartup, startupMarks } = require('#dist/electron/app/startupTiming.js');

function fakeWindow(destroyed = false) {
  const listeners = [];
  let shownCount = 0;
  return {
    once: (_event, listener) => {
      listeners.push(listener);
    },
    show: () => {
      shownCount += 1;
    },
    isDestroyed: () => destroyed,
    fire: () => listeners.forEach((listener) => listener()),
    shownCount: () => shownCount,
  };
}

test('the window is shown on its first painted frame, once', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const window = fakeWindow();
  let reported = 0;
  revealWhenPainted(window, () => {
    reported += 1;
  });
  assert.equal(window.shownCount(), 0, 'hidden until the frame');
  window.fire();
  assert.equal(window.shownCount(), 1);
  context.mock.timers.tick(REVEAL_FALLBACK_MS * 2);
  assert.equal(window.shownCount(), 1, 'the fallback does not show it a second time');
  assert.equal(reported, 1);
});

test('a page that never paints still shows the window after the fallback', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const window = fakeWindow();
  revealWhenPainted(window, () => undefined);
  context.mock.timers.tick(REVEAL_FALLBACK_MS - 1);
  assert.equal(window.shownCount(), 0, 'not before the fallback');
  context.mock.timers.tick(1);
  assert.equal(window.shownCount(), 1);
  window.fire();
  assert.equal(window.shownCount(), 1, 'a late first frame does not show it again');
});

test('a window destroyed before it paints is never shown', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let destroyed = false;
  const window = { ...fakeWindow(), isDestroyed: () => destroyed };
  revealWhenPainted(window, () => assert.fail('no report for a destroyed window'));
  destroyed = true;
  context.mock.timers.tick(REVEAL_FALLBACK_MS);
  assert.equal(window.shownCount(), 0);
  assert.throws(() => revealWhenPainted(fakeWindow(true), () => undefined), /alive when its reveal is armed/);
});

test('main.ts creates the window hidden, in the panel colour, and reveals it on its first frame', () => {
  const source = readFileSync(repoPath('electron/main.ts'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.match(source, /backgroundColor: '#111111'/, 'the panel surface, --bg-panel');
  assert.match(source, /show: false/);
  assert.match(source, /revealWhenPainted\(mainWindow,/);
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
