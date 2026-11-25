// Goal: an app can observe canvas clicks without taking them (docs/apps.md, "Observing
// clicks"): with `canvas.capture({ on: true, mode: 'observe' })` the editor handles every
// click as usual, and the app hears each single click once the double-click window has
// passed; a double click (which enters a component at once) reaches the app as nothing.
// The capture mode is unchanged: it still takes clicks and Escape.
// Method: the click slot and the capture store with a fake handler, on Node's mock clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');

const slot = load('src/ui/canvasClickSlot.ts');
const { captureChipText, createCanvasCapture } = load('src/features/apps/canvasCapture.ts');
const { ENGLISH_TRANSLATE } = load('shared/properties/i18n/englishTranslator.ts');
const rpc = load('shared/properties/appsRpc.ts');

const click = (path) => ({ path, occurrence: 0, x: 10, y: 20, box: undefined });

function install(mode) {
  const taken = [];
  slot.setCanvasClickHandler({ capturing: () => mode === 'capture', observing: () => mode === 'observe', take: (report) => taken.push(report.path) });
  return taken;
}

test('an observed single click reaches the app after the double-click window; the editor still has it', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const taken = install('observe');
  assert.equal(slot.canvasClicksCaptured(), false, 'the editor selects: nothing is captured');
  assert.equal(slot.takeCanvasClick(click('0.1')), false);
  assert.equal(slot.observeCanvasClick(click('0.1')), true);
  context.mock.timers.tick(slot.OBSERVE_DOUBLE_CLICK_MS - 1);
  assert.deepEqual(taken, [], 'not before the window passes');
  context.mock.timers.tick(1);
  assert.deepEqual(taken, ['0.1']);
  slot.setCanvasClickHandler(undefined);
});

test('a double click reaches the observing app as nothing; a later click as one', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const taken = install('observe');
  slot.observeCanvasClick(click('0.1'));
  slot.observeCanvasClick(click('0.1'));
  slot.noteCanvasOpen(); // The frame's open: the editor enters the component at once.
  context.mock.timers.tick(slot.OBSERVE_DOUBLE_CLICK_MS * 2);
  assert.deepEqual(taken, []);
  slot.observeCanvasClick(click('src/components/Nav.astro|0.2'));
  context.mock.timers.tick(slot.OBSERVE_DOUBLE_CLICK_MS);
  assert.deepEqual(taken, ['src/components/Nav.astro|0.2'], 'inside the component now open');
  slot.setCanvasClickHandler(undefined);
});

test('capture mode is unchanged, and observing is only for an app that asks', () => {
  const taken = install('capture');
  assert.equal(slot.canvasClicksCaptured(), true);
  assert.equal(slot.observeCanvasClick(click('0.1')), false, 'a capture is not an observer');
  assert.equal(slot.takeCanvasClick(click('0.1')), true);
  assert.deepEqual(taken, ['0.1']);
  slot.setCanvasClickHandler(undefined);
  assert.equal(slot.observeCanvasClick(click('0.1')), false, 'no app: nothing observes');
  // The store keeps the mode; the params default to capture and bound the mode.
  const sent = [];
  const capture = createCanvasCapture({ emit: (appId, event, data) => sent.push([appId, event, data]), running: () => true });
  capture.set({ id: 'pins', name: 'Pins' }, true, { cursor: 'crosshair', mode: 'observe', reason: undefined });
  assert.equal(capture.owner().mode, 'observe');
  assert.equal(capture.cancel(), true, 'Escape still ends it when the editor asks');
  assert.equal(rpc.APP_METHODS['canvas.capture'].params({ on: true }).mode, 'capture');
  assert.equal(rpc.APP_METHODS['canvas.capture'].params({ on: true, mode: 'observe' }).mode, 'observe');
  assert.throws(() => rpc.APP_METHODS['canvas.capture'].params({ on: true, mode: 'watch' }), /mode/);
});

test("the chip says the app's reason, or the mode's own neutral words", () => {
  const chip = (mode, reason) => captureChipText({ appName: 'Analytics', mode, reason }, ENGLISH_TRANSLATE);
  assert.equal(chip('observe', 'Click an element to see its stats'), 'Analytics: Click an element to see its stats');
  assert.equal(chip('observe', undefined), 'Analytics is listening for clicks', 'observing offers no Escape');
  assert.equal(chip('capture', 'Click to pin a comment'), 'Analytics: Click to pin a comment · Esc to cancel');
  assert.equal(chip('capture', undefined), 'Analytics: Click to place · Esc to cancel', 'a capture reads as before');
  const params = rpc.APP_METHODS['canvas.capture'].params;
  assert.equal(params({ on: true, reason: '  Click an element  ' }).reason, 'Click an element');
  assert.equal(params({ on: true }).reason, undefined);
  assert.throws(() => params({ on: true, reason: 'x'.repeat(rpc.APP_RPC_LIMITS.captureReasonCharsMax + 1) }), /reason/);
  assert.throws(() => params({ on: true, reason: '   ' }), /reason/);
  assert.throws(() => params({ on: true, reason: 'two\nlines' }), /reason/);
  assert.throws(() => params({ on: true, reason: 42 }), /./);
  // The owner keeps the reason for the chip.
  const capture = createCanvasCapture({ emit: () => 1, running: () => true });
  capture.set({ id: 'stats', name: 'Analytics' }, true, { cursor: 'default', mode: 'observe', reason: 'Click an element to see its stats' });
  assert.equal(capture.owner().reason, 'Click an element to see its stats');
});
