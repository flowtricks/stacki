// Goal: a touch on a drag control inside a scrolling panel belongs to the control only once
// the gesture is clear: a horizontal drag (on a control that drags horizontally) or a press
// held still. A vertical swipe belongs to the panel's scroll. A mouse or pen press is the
// control's at once, so desktop keeps its immediate drags. While a control holds a touch,
// the page must not pan under it.
// Method: the pure `touchClaimStep` over travel inside and outside the slop, on both axes and
// diagonals, for both claim axes. Then `startTouchClaim` with Node's mocked timers: a mouse
// press, a tap, a vertical swipe, a horizontal drag, a press held past the hold time, and a
// press that moves before the hold time (which must stop the timer). Last, the touchmove guard
// on a jsdom document: cancelled while a touch is claimed, left alone otherwise, and installed
// once per document.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test/touch-claim');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'touchClaim.cjs');
buildSync({
  stdin: { contents: "export * from './src/ui/touchClaim';", resolveDir: ROOT, loader: 'ts' },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
  external: ['react'],
});
const claim = require(output);
const { TOUCH_CLAIM } = claim;

const touch = (clientX, clientY) => ({ pointerType: 'touch', clientX, clientY });

test('travel inside the slop decides nothing', () => {
  for (const axis of ['x', 'hold']) {
    assert.equal(claim.touchClaimStep({ dxPx: 0, dyPx: 0, axis }), 'pending');
    assert.equal(claim.touchClaimStep({ dxPx: TOUCH_CLAIM.slopPx - 1, dyPx: -(TOUCH_CLAIM.slopPx - 1), axis }), 'pending');
  }
});

test('a horizontal drag claims a horizontal control, a vertical one releases it', () => {
  assert.equal(claim.touchClaimStep({ dxPx: TOUCH_CLAIM.slopPx, dyPx: 0, axis: 'x' }), 'claimed');
  assert.equal(claim.touchClaimStep({ dxPx: -20, dyPx: 6, axis: 'x' }), 'claimed');
  assert.equal(claim.touchClaimStep({ dxPx: 0, dyPx: -TOUCH_CLAIM.slopPx, axis: 'x' }), 'released');
  assert.equal(claim.touchClaimStep({ dxPx: 5, dyPx: -40, axis: 'x' }), 'released');
  // A perfect diagonal is not clearly horizontal: the scroll keeps it.
  assert.equal(claim.touchClaimStep({ dxPx: 12, dyPx: 12, axis: 'x' }), 'released');
});

test('a control that drags vertically is claimed only by holding', () => {
  assert.equal(claim.touchClaimStep({ dxPx: 30, dyPx: 0, axis: 'hold' }), 'released');
  assert.equal(claim.touchClaimStep({ dxPx: 0, dyPx: 30, axis: 'hold' }), 'released');
});

test('travel that is not a number is a programmer error', () => {
  assert.throws(() => claim.touchClaimStep({ dxPx: Number.NaN, dyPx: 0, axis: 'x' }), /touchClaimStep: dx is finite/);
  assert.throws(() => claim.touchClaimStep({ dxPx: 0, dyPx: Number.POSITIVE_INFINITY, axis: 'x' }), /touchClaimStep: dy is finite/);
});

test('a mouse or pen press is claimed at once and never released', () => {
  for (const pointerType of ['mouse', 'pen']) {
    const press = claim.startTouchClaim({ pointerType, clientX: 0, clientY: 0 }, { axis: 'hold' });
    assert.equal(press.state(), 'claimed');
    assert.equal(press.move({ clientX: 0, clientY: 200 }), 'claimed');
    press.end();
    assert.equal(claim.touchClaimHeld(), false, 'a mouse press never holds the page');
  }
});

test('touch presses: tap, swipe, drag and hold', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let holds = 0;
  const onHold = () => {
    holds += 1;
  };

  const tap = claim.startTouchClaim(touch(100, 100), { axis: 'x' }, onHold);
  assert.equal(tap.move({ clientX: 102, clientY: 101 }), 'pending');
  tap.end();
  context.mock.timers.tick(TOUCH_CLAIM.holdMs * 2);
  assert.equal(tap.state(), 'pending', 'an ended press is not claimed by its timer');
  assert.equal(holds, 0);

  const swipe = claim.startTouchClaim(touch(100, 100), { axis: 'x' }, onHold);
  assert.equal(swipe.move({ clientX: 103, clientY: 80 }), 'released');
  assert.equal(swipe.move({ clientX: 160, clientY: 80 }), 'released', 'a released touch stays released');
  context.mock.timers.tick(TOUCH_CLAIM.holdMs * 2);
  assert.equal(swipe.state(), 'released');
  assert.equal(claim.touchClaimHeld(), false);
  swipe.end();

  const drag = claim.startTouchClaim(touch(100, 100), { axis: 'x' }, onHold);
  assert.equal(drag.move({ clientX: 120, clientY: 104 }), 'claimed');
  assert.equal(claim.touchClaimHeld(), true);
  assert.equal(drag.move({ clientX: 120, clientY: 300 }), 'claimed', 'a claimed touch keeps vertical moves');
  drag.end();
  drag.end();
  assert.equal(claim.touchClaimHeld(), false, 'ending twice releases the page once');
  assert.equal(holds, 0);

  const hold = claim.startTouchClaim(touch(100, 100), { axis: 'hold' }, onHold);
  context.mock.timers.tick(TOUCH_CLAIM.holdMs - 1);
  assert.equal(hold.state(), 'pending');
  context.mock.timers.tick(1);
  assert.equal(hold.state(), 'claimed');
  assert.equal(holds, 1);
  assert.equal(hold.move({ clientX: 100, clientY: 20 }), 'claimed');
  assert.equal(claim.touchClaimHeld(), true);
  hold.end();
  assert.equal(claim.touchClaimHeld(), false);
});

test('the touchmove guard cancels a pan only while a control holds a touch', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { window } = new JSDOM('<!doctype html><p>panel</p>');
  const added = [];
  const addEventListener = window.document.addEventListener.bind(window.document);
  window.document.addEventListener = (type, listener, options) => {
    added.push({ type, options });
    addEventListener(type, listener, options);
  };
  claim.installTouchClaimGuard(window.document);
  claim.installTouchClaimGuard(window.document);
  assert.deepEqual(added, [{ type: 'touchmove', options: { passive: false, capture: true } }]);

  const move = () => {
    const event = new window.Event('touchmove', { bubbles: true, cancelable: true });
    window.document.querySelector('p').dispatchEvent(event);
    return event.defaultPrevented;
  };
  assert.equal(move(), false, 'no control holds a touch: the page pans');
  const press = claim.startTouchClaim(touch(0, 0), { axis: 'x' });
  assert.equal(move(), false, 'a pending touch may still become a scroll');
  press.move({ clientX: 40, clientY: 0 });
  assert.equal(move(), true, 'a claimed touch must not pan the page');
  press.end();
  assert.equal(move(), false);
});
