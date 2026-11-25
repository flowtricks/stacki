// Goal: while the full-window busy cover shows, the window is held, so the menu's edit commands do nothing, and it is
// free again once every cover is gone; a release called twice releases once.
// Method: the real module through the renderer loader, holds taken and released by hand, read through windowHeld.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { holdWindow, windowHeld } = load('src/ui/busyLock.ts');

test('the window is held until every hold is released, and a release counts once', () => {
  assert.equal(windowHeld(), false, 'free to start with');
  const first = holdWindow();
  const second = holdWindow();
  assert.equal(windowHeld(), true);
  first();
  first();
  assert.equal(windowHeld(), true, 'a release called twice releases once; the other hold remains');
  second();
  assert.equal(windowHeld(), false, 'free again');
});
