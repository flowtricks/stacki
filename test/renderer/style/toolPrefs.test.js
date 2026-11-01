// Goal: the style panel's stored embed source is parsed like any other input —
// storage outlives builds and can hold anything — so only a non-empty key
// within the path bound is restored.
// Method: the pure parser runs on known-good keys and on each known-bad value
// (absent, empty, wrong type, past the bound); the load path runs against a
// stub localStorage, including one whose read throws.
const test = require('node:test');
const assert = require('node:assert/strict');
const { BOUNDARY_LIMITS } = require('#dist/shared/core/boundary.js');
const { parseStoredEmbedSource, loadEmbedSource } = require('../../helpers/rendererModule')('src/features/style/model/toolPreferences.ts');

// A boundary can receive null — JSON, structured clone and postMessage all carry it —
// so the negative space below includes it. It is read from JSON, because our own
// code never writes a null.
const PLATFORM_NULL = JSON.parse('null');

test('a stored embed source is restored only when it is a bounded key', () => {
  assert.equal(parseStoredEmbedSource('file:/p/global.css'), 'file:/p/global.css');
  const atLimit = 'k'.repeat(BOUNDARY_LIMITS.pathLengthMax);
  assert.equal(parseStoredEmbedSource(atLimit), atLimit);
  for (const raw of [PLATFORM_NULL, undefined, '', 42, {}, 'k'.repeat(BOUNDARY_LIMITS.pathLengthMax + 1)]) {
    assert.equal(parseStoredEmbedSource(raw), undefined);
  }
});

test('loading falls back to no preference when storage is corrupt or unreadable', (context) => {
  const previous = globalThis.localStorage;
  context.after(() => {
    globalThis.localStorage = previous;
  });
  globalThis.localStorage = { getItem: () => 'x'.repeat(BOUNDARY_LIMITS.pathLengthMax + 1) };
  assert.equal(loadEmbedSource(), undefined);
  globalThis.localStorage = {
    getItem: () => {
      throw new Error('denied');
    },
  };
  assert.equal(loadEmbedSource(), undefined);
  globalThis.localStorage = { getItem: () => 'embed:node-7' };
  assert.equal(loadEmbedSource(), 'embed:node-7');
});
