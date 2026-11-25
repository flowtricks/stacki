// Goal: a pseudo-element belongs only to a node that is one HTML element able to
// draw it. A loop showed ::before and ::after rows in the navigator because the
// canvas read its first `<li>`; a component instance, an if, a Fragment, a slot,
// text, an `img` and an SVG path must never own one either.
// Method: the table is walked as a table: every node kind and a set of tags,
// crossed with every pseudo-element name, against the expected validity. Then
// the validated constructor and the consumer's assertion are checked on both
// sides of the boundary, with the refusal messages pinned.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PSEUDO_ELEMENTS,
  assertPseudoLayerHost,
  parsePseudoLayerTarget,
  pseudoElementValidity,
  pseudoLayerAllowed,
  pseudoValidityForTag,
} from '#dist/shared/page/pseudoElements.js';

const element = (name: string) => ({ id: 'n0', kind: 'element', name });

// Nodes that put no single element of their own on the page: never a pseudo-element.
const NOT_ELEMENTS = [
  { id: 'n1', kind: 'map' },
  { id: 'n2', kind: 'cond' },
  { id: 'n3', kind: 'branch', name: 'then' },
  { id: 'n4', kind: 'component', name: 'Button' },
  { id: 'n5', kind: 'element', name: 'Fragment' },
  { id: 'n6', kind: 'element', name: 'slot' },
  { id: 'n7', kind: 'text' },
  { id: 'n8', kind: 'expr' },
  { id: 'n9', kind: 'raw', name: 'style' },
  { id: 'n10', kind: 'comment' },
  { id: 'n11', kind: 'chunk-group', name: 'chunk' },
  { id: 'n12', kind: 'element', name: 'Tag', dynamicTag: true },
  { id: 'n13', kind: 'element', name: 'div', dynamicTag: true },
] as const;

// Expected validity per tag, in PSEUDO_ELEMENTS order: before, after, marker, placeholder, first-line, first-letter.
const TAG_TABLE: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['div', ['valid', 'valid', 'display-dependent', 'invalid', 'valid', 'valid']],
  ['li', ['valid', 'valid', 'valid', 'invalid', 'valid', 'valid']],
  ['summary', ['valid', 'valid', 'valid', 'invalid', 'valid', 'valid']],
  ['span', ['valid', 'valid', 'display-dependent', 'invalid', 'display-dependent', 'display-dependent']],
  ['a', ['valid', 'valid', 'display-dependent', 'invalid', 'display-dependent', 'display-dependent']],
  ['my-card', ['valid', 'valid', 'display-dependent', 'invalid', 'display-dependent', 'display-dependent']],
  ['input', ['invalid', 'invalid', 'invalid', 'valid', 'invalid', 'invalid']],
  ['textarea', ['invalid', 'invalid', 'invalid', 'valid', 'invalid', 'invalid']],
  ['img', ['invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid']],
  ['br', ['invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid']],
  ['hr', ['invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid']],
  ['video', ['invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid']],
  ['iframe', ['invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid']],
  ['canvas', ['invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid']],
  ['svg', ['invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid']],
  ['path', ['invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid']],
  ['select', ['invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid']],
];

test('the table answers every tag for every pseudo-element', () => {
  for (const [tag, expected] of TAG_TABLE) {
    assert.equal(expected.length, PSEUDO_ELEMENTS.length, `${tag}: one answer per pseudo-element`);
    for (const [index, pseudo] of PSEUDO_ELEMENTS.entries()) {
      assert.equal(pseudoElementValidity(element(tag), pseudo), expected[index], `<${tag}>::${pseudo}`);
      assert.equal(pseudoValidityForTag(tag, pseudo), expected[index], `${tag} by tag ::${pseudo}`);
    }
  }
});

test('a node that is not one HTML element owns no pseudo-element', () => {
  for (const node of NOT_ELEMENTS) {
    for (const pseudo of PSEUDO_ELEMENTS) {
      assert.equal(pseudoElementValidity(node, pseudo), 'invalid', `${node.kind} ${'name' in node ? node.name : ''}::${pseudo}`);
    }
    assert.equal(pseudoLayerAllowed(node, 'before'), false, `${node.kind}: no ::before row`);
    assert.equal(pseudoLayerAllowed(node, 'after'), false, `${node.kind}: no ::after row`);
  }
  assert.equal(pseudoLayerAllowed(undefined, 'before'), false, 'no node, no row');
});

test('the constructor builds a target for an HTML element', () => {
  const built = parsePseudoLayerTarget({ id: 'n0.1', kind: 'element', name: 'li' }, 'after');
  assert.equal(built.ok, true);
  if (built.ok) {
    assert.equal(built.value.nodeId, 'n0.1');
    assert.equal(built.value.pseudo, 'after');
  }
});

test('the constructor refuses every other node, with the reason pinned', () => {
  const loop = parsePseudoLayerTarget({ id: 'n0', kind: 'map' }, 'before');
  assert.deepEqual(loop, { ok: false, error: { code: 'pseudo-host-invalid', message: '::before belongs to an HTML element, not a map node' } });
  const instance = parsePseudoLayerTarget({ id: 'n1', kind: 'component', name: 'Button' }, 'after');
  assert.deepEqual(instance, {
    ok: false,
    error: { code: 'pseudo-host-invalid', message: '::after belongs to an HTML element, not component <Button>' },
  });
  const image = parsePseudoLayerTarget({ id: 'n2', kind: 'element', name: 'img' }, 'before');
  assert.deepEqual(image, { ok: false, error: { code: 'pseudo-host-invalid', message: '::before belongs to an HTML element, not element <img>' } });
  const missing = parsePseudoLayerTarget(undefined, 'after');
  assert.deepEqual(missing, { ok: false, error: { code: 'pseudo-host-missing', message: '::after: the node is not in the page' } });
});

test('the consumer asserts what the producer checked', () => {
  assert.doesNotThrow(() => assertPseudoLayerHost({ kind: 'element', name: 'section' }, 'before', 'Navigator'));
  assert.throws(
    () => assertPseudoLayerHost({ kind: 'map' }, 'before', 'Navigator'),
    /Assertion failed: Navigator: ::before belongs to an HTML element, not a map node/,
  );
  assert.throws(
    () => assertPseudoLayerHost({ kind: 'element', name: 'input' }, 'after', 'Navigator'),
    /Navigator: ::after belongs to an HTML element, not element <input>/,
  );
});
