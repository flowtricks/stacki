// Goal: reject ambiguous or escaping package configuration before filesystem access.
// Method: parse a valid source and exercise invalid shapes, limits and overlapping roots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseComponentSources, parseComponentOrigin } from '#dist/shared/properties/componentSources.js';

const source = {
  kind: 'package',
  package: '@ffnext/site-kit',
  directory: 'src/lumos/components',
  importPrefix: '@/components/',
};

test('package component configuration is explicit and versioned', () => {
  assert.deepEqual(parseComponentSources({ version: 1, sources: [source] }).sources, [source]);
  assert.deepEqual(parseComponentOrigin(undefined), { kind: 'local' });
  assert.throws(() => parseComponentOrigin({ kind: 'editable-package' }), /origin/);
  for (const input of [{}, { version: 2, sources: [] }, { version: 1, sources: {} }, { version: 1, sources: Array.from({ length: 17 }, () => source) }]) {
    assert.throws(() => parseComponentSources(input));
  }
});

test('package configuration rejects traversal, absolute roots and ambiguous aliases', () => {
  for (const patch of [
    { directory: '../secret' },
    { directory: '/tmp' },
    { directory: 'src/../private' },
    { package: '../package' },
    { kind: 'local' },
    { importPrefix: '@/../' },
    { importPrefix: 'https://example.com/' },
    { importPrefix: '@/components' },
  ]) {
    assert.throws(() => parseComponentSources({ version: 1, sources: [{ ...source, ...patch }] }));
  }
  assert.throws(() => parseComponentSources({ version: 1, sources: [source, source] }), /overlap/);
  assert.throws(
    () =>
      parseComponentSources({
        version: 1,
        sources: [source, { ...source, directory: 'src/other', importPrefix: '@/components/other/' }],
      }),
    /overlap/,
  );
});
