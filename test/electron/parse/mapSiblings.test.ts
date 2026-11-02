// Goal: a loop whose callback returns sibling elements with no wrapper stays a
// loop of elements, never a code block. Astro allows `(<Img /> <img />)`, and
// the serializer writes exactly that for a loop with several children, so a
// reader that refused it turned the editor's own output into opaque code.
// Method: parse the reported source and every callback form with sibling roots,
// round-trip each byte for byte, compile the marked preview with Astro, then
// hold the writer/reader contract directly: a loop serialized with one to four
// children reads back as a loop with the same children. Negative space: a
// written comma is a JavaScript sequence, not siblings.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transform } from '@astrojs/compiler';
import { parsePage, serializePage, serializePageMarked } from '#dist/electron/parse/astroParser.js';
import { parsePageResult } from '#dist/shared/page/pageNode.js';
import type { ParserNode } from '#dist/electron/parse/astroParserTypes.js';

function modelOf(source: string) {
  const result = parsePage(source, { locs: true });
  assert.ok(result.editable);
  assert.equal(parsePageResult(result).editable, true);
  return result.model;
}

function loopIn(source: string): Extract<ParserNode, { kind: 'map' }> {
  const wrapper = modelOf(source).nodes[0];
  const loop = wrapper?.kind === 'element' ? wrapper.children?.[0] : wrapper;
  assert.equal(loop?.kind, 'map', `expected a loop, read ${JSON.stringify(loop)}`);
  assert.ok(loop?.kind === 'map');
  return loop;
}

function names(nodes: readonly ParserNode[]): readonly string[] {
  return nodes.map((node) => (node.kind === 'element' || node.kind === 'component' ? node.name : node.kind));
}

const reported = `<div>
  {
    teamEntries.map((item) => (
      <Img />
      <img />
    ))
  }
</div>
`;

test('the reported loop with two sibling roots reads as a loop of two elements', async () => {
  const loop = loopIn(reported);
  assert.deepEqual(names(loop.children), ['Img', 'img']);
  assert.equal(loop.bodyParts, undefined);
  const model = modelOf(reported);
  assert.equal(serializePage(model), reported);
  const marked = await transform(serializePageMarked(model), { filename: '/Siblings.astro' });
  assert.deepEqual(
    marked.diagnostics.filter((diagnostic) => diagnostic.severity === 1),
    [],
  );
});

for (const [form, expression, expected] of [
  ['concise', 'items.map((item) => (<a /><b />))', ['a', 'b']],
  ['bare', 'items.map((item) => <a /><b />)', ['a', 'b']],
  ['three roots', 'items.map((item) => (\n  <a />\n  <b>{item}</b>\n  <C />\n))', ['a', 'b', 'C']],
  ['block', 'items.map((item) => {\n  const label = item.name;\n  return (\n    <a>{label}</a>\n    <b />\n  );\n})', ['a', 'b']],
  ['general', 'items.map(async (item) => { await load(item); return (<a /><b />); })', ['a', 'b']],
  ['conditional', 'items.map((item) => item.on ? (<a /><b />) : <c />)', ['cond']],
  ['flatMap', 'groups.flatMap((group) => group.cards.map((card) => (<a /><b />)))', ['a', 'b']],
] as const) {
  test(`sibling roots in a ${form} callback stay elements and round-trip`, () => {
    const source = `{${expression}}\n`;
    const loop = loopIn(source);
    assert.deepEqual(names(loop.children), expected);
    assert.equal(serializePage(modelOf(source)), source);
  });
}

test('a written comma is a JavaScript sequence, not sibling roots', () => {
  const loop = loopIn('{items.map((item) => (<a />, <b />))}\n');
  // Both elements are still exposed, but as roots of code the callback owns.
  assert.ok(loop.bodyParts !== undefined);
  assert.equal(loop.bodyParts.length, 3);
  assert.match(loop.bodyParts[1] ?? '', /,/);
});

test('a loop serialized with one to four children reads back with the same children', () => {
  const source = '<div>{items.map((item) => (<img />))}</div>\n';
  const model = modelOf(source);
  const wrapper = model.nodes[0];
  assert.ok(wrapper?.kind === 'element');
  const base = loopIn(source);
  const template = base.children[0];
  assert.ok(template?.kind === 'element');
  const pool = ['img', 'Img', 'span', 'Card'] as const;
  for (let count = 1; count <= pool.length; count++) {
    const children: ParserNode[] = pool.slice(0, count).map((name, index) => ({ ...template, id: `sibling-${index}`, name }));
    const written = serializePage({ ...model, nodes: [{ ...wrapper, children: [{ ...base, children }] }] });
    assert.deepEqual(names(loopIn(written).children), pool.slice(0, count), written);
  }
});
