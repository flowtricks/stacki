// Goal: a node's ::before and ::after have canvas paths of their own, so the
// canvas measures and outlines them like any tracked path. Method: build each
// kind and read it back, then the negative space: a node's own path, other
// pseudo-elements, and a path already naming a pseudo-element.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pseudoPath, splitPseudoPath } from '#dist/shared/page/pseudoPath.js';

test('a pseudo path names its node and pseudo-element', () => {
  assert.equal(pseudoPath('0.2.1', 'before'), '0.2.1::before');
  assert.deepEqual(splitPseudoPath('0.2.1::after'), { nodePath: '0.2.1', pseudo: 'after' });
  assert.deepEqual(splitPseudoPath('src/components/Card.astro|0.1::before'), { nodePath: 'src/components/Card.astro|0.1', pseudo: 'before' });
});

test('other paths are not pseudo paths', () => {
  assert.equal(splitPseudoPath('0.2.1'), undefined);
  assert.equal(splitPseudoPath('0.2.1::marker'), undefined);
  assert.equal(splitPseudoPath('::before'), undefined);
});

test('a pseudo path is built from a node path only', () => {
  assert.throws(() => pseudoPath('', 'before'), /a pseudo-element belongs to a node/);
  assert.throws(() => pseudoPath('0.1::before', 'after'), /not already a pseudo path/);
});
