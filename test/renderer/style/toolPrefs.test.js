// Goal: the style panel's stored preferences are parsed like any other input —
// storage outlives builds and can hold anything — so only a non-empty embed key
// within the path bound is restored, and the selector Hide toggles fall back to
// off for anything malformed.
// Method: the pure parser runs on known-good keys and on each known-bad value
// (absent, empty, wrong type, past the bound); the load path runs against a
// stub localStorage, including one whose read throws.
const test = require('node:test');
const assert = require('node:assert/strict');
const { BOUNDARY_LIMITS } = require('#dist/shared/core/boundary.js');
const { parseStoredEmbedSource, loadEmbedSource, parseStoredSelectorFilters, loadSelectorFilters, saveSelectorFilters, SELECTOR_FILTERS_DEFAULT } =
  require('../../helpers/rendererModule')('src/features/style/model/toolPreferences.ts');

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

test('the selector Hide toggles are off by default and remembered for the person', (context) => {
  // Not a site setting: one entry for the app, read by every project.
  assert.deepEqual(SELECTOR_FILTERS_DEFAULT, { hideGlobals: false, hideInherited: false });
  assert.deepEqual(parseStoredSelectorFilters('{"hideGlobals":true,"hideInherited":false}'), { hideGlobals: true, hideInherited: false });
  for (const raw of [PLATFORM_NULL, undefined, '', 'not json', '[]', 'null', '{"hideGlobals":"yes"}', 'x'.repeat(200)]) {
    assert.deepEqual(parseStoredSelectorFilters(raw), { hideGlobals: false, hideInherited: false }, String(raw).slice(0, 20));
  }
  const previous = globalThis.localStorage;
  context.after(() => {
    globalThis.localStorage = previous;
  });
  const stored = new Map();
  globalThis.localStorage = { getItem: (key) => stored.get(key), setItem: (key, value) => stored.set(key, value) };
  assert.deepEqual(loadSelectorFilters(), SELECTOR_FILTERS_DEFAULT, 'nothing stored: everything shows');
  saveSelectorFilters({ hideGlobals: true, hideInherited: true });
  assert.deepEqual(loadSelectorFilters(), { hideGlobals: true, hideInherited: true }, 'read back as saved');
  globalThis.localStorage = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('denied');
    },
  };
  assert.deepEqual(loadSelectorFilters(), SELECTOR_FILTERS_DEFAULT, 'unreadable storage: the default');
  saveSelectorFilters({ hideGlobals: true, hideInherited: false });
});
