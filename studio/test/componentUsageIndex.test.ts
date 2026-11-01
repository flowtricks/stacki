// Goal: counting all components reuses source analysis without changing alias semantics.
// Method: inspect prepared indexes for renamed imports, shadowing, frontmatter,
// markdown, repeated queries, and oversized inputs; fresh indexes reflect edits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { instanceCounts, instancesIn } from '../vendor/stacki/electron/properties/componentUsage';
import { LIMITS } from '../vendor/stacki/shared/core/limits';

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

test('source and tag indexes reject excessive growth', () => {
  assert.throws(() => instanceCounts('x'.repeat(LIMITS.sourceBytesMax + 1), file, []), /Usage source stays within the reader limit/);
  const source = Array.from({ length: 10_001 }, (_, index) => `<Tag${index}/>`).join('');
  assert.throws(() => instanceCounts(source, file, []), /10,000 tag names/);
});
