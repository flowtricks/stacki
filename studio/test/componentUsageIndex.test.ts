// Goal: counting all components reuses source analysis without changing alias semantics.
// Method: inspect prepared indexes for renamed imports, shadowing, frontmatter,
// markdown, repeated queries, and large inputs (no product size limit); fresh indexes reflect edits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { instanceCounts, instancesIn } from '../vendor/stacki/electron/properties/componentUsage';
import { LIMITS, PLATFORM_LIMITS } from '../vendor/stacki/shared/core/limits';

const file = path.resolve('/project/src/pages/index.astro');
const card = path.resolve('/project/src/components/Card.astro');
const other = path.resolve('/project/src/components/Other.astro');

test('a prepared source index retains aliases, shadowing and fallback counts', () => {
  const source = `---
import Tile from '../components/Card.astro';
import Card from '../components/Other.astro';
const example = '<Tile /><Card />';
---
<Tile/><Tile></Tile><Card/><Fallback/><FallbackExtra/>`;
  const counts = instanceCounts(source, file, []);
  assert.equal(counts({ targetPath: card, name: 'Card' }), 2);
  assert.equal(counts({ targetPath: other, name: 'Other' }), 1);
  assert.equal(counts({ targetPath: '/absent/Card.astro', name: 'Card' }), 0);
  assert.equal(counts({ targetPath: '/absent/Fallback.astro', name: 'Fallback' }), 1);
  assert.equal(counts({ name: 'FallbackExtra' }), 1);
  assert.equal(counts({ name: 'Fallback_' }), 0);
  assert.equal(instancesIn(source, { file, targetPath: card, name: 'Card', counts }), 2);
  assert.equal(counts({ targetPath: card, name: 'Card' }), 2, 'Queries never consume the index');
  const changed = instanceCounts(source + '<Tile />', file, []);
  assert.equal(changed({ targetPath: card, name: 'Card' }), 3);
  assert.equal(counts({ targetPath: card, name: 'Card' }), 2, 'Snapshots remain independent');
});

test('markdown imports and missing markup do not invent instances', () => {
  const counts = instanceCounts("import Tile from '../components/Card.astro';\n<Tile />", file, []);
  assert.equal(counts({ targetPath: card, name: 'Card' }), 1);
  const empty = instanceCounts("import Tile from '../components/Card.astro';", file, []);
  assert.equal(empty({ targetPath: card, name: 'Card' }), 0);
});

test('source and tag indexes take a page of any size', () => {
  // A source is bounded only by the longest string the platform holds (no product size limit), so a longer one
  // cannot be built: the bound is pinned instead of exceeded.
  assert.equal(LIMITS.sourceBytesMax, PLATFORM_LIMITS.stringUnitsMax);
  const source = Array.from({ length: 10_001 }, (_, index) => `<Tag${index}/>`).join('');
  // The old 10,000 tag-name cap is gone: every distinct tag is read, none refused.
  assert.doesNotThrow(() => instanceCounts(source, file, []));
});
