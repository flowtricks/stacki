// Goal: an app's own capture cursor (`canvas.capture`'s `cursor.image`) is read
// from its bundle, checked, and drawn only when it is a small image.
// - Params: a named cursor or `{ image, hotspot? }`; the image is a bundle-relative
//   .png or .svg that cannot climb out; the hotspot is a whole pixel in 0–31.
// - Checks: a PNG by its signature and header size, an SVG by its root's pixel
//   width and height; past 32 pixels a side, past the byte bound, or unreadable,
//   the capture is refused with a reason.
// - The frame: draws only a base64 PNG or SVG data URL with a valid hotspot, with
//   the crosshair as fallback, and leaves the cursor as it was for anything else.
// - The dispatcher: an image cursor reaches the capture as a data URL; a bad one
//   answers `applied: false` and leaves the capture untouched.
// Method: the pure modules bundled with esbuild, a fake bundle reader and a
// minimal fake document for the frame's style element.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');

const rpc = load('shared/properties/appsRpc.ts');
const { resolveCanvasCursor, checkPNG, checkSVG } = load('src/features/apps/appCursorImage.ts');

const capture = (cursor) => rpc.APP_METHODS['canvas.capture'].params({ on: true, cursor });
const svg = (width, height) =>
  new TextEncoder().encode(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"></svg>`);
function png(width, height) {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

test('the capture params take named cursors and bounded bundle images', () => {
  assert.equal(rpc.APP_METHODS['canvas.capture'].params({ on: true }).cursor, 'crosshair');
  assert.equal(capture('default').cursor, 'default');
  assert.deepEqual(capture({ image: 'pin.svg' }).cursor, { image: 'pin.svg', hotspot: { x: 0, y: 0 } });
  assert.deepEqual(capture({ image: 'img/pin.png', hotspot: { x: 31, y: 4 } }).cursor, { image: 'img/pin.png', hotspot: { x: 31, y: 4 } });
  for (const image of ['../pin.svg', '/pin.svg', 'pin.gif', 'https://x.test/pin.png', 'pin', `${'a'.repeat(200)}.svg`]) {
    assert.throws(() => capture({ image }), /cursor.image/, image);
  }
  assert.throws(() => capture({ image: 'pin.svg', hotspot: { x: 32, y: 0 } }), /cursor.hotspot.x must be 0 to 31/);
  assert.throws(() => capture({ image: 'pin.svg', hotspot: { x: 0, y: -1 } }), /cursor.hotspot.y/);
  assert.throws(() => capture('pointer'), /cursor must be one of/);
});

test('an image is a PNG or SVG of at most 32 pixels a side', () => {
  assert.deepEqual(checkPNG(png(32, 24)), { ok: true, type: 'image/png' });
  assert.equal(checkPNG(png(33, 24)).ok, false);
  assert.equal(checkPNG(png(0, 24)).ok, false);
  assert.match(checkPNG(svg(16, 16)).reason, /not a PNG/);
  assert.deepEqual(checkSVG(svg(24, '24px')), { ok: true, type: 'image/svg+xml' });
  assert.match(checkSVG(svg(64, 64)).reason, /1 to 32 pixels a side; this one is 64×64/);
  assert.match(checkSVG(new TextEncoder().encode('<svg viewBox="0 0 24 24"></svg>')).reason, /sets width and height/);
  assert.match(checkSVG(new TextEncoder().encode('<html></html>')).reason, /no <svg>/);
  assert.match(checkSVG(new Uint8Array([0xff, 0xfe, 0xfd])).reason, /UTF-8/);
});

test('a cursor resolves to a data URL, or a reason', async () => {
  const files = new Map([
    ['pin.svg', svg(20, 20)],
    ['big.svg', svg(40, 40)],
  ]);
  const asked = [];
  const read = async (appId, path, bytesMax) => {
    asked.push([appId, path, bytesMax]);
    return files.get(path);
  };
  assert.deepEqual(await resolveCanvasCursor('pins', 'crosshair', read), { ok: true, cursor: 'crosshair' });
  assert.deepEqual(asked, [], 'a named cursor reads nothing');
  const resolved = await resolveCanvasCursor('pins', { image: 'pin.svg', hotspot: { x: 10, y: 19 } }, read);
  assert.equal(resolved.ok, true);
  assert.match(resolved.cursor.url, /^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+=*$/);
  assert.deepEqual(resolved.cursor.hotspot, { x: 10, y: 19 });
  assert.deepEqual(asked[0], ['pins', 'pin.svg', rpc.APP_RPC_LIMITS.cursorImageBytesMax]);
  assert.equal((await resolveCanvasCursor('pins', { image: 'big.svg', hotspot: { x: 0, y: 0 } }, read)).ok, false);
  assert.match((await resolveCanvasCursor('pins', { image: 'gone.png', hotspot: { x: 0, y: 0 } }, read)).reason, /at most 4096 bytes/);
});

test('the frame draws a checked image cursor with the crosshair behind it, and nothing else', () => {
  const { receiveAppCursor } = load('electron/preload/frameAppCursor.ts');
  let style;
  globalThis.document = {
    getElementById: () => ({ remove: () => (style = undefined) }),
    createElement: () => ({}),
    head: { appendChild: (element) => (style = element) },
    documentElement: {},
  };
  try {
    const url = 'data:image/png;base64,iVBORw0KGgo=';
    assert.equal(receiveAppCursor({ type: 'avb:app-cursor', cursor: { url, hotspot: { x: 3, y: 4 } } }), true);
    assert.equal(style.textContent, `html, html * { cursor: url("${url}") 3 4, crosshair !important; }`);
    for (const cursor of [
      { url: 'https://x.test/a.png', hotspot: { x: 0, y: 0 } },
      { url: 'data:image/png;base64,abc")}body{x', hotspot: { x: 0, y: 0 } },
      { url, hotspot: { x: 32, y: 0 } },
      { url },
      'pointer',
    ]) {
      style = { textContent: 'kept' };
      assert.equal(receiveAppCursor({ type: 'avb:app-cursor', cursor }), true);
      assert.equal(style.textContent, 'kept', JSON.stringify(cursor));
    }
    assert.equal(receiveAppCursor({ type: 'avb:app-cursor', cursor: 'none' }), true);
    assert.equal(style, undefined, 'none puts the editor’s cursor back');
    assert.equal(receiveAppCursor({ type: 'other' }), false);
  } finally {
    delete globalThis.document;
  }
});

test('the dispatcher resolves an image cursor before capturing, and refuses a bad one', async () => {
  const { createCanvasCapture } = load('src/features/apps/canvasCapture.ts');
  const { resolveCanvasCursor: resolve } = load('src/features/apps/appCursorImage.ts');
  const owner = createCanvasCapture({ emit: () => 1, running: () => true });
  const read = async (appId, path) => (path === 'pin.svg' ? svg(16, 16) : undefined);
  const good = await resolve('pins', capture({ image: 'pin.svg' }).cursor, read);
  assert.deepEqual(owner.set({ id: 'pins', name: 'Pins' }, true, { cursor: good.cursor, mode: 'capture', reason: undefined }), { applied: true });
  assert.match(owner.owner().cursor.url, /^data:image\/svg\+xml;base64,/);
  const bad = await resolve('pins', capture({ image: 'missing.png' }).cursor, read);
  assert.equal(bad.ok, false);
});
