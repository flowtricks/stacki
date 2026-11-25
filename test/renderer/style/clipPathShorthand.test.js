// Goal: the clip-path editor writes back the shorthand the user wrote, and an
// edit writes the shortest CSS that still says the same thing. A rule's
// `clip-path: inset(0.5rem round 2rem)` kept coming back as
// `inset(0.5rem 0.5rem 0.5rem 0.5rem round 2rem)`: the editor re-serialized the
// parsed shape with every side spelled out, and a radius drag added four radii
// and a `/` copy of them as well.
// Method: bundle the editor's pure layer (parse, format, drag, and the box
// shorthand helper) and run it against a stand-in canvas 160px square, so 1rem
// (16px) is 10% of either axis. The positive space: authored text survives a
// parse and format byte for byte, the 1-, 2-, 3- and 4-part box forms each come
// out of a drag, and radii collapse, keeping `/` only when the halves differ.
// The negative space: a press without movement changes nothing, and the helper
// refuses lists of no parts or of more than four.

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const EXPORTS = {
  parseClipPath: 'shapeFunctionModel',
  normalizeClipPathValue: 'svgContours',
  formatClipPath: 'clipPathFormat',
  updateShapeForDrag: 'shapeDrag',
  shortestBoxForm: 'clipPathHandles',
  expandBoxParts: 'clipPathHandles',
};

function loadFunctions() {
  const folder = repoPath('src/features/style/clipPath');
  const lines = Object.entries(EXPORTS).map(([name, module]) => `export { ${name} } from ${JSON.stringify(path.join(folder, module))};`);
  const outfile = repoPath('node_modules/.stacki-test/clip-path-shorthand.bundle.cjs');
  esbuild.buildSync({
    stdin: { contents: lines.join('\n'), resolveDir: folder, loader: 'ts' },
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  delete require.cache[outfile];
  return require(outfile);
}

const dom = new JSDOM('<!doctype html><body></body>');
for (const name of ['window', 'document', 'DOMParser', 'Element', 'Node', 'SVGElement']) {
  global[name] = name === 'window' ? dom.window : dom.window[name];
}
const clip = loadFunctions();

// The canvas a drag converts through: 160px square, so 1rem is 10%.
const CANVAS_PX = 160;
const canvas = {
  getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, right: CANVAS_PX, bottom: CANVAS_PX, width: CANVAS_PX, height: CANVAS_PX }),
};

function drag(value, handle, x, y, options = {}) {
  const shape = clip.parseClipPath(value);
  assert.equal(shape.kind, 'raw', `${value} parses as authored CSS`);
  return clip.formatClipPath(clip.updateShapeForDrag(shape, { ...handle, before: shape }, x, y, { canvas, ...options }));
}

test('authored clip-paths format back byte for byte', () => {
  for (const value of [
    'inset(0.5rem round 2rem)',
    'inset(0.5rem 0.5rem 0.5rem 0.5rem round 2rem)',
    'inset(0.5rem 1rem)',
    'inset(1rem  2rem 3rem round 2rem / 1rem)',
    'circle(4rem)',
    'ellipse(2rem 3rem at 50% 50%)',
    'polygon(0px 0px, 10rem 0px, 5rem 10rem)',
  ]) {
    assert.equal(clip.formatClipPath(clip.parseClipPath(value)), value);
    assert.equal(clip.normalizeClipPathValue(value).css, value, 'the value the editor counts as written on open');
  }
});

test('the box shorthand collapses to the fewest parts', () => {
  assert.equal(clip.shortestBoxForm(['1rem', '1rem', '1rem', '1rem']), '1rem');
  assert.equal(clip.shortestBoxForm(['1rem', '2rem', '1rem', '2rem']), '1rem 2rem');
  assert.equal(clip.shortestBoxForm(['1rem', '2rem', '3rem', '2rem']), '1rem 2rem 3rem');
  assert.equal(clip.shortestBoxForm(['1rem', '2rem', '3rem', '4rem']), '1rem 2rem 3rem 4rem');
  assert.equal(clip.shortestBoxForm(['1rem', '2rem', '1rem', '4rem']), '1rem 2rem 1rem 4rem', 'top = bottom alone is not shorter');
  assert.equal(clip.shortestBoxForm(['1rem', '2rem']), '1rem 2rem', 'a short list stays short');
  assert.equal(clip.shortestBoxForm(['0', '0px']), '0 0px', 'parts compare as written');
  assert.deepEqual(clip.expandBoxParts(['1rem', '2rem', '3rem']), ['1rem', '2rem', '3rem', '2rem']);
  assert.throws(() => clip.shortestBoxForm([]), /Assertion failed: expandBoxParts: a box list has at least one part/);
  assert.throws(() => clip.shortestBoxForm(['1', '2', '3', '4', '5']), /Assertion failed: expandBoxParts: a box list has at most four parts/);
});

test('dragging an inset side writes the shortest form that still holds', () => {
  const value = 'inset(0.5rem round 2rem)';
  // Top to 1rem: top differs from bottom, left still equals right.
  assert.equal(drag(value, { kind: 'inset-top' }, 50, 10), 'inset(1rem 0.5rem 0.5rem round 2rem)');
  // Top and bottom together: the two-part form.
  assert.equal(drag(value, { kind: 'inset-top' }, 50, 10, { insetSideMode: 'opposite' }), 'inset(1rem 0.5rem round 2rem)');
  // Every side: one part.
  assert.equal(drag(value, { kind: 'inset-top' }, 50, 10, { insetSideMode: 'all' }), 'inset(1rem round 2rem)');
  // Left alone: no shorter form exists.
  assert.equal(drag(value, { kind: 'inset-left' }, 10, 50), 'inset(0.5rem 0.5rem 0.5rem 1rem round 2rem)');
  // A long authored form collapses once it is edited.
  assert.equal(drag('inset(0.5rem 0.5rem 0.5rem 0.5rem)', { kind: 'inset-top' }, 50, 10, { insetSideMode: 'all' }), 'inset(1rem)');
});

test('dragging a corner radius writes the shortest radii', () => {
  const value = 'inset(0.5rem round 2rem)';
  // The box starts at 5% (0.5rem); 25% further is 40px, 2.5rem.
  assert.equal(drag(value, { kind: 'inset-radius', corner: 'topLeft' }, 30, 30, { insetRadiusMode: 'all' }), 'inset(0.5rem round 2.5rem)');
  assert.equal(drag(value, { kind: 'inset-radius', corner: 'topLeft' }, 30, 30), 'inset(0.5rem round 2.5rem 2rem 2rem)');
  assert.equal(drag(value, { kind: 'inset-radius', corner: 'topLeft' }, 30, 30, { insetRadiusMode: 'opposite' }), 'inset(0.5rem round 2.5rem 2rem)');
  // Unlocked, the vertical radius differs, so the `/` half is written.
  assert.equal(
    drag(value, { kind: 'inset-radius', corner: 'topLeft' }, 30, 20, { insetRadiusMode: 'all', insetRadiusUnlocked: true }),
    'inset(0.5rem round 2.5rem / 1.5rem)',
  );
});

test('pressing a handle without moving it keeps the authored text', () => {
  // The long form stays long: nothing changed, so nothing is rewritten.
  const value = 'inset(0.5rem 0.5rem 0.5rem 0.5rem round 2rem 2rem)';
  const shape = clip.parseClipPath(value);
  // The top handle sits on the top edge, 0.5rem (5%) down.
  const pressed = clip.updateShapeForDrag(shape, { kind: 'inset-top', before: shape }, 50, 5, { canvas });
  assert.equal(pressed, shape, 'the same shape comes back');
  assert.equal(clip.formatClipPath(pressed), value);
});
