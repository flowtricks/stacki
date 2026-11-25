// Goal: the canvas frame's half of `canvas.scrollTo` and the IPC bound of
// `canvas.snapshot` hold their contracts.
// - Scrolling: a page point lands at the top (`start`) or the middle (`center`);
//   a box measured in the viewport is offset by how far the page has scrolled;
//   a malformed message is the frame's but moves nothing.
// - Snapshot payload: a window region of whole, nonnegative pixels within the
//   window bound, at least a pixel each way, and a width bound of 1 to 800.
// Method: the pure helpers bundled with esbuild, and the frame's receiver over
// a fake window that records where it was asked to scroll.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');

const { receiveAppScroll, scrollTarget } = load('electron/preload/frameAppScroll.ts');
const payloads = load('shared/ipc/ipcPayloads.ts');

test('a point or a measured box lands at the start or the centre', () => {
  const viewport = { width: 1000, height: 800 };
  const page = (block) => ({ space: 'page', x: 0, y: 2000, w: 0, h: 0, block });
  assert.deepEqual(scrollTarget(page('start'), { x: 0, y: 500 }, viewport), { left: 0, top: 2000 });
  assert.deepEqual(scrollTarget(page('center'), { x: 0, y: 500 }, viewport), { left: -500, top: 1600 });
  const box = (block) => ({ space: 'viewport', x: 100, y: 300, w: 200, h: 100, block });
  assert.deepEqual(scrollTarget(box('start'), { x: 0, y: 500 }, viewport), { left: 100, top: 800 });
  assert.deepEqual(scrollTarget(box('center'), { x: 0, y: 500 }, viewport), { left: -300, top: 450 });
});

test('the frame scrolls for a well-formed message only', () => {
  const scrolled = [];
  globalThis.window = { scrollX: 0, scrollY: 100, innerWidth: 1000, innerHeight: 800, scrollTo: (options) => scrolled.push(options) };
  try {
    assert.equal(receiveAppScroll({ type: 'avb:app-scroll', space: 'page', x: 0, y: 900, w: 0, h: 0, block: 'start' }), true);
    assert.deepEqual(scrolled, [{ left: 0, top: 900, behavior: 'instant' }]);
    for (const bad of [
      { space: 'document', x: 0, y: 0, w: 0, h: 0, block: 'start' },
      { space: 'page', x: 0, y: 0, w: 0, h: 0, block: 'end' },
      { space: 'page', x: 0, y: 2e6, w: 0, h: 0, block: 'start' },
      { space: 'viewport', x: 0, y: 0, w: -1, h: 0, block: 'start' },
      { space: 'page', x: '0', y: 0, w: 0, h: 0, block: 'start' },
    ]) {
      assert.equal(receiveAppScroll({ type: 'avb:app-scroll', ...bad }), true);
    }
    assert.equal(scrolled.length, 1, 'malformed messages move nothing');
    assert.equal(receiveAppScroll({ type: 'avb:query' }), false);
  } finally {
    delete globalThis.window;
  }
});

test('a snapshot request is a bounded region of the window', () => {
  const parse = (input) => payloads.parseIpcPayload('apps:canvasSnapshot', input);
  assert.deepEqual(parse({ rect: { x: 10, y: 20, width: 300, height: 200 }, widthMax: 320 }), {
    rect: { x: 10, y: 20, width: 300, height: 200 },
    widthMax: 320,
  });
  for (const bad of [
    { rect: { x: -1, y: 0, width: 10, height: 10 }, widthMax: 10 },
    { rect: { x: 0, y: 0, width: 0, height: 10 }, widthMax: 10 },
    { rect: { x: 16_000, y: 0, width: 1000, height: 10 }, widthMax: 10 },
    { rect: { x: 0, y: 0, width: 1.5, height: 10 }, widthMax: 10 },
    { rect: { x: 0, y: 0, width: 10, height: 10 }, widthMax: 801 },
    { rect: { x: 0, y: 0, width: 10, height: 10 }, widthMax: 0 },
    { widthMax: 10 },
  ]) {
    assert.throws(() => parse(bad), undefined, JSON.stringify(bad));
  }
});
