// Goal: shared/page/pageNode.ts is the trust boundary for the page tree — anything
// electron/parse/astroParser or a future producer emits must survive it, and
// everything malformed must die here with a useful message.
//
// Methodology: known-good per kind passes; each known-bad shape fails and the
// failure message is pinned (AGENTS.md testing rules). Bounds from LIMITS are
// exercised: depth, node count, attr count. assertTreeInvariants is tested on
// the invariants the type cannot express (unique ids, branch names).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePageNode, parsePageTree, parsePageModel, parsePageResult, assertTreeInvariants } from '#dist/shared/page/pageNode.js';
import { LIMITS } from '#dist/shared/core/limits.js';

// Null as a boundary receives it, parsed from JSON: inputs may hold it; our values never do.
const jsonNull: unknown = JSON.parse('null');

// Helpers return producer-shaped plain data; branding happens in the parser.
const text = (id: string, value: string): unknown => ({ kind: 'text', id, value });
const element = (id: string, name: string, children: readonly unknown[] | undefined): unknown => ({
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
    { kind: 'component', id: 'n6', name: 'Hero', children: undefined, tightClose: true },
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
      children: [{ kind: 'element', id: 'n10', name: 'li', children: undefined }],
      bare: true,
    },
    {
      kind: 'cond',
      id: 'n11',
      op: '?',
      test: 'loggedIn',
      children: [
        {
          kind: 'branch',
          id: 'n12',
          name: 'then',
          children: [{ kind: 'text', id: 'n13', value: 'hi' }],
        },
        {
          kind: 'branch',
          id: 'n14',
          name: 'else',
          children: [{ kind: 'text', id: 'n15', value: 'bye' }],
        },
      ],
    },
    { kind: 'chunk-group', id: 'n5', name: 'Card', chunkFile: '/chunks/card.astro', children: [] },
  ];
  for (const node of good) {
    assert.doesNotThrow(() => parsePageNode(node));
  }
  // The layout id is assigned by parsePage, not the parser, and must pass.
  assert.doesNotThrow(() => parsePageNode({ kind: 'component', id: 'layout', name: 'Base', children: [] }));
});

test('negative space: every wrong shape fails with a pinned message', () => {
  assert.throws(() => parsePageNode(jsonNull), /PageNode\.node: expected object/);
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
    () =>
      parsePageNode({
        kind: 'element',
        id: 'n1',
        name: 'div',
        children: [],
        props: { class: { type: 'fancy' } },
      }),
    /unknown attr type/,
  );
  assert.throws(() => parsePageNode({ kind: 'map', id: 'n1', head: 'x.map((i) => (', children: [], bare: 'yes' }), /bare: expected boolean/);
  assert.throws(() => parsePageNode({ kind: 'text', id: 'n1', value: 'x', start: 4 }), /source range: expected safe integer offsets/);
  assert.throws(() => parsePageNode({ kind: 'text', id: 'n1', value: 'x', start: 4, end: 3 }), /source range: end must not precede start/);
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
    children: undefined,
    props: Object.fromEntries(Array.from({ length: LIMITS.attrsPerNodeMax + 1 }, (_, i) => [`a${i}`, { type: 'bare' }])),
  };
  assert.throws(() => parsePageNode(tooManyAttrs), /exceeds \d+ attrs/);
});

test('assertTreeInvariants: duplicate ids are the one invariant a parser cannot see', () => {
  assert.doesNotThrow(() => assertTreeInvariants(parsePageTree([element('n1', 'div', [text('n2', 'x')])])));
  assert.throws(() => assertTreeInvariants(parsePageTree([element('n1', 'div', [text('n1', 'x')])])), /duplicate id n1/);
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
    nodes: [{ kind: 'element', id: 'n1', name: 'div', children: undefined }],
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
    () =>
      parsePageModel({
        ...model,
        imports: Array.from({ length: LIMITS.importsMax + 1 }, () => model.imports[0]),
      }),
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
    layoutPath: undefined,
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

  assert.throws(() => parsePageModel({ ...model, nodes: [{ ...nodes[0], mdBlanksBefore: -1 }] }), /mdBlanksBefore: expected nonnegative integer/);
  assert.throws(() => parsePageModel({ ...model, nodes: [{ ...nodes[0], mdNumbers: ['one'] }] }), /mdNumbers\[0\]: expected integer/);
});

// Absence is `undefined` (AGENTS.md §6). JSON cannot say `undefined`, so data
// written before that convention holds `null`, and JSON drops the key
// altogether: the parser reads both as absent and emits `undefined`.
test('a self-closing tag, a missing bail and no layout read the same in every spelling', () => {
  for (const spelling of [{ children: undefined }, { children: jsonNull }, {}]) {
    const node = parsePageNode({ kind: 'element', id: 'n1', name: 'br', ...spelling });
    assert.ok(node.kind === 'element');
    assert.equal(node.children, undefined);
    assert.ok(Object.hasOwn(node, 'children'), 'the parsed tag states it has no children');
  }
  const refused = { editable: false, reason: 'r' };
  for (const spelling of [{ bail: undefined }, { bail: jsonNull }, {}]) {
    const result = parsePageResult({ ...refused, ...spelling });
    assert.ok(!result.editable);
    assert.equal(result.bail, undefined);
  }
  assert.throws(() => parsePageResult({ ...refused, bail: 'x' }), /result\.bail: expected object/);
  const markdown = {
    format: 'md',
    imports: [],
    extraFrontmatter: '',
    nodes: [],
    mdEol: '\n',
    mdEndsWithNewline: true,
    mdHasFrontmatter: false,
  };
  for (const spelling of [{ layoutPath: undefined }, { layoutPath: jsonNull }, {}]) {
    assert.equal(parsePageModel({ ...markdown, ...spelling }).layoutPath, undefined);
  }
  assert.equal(parsePageModel({ ...markdown, layoutPath: 'L.astro' }).layoutPath, 'L.astro');
  assert.throws(() => parsePageModel({ ...markdown, layoutPath: 3 }), /model\.layoutPath: expected string or nothing/);
});

// Attribute spans (plan §3.2): present only on a located parse, validated
// against the node's own range and against its props record.
const located = {
  kind: 'element',
  id: 'n1',
  name: 'p',
  children: undefined,
  props: { title: { type: 'string', value: 'Old' }, hidden: { type: 'bare' } },
  start: 0,
  end: 25,
  attrSpans: [
    {
      type: 'string',
      name: 'title',
      span: { start: 3, end: 14 },
      nameSpan: { start: 3, end: 8 },
      valueSpan: { start: 10, end: 13 },
    },
    {
      type: 'bare',
      name: 'hidden',
      span: { start: 15, end: 21 },
      nameSpan: { start: 15, end: 21 },
    },
  ],
};

test('attribute spans: a located tag passes with its spans intact', () => {
  const node = parsePageNode(located);
  assert.deepEqual(node.attrSpans, located.attrSpans);
  assert.equal(node.start, 0);
});

test('attribute spans: every wrong shape fails with a pinned message', () => {
  const [title, hidden] = located.attrSpans;
  const withSpans = (attrSpans: unknown, extra: object = {}) => ({
    ...located,
    attrSpans,
    ...extra,
  });
  const cases: readonly [unknown, RegExp][] = [
    [withSpans([title, hidden], { start: undefined, end: undefined }), /requires the node source range/],
    [withSpans({}), /attrSpans: expected array/],
    [withSpans([{ ...title, span: { start: 3, end: 30 } }, hidden]), /lies outside its node/],
    [withSpans([hidden, title]), /ascending, disjoint attribute spans/],
    [withSpans([{ ...title, valueSpan: { start: 2, end: 4 } }, hidden]), /valueSpan lies outside the attribute/],
    [withSpans([{ ...title, valueSpan: { start: 5, end: 6 } }, hidden]), /valueSpan must follow nameSpan/],
    [withSpans([{ ...title, valueSpan: undefined }, hidden]), /valueSpan: expected span object/],
    [withSpans([title, { ...hidden, valueSpan: { start: 15, end: 16 } }]), /valueSpan: not allowed on a bare/],
    [withSpans([title, { ...hidden, type: 'spread' }]), /nameSpan: not allowed on a spread/],
    [withSpans([title, { ...hidden, type: 'flag' }]), /unknown attr type/],
    [withSpans([title]), /names differ from props/],
    [withSpans([title, { ...hidden, name: 'shown' }]), /"hidden" differs from props/],
    [withSpans([{ ...title, type: 'expr' }, hidden]), /"title" differs from props/],
    [withSpans(Array.from({ length: LIMITS.attrsPerNodeMax + 1 }, () => hidden)), /exceeds/],
    [{ kind: 'text', id: 'n2', value: 'x', start: 0, end: 1, attrSpans: [] }, /a text node has no attributes/],
  ];
  for (const [input, message] of cases) {
    assert.throws(() => parsePageNode(input), message);
  }
});

test('an attribute named __proto__ survives the wire parser as an ordinary attribute', () => {
  const props = Object.fromEntries([['__proto__', { type: 'string', value: 'kept' }]]);
  const node = parsePageNode({ kind: 'element', id: 'n1', name: 'p', children: undefined, props });
  assert.ok(node.kind === 'element');
  assert.deepEqual(Object.keys(node.props ?? {}), ['__proto__']);
  assert.equal(Object.getPrototypeOf(node.props), Object.prototype, 'the prototype is untouched');
});
