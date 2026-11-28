// Goal: a canvas frame whose process died, or that holds a dead server's empty page, is told apart from a live one
// (src/features/preview/previewFrames.ts asks; electron/preload/frameAlive.ts answers). Chromium raises no event
// for a dead frame, so silence is the only sign.
//
// Method: both halves are bundled and run against fake windows in Node, so the messages are the real ones. A live
// frame answers its parent only; a frame whose window is dead says nothing; a page not served over http (Chromium's
// error document) says nothing. The one wait is the module's own timer, replaced by a fake that fires on demand.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const loadRenderer = require('../../helpers/rendererModule.js');

function listeners() {
  const all = new Set();
  return {
    addEventListener: (_type, listener) => all.add(listener),
    removeEventListener: (_type, listener) => all.delete(listener),
    emit: (event) => [...all].forEach((listener) => listener(event)),
    size: () => all.size,
  };
}

test('a live frame answers, a dead one and an error document stay silent, and nothing is left listening', async () => {
  const parent = listeners();
  const timers = [];
  global.window = { ...parent, setTimeout: (callback) => timers.push(callback), clearTimeout: () => {} };
  const { registerPreviewFrame, askPreviewFrames } = loadRenderer('src/features/preview/previewFrames.ts');
  const { answerAliveChecks } = loadRenderer('electron/preload/frameAlive.ts');

  // A frame: its own window, with the preload's half installed over it.
  const frame = (protocol) => {
    const own = listeners();
    const top = { postMessage: (data) => parent.emit({ source: handle, data }) };
    const handle = { postMessage: (data) => own.emit({ source: top, data }) };
    const before = global.window;
    global.window = { ...own, parent: top };
    answerAliveChecks();
    global.window = before;
    return {
      element: () => ({ contentWindow: handle }),
      run: (work) => {
        const saved = [global.window, global.location];
        global.window = { ...own, parent: top };
        global.location = { protocol };
        try {
          return work();
        } finally {
          [global.window, global.location] = saved;
        }
      },
      handle,
      own,
    };
  };
  // The answering half reads `window.parent` and `location` as it is asked, so each question is delivered inside.
  const wired = (made) => {
    const post = made.handle.postMessage;
    made.handle.postMessage = (data) => {
      const asking = global.window;
      made.run(() => {
        // A reply arrives later, as a message does: in the app's window again, not the frame's.
        global.window.parent.postMessage = (reply) => queueMicrotask(() => asking.emit({ source: made.handle, data: reply }));
        post(data);
      });
    };
    return made;
  };

  assert.equal(await askPreviewFrames(), 'none', 'no frame has a page');

  const live = wired(frame('http:'));
  const leave = registerPreviewFrame('live', live.element);
  assert.equal(await askPreviewFrames(), 'answered');

  const dead = { contentWindow: { postMessage: () => {} } };
  const leaveDead = registerPreviewFrame('dead', () => dead);
  const asked = askPreviewFrames();
  await Promise.resolve();
  timers.splice(0).forEach((fire) => fire());
  assert.equal(await asked, 'silent');
  leaveDead();

  const errorPage = wired(frame('chrome-error:'));
  leave();
  registerPreviewFrame('error', errorPage.element);
  const blank = askPreviewFrames();
  await Promise.resolve();
  timers.splice(0).forEach((fire) => fire());
  assert.equal(await blank, 'silent');
  assert.equal(parent.size(), 0, 'every question takes its listener down');
  delete global.window;
});
