// Goal: the clip-path editor reads, writes, previews and edits shapes exactly
// as it did before it was split into modules. The editor had no tests; this
// pins its pure layer to recorded behaviour so the split is checked, not
// trusted.
// Method: the inputs live in test/helpers/clipPathCases.js — CSS values of every
// shape kind (valid, raw and broken), SVG documents in both fit modes, and for
// each parsed shape its formatting, preview, code highlights, token ranges,
// preset, every handle dragged to four points in three modes, and every handle
// stepped by five keys in three modes. The expected outputs in
// test/fixtures/clipPath/characterization.json were recorded from ClipPath.tsx
// while it was still one file. The functions are bundled from the modules they
// now live in and run in jsdom (SVG import parses with DOMParser); every recorded
// value must come back equal. One deliberate change since: the preview draws
// absolute lengths at their real size (a px is a screen pixel, a rem 16px), so
// the eight recorded `preview` values with px or rem lengths were re-recorded.
// A second: a raw clip-path (one with px, rem or bare-zero lengths) now writes
// back the text it was read from, not its parse spelled out to four sides, so
// the two raw inset cases were re-recorded — their formatted, normalized,
// reparsed and unsized preview CSS, and the code highlights and token ranges
// of that shorter text. A third: an SVG with nothing drawn in it is no
// shape, so the two empty-SVG cases were re-recorded as undefined; they used to
// fall through to the default shape, as if pasting `<svg></svg>` drew it.
// Nothing else changed.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const { runCases, FUNCTION_NAMES } = require('../../helpers/clipPathCases.js');

const MODULES = {
  parseClipPath: 'shapeFunctionModel',
  parseClipPathInput: 'shapeFunctionModel',
  convertShapeFitMode: 'shapeFunctionModel',
  normalizeClipPathValue: 'svgContours',
  parseSvgClipPathShape: 'svgContours',
  formatClipPath: 'clipPathFormat',
  formatClipPathForPreview: 'clipPathPreview',
  buildClipPathCodeHighlights: 'clipPathPreview',
  clipPathValueTokenRanges: 'clipPathPreview',
  matchPreset: 'clipPathShortcuts',
  updateShapeForDrag: 'shapeDrag',
  updateShapeForKeyboard: 'shapeKeyboard',
};

function loadFunctions() {
  assert.deepEqual(Object.keys(MODULES).sort(), [...FUNCTION_NAMES].sort());
  const folder = repoPath('src/features/style/clipPath');
  const lines = Object.entries(MODULES).map(([name, module]) => `export { ${name} } from ${JSON.stringify(path.join(folder, module))};`);
  const outfile = repoPath('node_modules/.stacki-test/clip-path-model.bundle.cjs');
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

// The first place two recorded values differ, as a path into them. A walk over
// a work list rather than recursion: the recorded values are a few levels deep,
// and the bound fails loudly if that ever stops being true.
const DIFFERENCE_STEPS_MAX = 1_000_000;
function firstDifference(expected, actual) {
  const pending = [{ expected, actual, at: '' }];
  for (let steps = 0; pending.length > 0; steps += 1) {
    assert.ok(steps < DIFFERENCE_STEPS_MAX, 'the comparison walks a bounded value');
    const next = pending.pop();
    if (JSON.stringify(next.expected) === JSON.stringify(next.actual)) {
      continue;
    }
    const plain = typeof next.expected !== 'object' || next.expected === null;
    if (plain || typeof next.actual !== 'object' || next.actual === null) {
      const shown = (value) => JSON.stringify(value);
      return `${next.at}: expected ${shown(next.expected)}, got ${shown(next.actual)}`;
    }
    for (const key of new Set([...Object.keys(next.expected), ...Object.keys(next.actual)])) {
      pending.push({
        expected: next.expected[key],
        actual: next.actual[key],
        at: `${next.at}/${key}`,
      });
    }
  }
  return undefined;
}

test('the split editor reproduces every recorded clip-path behaviour', () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  for (const name of ['window', 'document', 'DOMParser', 'Element', 'Node', 'SVGElement']) {
    global[name] = name === 'window' ? dom.window : dom.window[name];
  }
  const expected = JSON.parse(fs.readFileSync(repoPath('test/fixtures/clipPath/characterization.json'), 'utf8'));
  const actual = runCases(loadFunctions());
  for (const section of ['css', 'svg', 'fit']) {
    assert.ok(Object.keys(expected[section]).length > 0, `${section} has recorded cases`);
    for (const key of Object.keys(expected[section])) {
      const difference = firstDifference(expected[section][key], actual[section][key]);
      assert.equal(difference, undefined, `${section} ${JSON.stringify(key)}${difference}`);
    }
  }
});
