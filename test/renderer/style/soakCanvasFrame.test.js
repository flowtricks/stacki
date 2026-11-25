// Goal: the soak driver presses the canvas, never a palette picture. Release 1.4.6's own tests
// failed on Windows and macOS (selectionPureRead: "Cannot read properties of null (reading 'x')")
// because the driver took the first dev-server frame as the canvas, and the palette's snapshot
// frames (`/__avb/preview?...&layout=snapshot`) come from the same server.
// Methodology: pickCanvasFrame is pure, so it runs on frame lists shaped like Electron's
// `webContents.mainFrame.frames` (only `url` is read): snapshot frames first, the canvas later,
// a previous page's canvas kept beside the current one, and lists with no canvas at all.
const test = require('node:test');
const assert = require('node:assert/strict');
const { pickCanvasFrame } = require('../../helpers/e2e/soakDriver.js');

const SERVER = 'http://127.0.0.1:51010';
const snapshot = (component) => ({ url: `${SERVER}/__avb/preview?c=${component}&p=src%2Fcomponents%2F${component}.astro&layout=snapshot` });
const canvas = (route) => ({ url: `${SERVER}${route}#avb-design` });

test('the canvas is found when palette snapshot frames come first', () => {
  const page = canvas('/');
  const frames = [snapshot('Button'), snapshot('SoakCard'), page, snapshot('SoakClassed')];
  assert.equal(pickCanvasFrame(frames, page.url), page);
  assert.equal(pickCanvasFrame(frames, undefined), page, 'the only canvas frame, even without the shown src');
});

test('with a previous page kept, the shown canvas wins', () => {
  const previous = canvas('/about');
  const current = canvas('/');
  assert.equal(pickCanvasFrame([previous, snapshot('Button'), current], current.url), current);
  assert.equal(pickCanvasFrame([current, previous], previous.url), previous);
});

test('no canvas, or two with none shown, is undefined: the caller waits instead of guessing', () => {
  assert.equal(pickCanvasFrame([snapshot('Button'), snapshot('SoakCard')], undefined), undefined);
  assert.equal(pickCanvasFrame([], undefined), undefined);
  assert.equal(pickCanvasFrame([canvas('/a'), canvas('/b')], undefined), undefined);
  assert.equal(pickCanvasFrame([canvas('/a'), canvas('/b')], `${SERVER}/c#avb-design`), undefined);
  assert.equal(pickCanvasFrame([{ url: undefined }, snapshot('Button')], undefined), undefined);
});

test('a frame list that is not a list is a programmer error', () => {
  assert.throws(() => pickCanvasFrame(undefined, undefined), /pickCanvasFrame: frames is a list/);
});
