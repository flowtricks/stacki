// Goal: the converted parser keeps source output and validates legacy inputs.
// Methodology: exercise real parser/serializer/IPC round trips, then corrupt
// one field at a time and cross each new collection, text, and depth boundary.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePage, parseTemplate, serializeNodes, serializePage, serializePageMarked } from '#dist/electron/parse/astroParser.js';
import { assertTreeInvariants, parsePageNode, parsePageResult } from '#dist/shared/page/pageNode.js';
import { LIMITS } from '#dist/shared/core/limits.js';
import type { ParserNode } from '#dist/electron/parse/astroParserTypes.js';

// Null as a boundary receives it, parsed from JSON: inputs may hold it; our values never do.
const jsonNull: unknown = JSON.parse('null');

test('block loops and import slots survive the real IPC contract', () => {
  const source = [
    '---',
    'const title = "Page";',
    'import Card from "./Card.astro";',
    'const items = [{ title }];',
    '---',
    '{items.map((item) => { const label = item.title; return (<Card>{label}</Card>); })}',
  ].join('\n');
  const parsed = parsePage(source);
  assert.equal(parsed.editable, true);
  if (!parsed.editable) {
    return;
  }
  const received = parsePageResult(parsed);
  assert.equal(received.editable, true);
  if (!received.editable) {
    return;
  }
  const loop = received.model.nodes[0];
  assert.equal(loop?.kind, 'map');
  if (loop?.kind === 'map') {
    assert.deepEqual(loop.body, ['const label = item.title;']);
  }
  assert.deepEqual(received.model.frontmatterLayout, parsed.model.frontmatterLayout);
  assert.equal(serializePage(parsed.model), source + '\n');
  assert.match(serializePageMarked(parsed.model), /avb-s:/);
});

test('legacy component inputs retain defaults and do not gain frontmatter', () => {
  const nodes = [{ kind: 'element', name: 'div', children: [] }];
  assert.equal(serializePage({ nodes, hadFrontmatter: false }), '<div></div>\n');
  assert.equal(serializePage({ nodes, imports: [{ name: 'Card', path: './Card.astro' }] }), "---\nimport Card from './Card.astro';\n---\n<div></div>\n");
  assert.deepEqual(nodes, [{ kind: 'element', name: 'div', children: [] }]);
});

test('serializer rejects malformed node kinds and their required payloads', () => {
  const invalid: readonly unknown[] = [
    jsonNull,
    {},
    { kind: 'unknown' },
    { kind: 'text' },
    { kind: 'text', value: 3 },
    { kind: 'text', value: 'x', children: [] },
    { kind: 'raw', name: 'style' },
    { kind: 'element', name: 'div' },
    { kind: 'map', head: 'x.map(x => (', children: [], body: 'const a = 1;' },
    { kind: 'cond', test: 'x', op: '||', children: [] },
    { kind: 'cond', test: 'x', op: '&&', children: [{ kind: 'text', value: 'x' }] },
    { kind: 'branch', name: 'maybe', children: [] },
    { kind: 'chunk-group', name: 'chunk', children: [] },
  ];
  for (const input of invalid) {
    assert.throws(() => serializeNodes([input]), /Serialize|node\./);
  }
  assert.throws(() => serializePage(jsonNull), /SerializePage: expected object/);
  assert.throws(() => serializePage({ nodes: [], hadFrontmatter: 'false' }), /expected boolean/);
});

test('serializer validates optional source metadata and every attribute variant', () => {
  const node = { kind: 'element', name: 'div', children: undefined };
  const valid = {
    ...node,
    props: {
      title: { type: 'string', value: 'Hi' },
      hidden: { type: 'bare' },
      count: { type: 'expr', value: '2' },
      '...rest': { type: 'spread', value: 'rest' },
    },
  };
  assert.equal(serializeNodes([valid]), '<div title="Hi" hidden count={2} {...rest} />\n');
  for (const patch of [
    { props: { title: { type: 'invalid' } } },
    { props: { title: { type: 'expr' } } },
    { attrOrder: [2] },
    { attrSource: 2 },
    { source: false },
    { tightClose: 'yes' },
    { blankBefore: -1 },
    { blankAfter: 0.5 },
    { start: Number.NaN },
  ]) {
    assert.throws(() => serializeNodes([{ ...node, ...patch }]), /Serialize|node\.|attribute|array/);
  }
});

test('large input is accepted; only structural bounds (depth, cycles) fail before exhausting the process', () => {
  // No size limit (owner requirement): a page, a node list and a text run past every old cap are parsed, written and read whole.
  // Generated at test time, never committed.
  const big = parsePage('<p>' + 'x'.repeat(12_000_000) + '</p>');
  assert.equal(big.editable, true);
  const deepSource = '<div>'.repeat(LIMITS.treeDepthMax + 2) + 'x' + '</div>'.repeat(LIMITS.treeDepthMax + 2);
  assert.equal(parseTemplate(deepSource).clean, false);
  assert.equal(parseTemplate('<p>next parse still works</p>').clean, true);
  const wide = Array.from({ length: 50_000 }, () => ({
    kind: 'text',
    value: 'x',
  }));
  assert.doesNotThrow(() => serializeNodes(wide), 'more nodes than the old cap are written');
  const longText = 'x'.repeat(5_000_000);
  assert.ok(serializeNodes([{ kind: 'text', value: longText }]).includes(longText), 'a text node longer than the old cap is written whole');
  const cycle: { kind: string; name: string; children: unknown[] } = {
    kind: 'element',
    name: 'div',
    children: [],
  };
  cycle.children.push(cycle);
  assert.throws(() => serializeNodes([cycle]), /depth limit/);
});

// Compile-time negative space: an object cannot combine text and element data.
type AssertFalse<T extends false> = T;
export type TextCannotHaveChildren = AssertFalse<
  {
    kind: 'text';
    value: string;
    children: [];
  } extends ParserNode
    ? true
    : false
>;
export type LoopBodyIsNotText = AssertFalse<
  {
    kind: 'map';
    head: string;
    children: [];
    body: string;
  } extends ParserNode
    ? true
    : false
>;

test('truncated raw close tags and deep conditional chains finish safely', () => {
  assert.equal(parsePage('<style>body { color: red; }</style').editable, false);
  assert.equal(parsePage('<script>const x = 1;</script').editable, false);
  const chain = '{' + 'x ? <p /> : '.repeat(LIMITS.treeDepthMax + 2) + '<p />}';
  assert.doesNotThrow(() => parsePage(chain));
  assert.equal(parsePage('<p />').editable, true);
});

test('loop statement wire data rejects the old string shape and malformed arrays', () => {
  const loop = { id: 'n1', kind: 'map', head: 'items.map(item => (', children: [] };
  for (const body of ['const x = 1;', [1], [jsonNull]]) {
    assert.throws(() => parsePageNode({ ...loop, body }), /body/);
  }
  // No size limit: a body of more statements than the old cap is accepted.
  const body = Array.from({ length: 50_000 }, () => 'const x = 1;');
  assert.doesNotThrow(() => parsePageNode({ ...loop, body }));
});

test('producer tree invariants reject missing ids and over-deep trees, and accept any width', () => {
  assert.throws(() => assertTreeInvariants([{ kind: 'text' }]), /Tree invariant violated: missing id/);
  const wide = Array.from({ length: 50_000 }, (_, index) => ({
    kind: 'text',
    id: `n${index}`,
  }));
  assert.doesNotThrow(() => assertTreeInvariants(wide), 'a list wider than the old 20000-node cap is valid');
  let tree: ParserNode = { kind: 'text', id: 'n0', value: 'leaf' };
  for (let index = 1; index <= LIMITS.treeDepthMax + 1; index++) {
    tree = { kind: 'element', id: `n${index}`, name: 'div', children: [tree] };
  }
  assert.throws(() => assertTreeInvariants([tree]), /Tree invariant violated: exceeds depth 64/);
});

test('an empty loop saves as code that builds and reads back empty', () => {
  // A loop just inserted has no children. `(item) => ()` does not parse, so
  // the body is written as `null`, and reading it back finds no children.
  for (const loop of [
    { id: 'n1', kind: 'map', head: '[].map((item) => (', children: [] },
    { id: 'n1', kind: 'map', head: '[].map((item) => (', children: [], bare: true },
  ] as const) {
    const written = serializeNodes([parsePageNode(loop)]);
    assert.ok(!/\(\s*\)\s*\)/.test(written), `no empty arrow body in ${written}`);
    const parsed = parseTemplate(written);
    assert.equal(parsed.clean, true, `${written} parses`);
    const [read] = parsed.nodes;
    assert.equal(read?.kind, 'map');
    if (read?.kind !== 'map') {
      return;
    }
    assert.deepEqual(read.children, [], `an empty loop reads back empty from ${written}`);
    if (loop.bare === undefined) {
      // Read as code, a just-inserted loop showed only its Code field instead of
      // its Source, Filters and Sort.
      assert.equal(read.bodyParts, undefined, `an empty loop is a loop, not code: ${written}`);
    }
  }
});
