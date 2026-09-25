// Goal: shared/page-node.ts is the trust boundary for the page tree — anything
// electron/astroParser or a future producer emits must survive it, and
// everything malformed must die here with a useful message.
//
// Methodology: known-good per kind passes; each known-bad shape fails and the
// failure message is pinned (AGENTS.md testing rules). Bounds from LIMITS are
// exercised: depth, node count, attr count. assertTreeInvariants is tested on
// the invariants the type cannot express (unique ids, branch names).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePageNode,
  parsePageTree,
  parsePageModel,
  parsePageResult,
  assertTreeInvariants,
} from '../../dist/shared/page-node.js';
import { LIMITS } from '../../dist/shared/limits.js';

// Helpers return producer-shaped plain data; branding happens in the parser.
const text = (id: string, value: string): unknown => ({ kind: 'text', id, value });
const element = (id: string, name: string, children: readonly unknown[] | null): unknown => ({
  kind: 'element',
  id,
  name,
  children,
});

test('every kind round-trips through the parser', () => {
  const good: readonly unknown[] = [
    { kind: 'text', id: 'n1', value: 'hello', start: 4, end: 9 },
    { kind: 'expr', id: 'n2', value: '{count}' },
    { kind: 'raw-line', id: 'n3', value: '<hr>' },
    { kind: 'comment', id: 'n4', value: 'note', jsx: true },
    { kind: 'raw', id: 'n5', name: 'style', inner: '.a { color: red }' },
    { kind: 'component', id: 'n6', name: 'Hero', children: null, tightClose: true },
    {
      kind: 'element',
      id: 'n7',
      name: 'div',
      children: [{ kind: 'text', id: 'n8', value: 'x' }],
      props: { class: { type: 'string', value: 'box' } },
      attrOrder: ['class'],
      attrSource: 'class="box"',
      blankBefore: 2,
    },
    {
      kind: 'map',
      id: 'n9',
      head: 'items.map((item) => (',
      children: [{ kind: 'element', id: 'n10', name: 'li', children: null }],
      bare: true,
    },
    {
      kind: 'cond',
      id: 'n11',
      op: '?',
      test: 'loggedIn',
      children: [
        { kind: 'branch', id: 'n12', name: 'then', children: [{ kind: 'text', id: 'n13', value: 'hi' }] },
        { kind: 'branch', id: 'n14', name: 'else', children: [{ kind: 'text', id: 'n15', value: 'bye' }] },
      ],
    },
    { kind: 'chunk-group', id: 'chunk0', name: 'Card', chunkFile: '/chunks/card.astro', children: [] },
  ];
  for (const node of good) {
    assert.doesNotThrow(() => parsePageNode(node));
  }
  // The layout id is assigned by parsePage, not the parser, and must pass.
  assert.doesNotThrow(() => parsePageNode({ kind: 'component', id: 'layout', name: 'Base', children: [] }));
});

test('negative space: every wrong shape fails with a pinned message', () => {
  assert.throws(() => parsePageNode(null), /PageNode\.node: expected object/);
  assert.throws(() => parsePageNode([]), /expected object/);
  assert.throws(() => parsePageNode({ kind: 'text', id: 'n1' }), /value: expected string/);
  assert.throws(() => parsePageNode({ kind: 'wat', id: 'n1' }), /unknown kind "wat"/);
  assert.throws(() => parsePageNode({ kind: 'text', id: 'free-form', value: 'x' }), /NodeId: expected/);
  assert.throws(() => parsePageNode({ kind: 'text', id: 7, value: 'x' }), /id: expected id string/);
  assert.throws(() => parsePageNode({ kind: 'cond', id: 'n1', op: '||', test: 'x', children: [] }), /unknown cond op/);
  assert.throws(
    () =>
      parsePageNode({
        kind: 'cond',
        id: 'n1',
        op: '&&',
        test: 'x',
        children: [{ kind: 'branch', id: 'n2', name: 'maybe', children: [] }],
      }),
    /branch name must be 'then' or 'else'/,
  );
  assert.throws(
    () =>
      parsePageNode({
        kind: 'cond',
        id: 'n1',
        op: '&&',
        test: 'x',
        children: [{ kind: 'text', id: 'n2', value: 'x' }],
      }),
    /cond children must be branch nodes/,
  );
  assert.throws(() => parsePageNode({ kind: 'element', id: 'n1', name: 'div', children: 'nope' }), /children: expected/);
  assert.throws(
    () => parsePageNode({ kind: 'element', id: 'n1', name: 'div', children: [], props: { class: { type: 'fancy' } } }),
    /unknown attr type/,
  );
  assert.throws(
    () => parsePageNode({ kind: 'map', id: 'n1', head: 'x.map((i) => (', children: [], bare: 'yes' }),
    /bare: expected boolean/,
  );
  assert.throws(
    () => parsePageNode({ kind: 'text', id: 'n1', value: 'x', start: 4 }),
    /source range: expected safe integer offsets/,
  );
  assert.throws(
    () => parsePageNode({ kind: 'text', id: 'n1', value: 'x', start: 4, end: 3 }),
    /source range: end must not precede start/,
  );
});

test('bounds: depth and node count fail at LIMITS, not at stack depth', () => {
  let deep: unknown = { kind: 'text', id: `n${LIMITS.treeDepthMax + 2}`, value: 'leaf' };
  for (let i = LIMITS.treeDepthMax + 1; i >= 1; i--) {
    deep = { kind: 'element', id: `n${i}`, name: 'div', children: [deep] };
  }
  assert.throws(() => parsePageNode(deep), /exceeds depth/);

  const wide = Array.from({ length: LIMITS.treeNodesMax + 1 }, (_, i) => text(`n${i}`, 'x'));
  assert.throws(() => parsePageTree(wide), /exceeds \d+ nodes/);

  const tooManyAttrs = {
    kind: 'element',
    id: 'n1',
    name: 'div',
    children: null,
    props: Object.fromEntries(
      Array.from({ length: LIMITS.attrsPerNodeMax + 1 }, (_, i) => [`a${i}`, { type: 'bare' }]),
    ),
  };
  assert.throws(() => parsePageNode(tooManyAttrs), /exceeds \d+ attrs/);
});

test('assertTreeInvariants: duplicate ids are the one invariant a parser cannot see', () => {
  assert.doesNotThrow(() => assertTreeInvariants(parsePageTree([element('n1', 'div', [text('n2', 'x')])])));
  assert.throws(
    () => assertTreeInvariants(parsePageTree([element('n1', 'div', [text('n1', 'x')])])),
    /duplicate id n1/,
  );
});

test('parsePageModel and parsePageResult: the envelope is data, including not-editable', () => {
  const model = {
    imports: [{ name: 'Hero', path: '../components/Hero.astro', quote: "'", named: false, typeOnly: false }],
    frontmatterLead: '',
    extraFrontmatter: '',
    extraFrontmatterSpaced: false,
    frontmatterLayout: { extra: '', slots: [] },
    hadFrontmatter: true,
    trailingBlank: 0,
    nodes: [{ kind: 'element', id: 'n1', name: 'div', children: null }],
  };
  assert.equal(parsePageResult({ editable: true, model }).editable, true);
  assert.equal(parsePageModel({ ...model, eol: '\r\n' }).eol, '\r\n');
  assert.throws(() => parsePageModel({ ...model, eol: '\r' }), /model\.eol: expected LF or CRLF/);
  const notEditable = parsePageResult({
    editable: false,
    reason: 'Page contains markup the visual editor cannot represent.',
    bail: { what: 'a stray <', near: '<' },
  });
  assert.equal(notEditable.editable, false);
  if (!notEditable.editable) {
    assert.equal(notEditable.bail?.what, 'a stray <');
  }
  assert.throws(() => parsePageResult({ editable: 'yes' }), /editable: expected boolean/);
  assert.throws(
    () => parsePageModel({ ...model, imports: Array.from({ length: LIMITS.importsMax + 1 }, () => model.imports[0]) }),
    /exceeds \d+/,
  );
});

test('parsePageModel preserves Markdown source metadata and rejects malformed metadata', () => {
  const nodes = Object.assign(
    [
      {
        kind: 'element',
        id: 'm1',
        name: 'h1',
        children: [{ kind: 'text', id: 'm2', value: 'Title', mdSource: 'Title' }],
        mdBlanksBefore: 1,
        mdSource: '# Title',
      },
    ],
    { mdTrailingBlanks: 2 },
  );
  const model = {
    format: 'md',
    imports: [],
    extraFrontmatter: 'title: Example',
    frontmatterLang: 'yaml',
    layoutPath: null,
    nodes,
    mdEol: '\n',
    mdEndsWithNewline: true,
    mdHasFrontmatter: true,
  };

  const parsed = parsePageModel(model);
  assert.equal(parsed.format, 'md');
  assert.equal(parsed.nodes.mdTrailingBlanks, 2);
  assert.equal(parsed.nodes[0]?.mdBlanksBefore, 1);
  assert.equal(parsed.nodes[0]?.mdSource, '# Title');
  const heading = parsed.nodes[0];
  assert.ok(heading !== undefined);
  if (heading.kind !== 'element') {
    throw new Error('Expected Markdown heading to parse as an element');
  }
  assert.equal(heading.children?.[0]?.mdSource, 'Title');

  assert.throws(
    () => parsePageModel({ ...model, nodes: [{ ...nodes[0], mdBlanksBefore: -1 }] }),
    /mdBlanksBefore: expected nonnegative integer/,
  );
  assert.throws(
    () => parsePageModel({ ...model, nodes: [{ ...nodes[0], mdNumbers: ['one'] }] }),
    /mdNumbers\[0\]: expected integer/,
  );
});
