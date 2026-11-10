// Goal: shared/properties/projectScan.ts validates the 'project:scan' payload — the project's
// inventory as the renderer sees it. Every panel indexes into this; a bad
// entry poisons selection, routing, and the palette.
//
// Methodology: a full scan passes; each known-bad entry shape fails with a
// pinned message; array bounds from LIMITS are exercised.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScanResult } from '#dist/shared/properties/projectScan.js';
import { LIMITS } from '#dist/shared/core/limits.js';

// Null as a boundary receives it, parsed from JSON: inputs may hold it; our values never do.
const jsonNull: unknown = JSON.parse('null');

const goodScan = {
  pages: [{ path: '/p/src/pages/index.astro', name: 'index.astro', route: '/' }],
  pageFolders: ['blog'],
  layouts: [
    {
      path: '/p/src/layouts/Base.astro',
      name: 'Base',
      folder: 'layouts',
      isLayout: true,
      instances: 3,
      schema: [{ name: 'title', type: 'string', optional: false }],
      extendsTag: 'div',
      slots: ['default'],
      slotText: false,
      renderTag: { tag: 'html' },
      hasRest: true,
    },
  ],
  components: [{ path: '/p/src/components/Hero.astro', name: 'Hero', folder: '', instances: 2 }],
  trailingSlash: 'ignore',
};

test('a full scan passes intact', () => {
  const parsed = parseScanResult(structuredClone(goodScan));
  assert.equal(parsed.pages[0]?.route, '/');
  assert.equal(parsed.layouts[0]?.schema?.[0]?.type, 'string');
  assert.equal(parsed.layouts[0]?.renderTag?.tag, 'html');
  assert.equal(parsed.layouts[0]?.hasRest, true);
  assert.equal(parsed.trailingSlash, 'ignore');
});

// Absence is `undefined` (AGENTS.md §6): a component with no extended tag or no
// root tag says so with `undefined`, and `null` is not part of the contract.
test('a component without an extended or root tag carries undefined, never null', () => {
  const bare = { path: '/x', name: 'X', folder: '', extendsTag: undefined, renderTag: undefined };
  const parsed = parseScanResult({ ...goodScan, components: [bare] });
  assert.equal(parsed.components[0]?.extendsTag, undefined);
  assert.equal(parsed.components[0]?.renderTag, undefined);
  assert.throws(() => parseScanResult({ ...goodScan, components: [{ ...bare, extendsTag: jsonNull }] }), /extendsTag: expected string/);
  assert.throws(() => parseScanResult({ ...goodScan, components: [{ ...bare, renderTag: jsonNull }] }), /renderTag: expected object/);
});

// The component a template opens with: the palette follows these names to find sections.
test('a root component passes, and every wrong shape of it fails', () => {
  const base = { path: '/x', name: 'Hero', folder: '' };
  const parsed = parseScanResult({ ...goodScan, components: [{ ...base, rootComponent: 'Section' }, { ...base, rootComponent: undefined }, base] });
  assert.equal(parsed.components[0]?.rootComponent, 'Section');
  assert.equal(parsed.components[1]?.rootComponent, undefined);
  assert.equal(parsed.components[2]?.rootComponent, undefined);
  assert.throws(() => parseScanResult({ ...goodScan, components: [{ ...base, rootComponent: jsonNull }] }), /rootComponent: expected string/);
  assert.throws(() => parseScanResult({ ...goodScan, components: [{ ...base, rootComponent: 7 }] }), /rootComponent: expected string/);
  assert.throws(() => parseScanResult({ ...goodScan, components: [{ ...base, rootComponent: '' }] }), /rootComponent: expected non-empty string/);
  assert.throws(
    () => parseScanResult({ ...goodScan, components: [{ ...base, rootComponent: 'S'.repeat(LIMITS.tagNameCharsMax + 1) }] }),
    /rootComponent: exceeds 128 chars/,
  );
  assert.equal(
    parseScanResult({ ...goodScan, components: [{ ...base, rootComponent: 'S'.repeat(LIMITS.tagNameCharsMax) }] }).components[0]?.rootComponent?.length,
    LIMITS.tagNameCharsMax,
  );
  assert.throws(
    () => parseScanResult({ ...goodScan, layouts: [{ ...goodScan.layouts[0], rootComponent: [] }] }),
    /layouts\[0\]\.rootComponent: expected string/,
  );
});

test('negative space: wrong entry shapes fail with pinned messages', () => {
  assert.throws(() => parseScanResult(jsonNull), /expected object/);
  assert.throws(() => parseScanResult({ ...goodScan, pages: {} }), /pages: expected array/);
  assert.throws(() => parseScanResult({ ...goodScan, pages: [{ path: '/x', name: 'x.astro' }] }), /route: expected string/);
  assert.throws(
    () =>
      parseScanResult({
        ...goodScan,
        components: [{ path: '/x', name: 'X', folder: '', isLayout: false }],
      }),
    /isLayout: only true is ever written/,
  );
  assert.throws(
    () =>
      parseScanResult({
        ...goodScan,
        components: [{ path: '/x', name: 'X', folder: '', instances: 1.5 }],
      }),
    /instances: expected nonnegative integer/,
  );
  assert.throws(
    () =>
      parseScanResult({
        ...goodScan,
        components: [{ path: '/x', name: 'X', folder: '', instances: -1 }],
      }),
    /instances: expected nonnegative integer/,
  );
  assert.throws(
    () =>
      parseScanResult({
        ...goodScan,
        components: [{ path: '/x', name: 'X', folder: '', slots: [1] }],
      }),
    /slots: expected strings/,
  );
  assert.throws(
    () =>
      parseScanResult({
        ...goodScan,
        components: [{ path: '/x', name: 'X', folder: '', schema: {} }],
      }),
    /schema: expected array of fields/,
  );
  assert.throws(
    () =>
      parseScanResult({
        ...goodScan,
        components: [{ path: '/x', name: 'X', folder: '', schema: [{ type: 'string' }] }],
      }),
    /name: expected non-empty string/,
  );
  assert.throws(
    () =>
      parseScanResult({
        ...goodScan,
        components: [{ path: '/x', name: 'X', folder: '', hasRest: 'yes' }],
      }),
    /hasRest: expected boolean/,
  );
});

test('bounds: entry counts fail at LIMITS', () => {
  const page = goodScan.pages[0];
  assert.throws(
    () =>
      parseScanResult({
        ...goodScan,
        pages: Array.from({ length: LIMITS.scanEntriesMax + 1 }, () => page),
      }),
    /exceeds \d+ entries/,
  );
  assert.throws(
    () =>
      parseScanResult({
        ...goodScan,
        pageFolders: Array.from({ length: LIMITS.scanFoldersMax + 1 }, () => 'f'),
      }),
    /exceeds \d+ entries/,
  );
});

test('page titles are optional bounded strings, never unchecked display data', () => {
  const page = { path: '/site/src/pages/about.astro', name: 'about.astro', route: '/about' };
  const scan = (title: unknown) => parseScanResult({ ...goodScan, pages: [{ ...page, title }] });
  assert.equal(scan('About us').pages[0]?.title, 'About us');
  assert.equal(scan(undefined).pages[0]?.title, undefined);
  for (const value of [jsonNull, 42, {}, []]) {
    assert.throws(() => scan(value), /title: expected string/);
  }
  assert.throws(() => scan('x'.repeat(LIMITS.ipcFieldCharsMax + 1)), /title: exceeds/);
});

test('inherited page titles use the same boundary validation as direct titles', () => {
  const page = {
    path: '/site/src/pages/resources.astro',
    name: 'resources.astro',
    route: '/resources',
  };
  const scan = (inheritedTitle: unknown) => parseScanResult({ ...goodScan, pages: [{ ...page, inheritedTitle }] });
  assert.equal(scan('Resources').pages[0]?.inheritedTitle, 'Resources');
  assert.equal(scan(undefined).pages[0]?.inheritedTitle, undefined);
  for (const value of [jsonNull, 42, {}, [], 'x'.repeat(LIMITS.ipcFieldCharsMax + 1)]) {
    assert.throws(() => scan(value), /inheritedTitle:/);
  }
});

// The project's length unit rides on the scan (lengthUnit.ts): parsed when present,
// absent from an older host, refused when malformed.
test('the scan carries the project length unit', () => {
  const rem = parseScanResult({ ...structuredClone(goodScan), lengthUnit: { kind: 'rem', rootFontPx: 16 } });
  assert.deepEqual(rem.lengthUnit, { kind: 'rem', rootFontPx: 16 });
  assert.equal(parseScanResult(structuredClone(goodScan)).lengthUnit, undefined);
  assert.throws(() => parseScanResult({ ...structuredClone(goodScan), lengthUnit: { kind: 'vw' } }), {
    message: 'LengthUnit.kind: expected "px" or "rem"',
  });
});
