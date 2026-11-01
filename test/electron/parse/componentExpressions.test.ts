// Goal: complex JavaScript props never hide native components in the navigator.
// Method: parse the reported docs page and hostile lexical boundaries, verify
// native nodes and exact source spans, then round-trip and compile marked output.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parsePage, parseTemplate, serializePage, serializePageMarked } from '#dist/electron/parse/astroParser.js';
import { parsePageResult } from '#dist/shared/page/pageNode.js';
import { LIMITS } from '#dist/shared/core/limits.js';
import type { ParserNode } from '#dist/electron/parse/astroParserTypes.js';

import { toFilePath, toIntentId } from '#dist/shared/core/brand.js';
import { decodeUtf8, encodeUtf8 } from '#dist/shared/core/span.js';
import { toIntent } from '#dist/shared/engine/intent.js';
import { planIntent } from '#dist/shared/engine/planner.js';
import { applySplices } from '#dist/shared/engine/splice.js';
import { anchorAt } from '../../simulator/oracleIntent.ts';
import { snapshotOf } from '../../simulator/project.ts';

const docs = readFileSync('test/fixtures/editor-core/docs-conditional.astro', 'utf8');

function nativeNodes(nodes: readonly ParserNode[], depth = 0): readonly ParserNode[] {
  assert.ok(depth <= LIMITS.treeDepthMax);
  return nodes.flatMap((node) => [node, ...nativeNodes(node.children ?? [], depth + 1)]);
}

function parsed(source: string) {
  const result = parsePage(source, { locs: true });
  assert.equal(result.editable, true);
  assert.ok(result.editable);
  assert.equal(parsePageResult(result).editable, true);
  return result.model;
}

test('the full docs conditional exposes both layouts and all nested components', () => {
  const model = parsed(docs);
  assert.equal(model.nodes[0]?.kind, 'cond');
  const nodes = nativeNodes(model.nodes);
  const components = nodes.filter((node) => node.kind === 'component');
  assert.deepEqual(
    components.map((node) => node.name),
    ['DocsShell', 'Content', 'DocsLayout', 'Operation', 'Webhook', 'Content'],
  );
  for (const node of components) {
    assert.ok(node.start !== undefined);
    assert.ok(node.end !== undefined);
    assert.ok(docs.slice(node.start, node.end).startsWith(`<${node.name}`));
  }
  assert.equal(serializePage(model), docs);
  const layout = components.find((node) => node.name === 'DocsLayout');
  assert.ok(layout);
  assert.equal(layout.props?.['markdown']?.type, 'expr');
  const markdownSpan = layout.attrSpans?.find((attribute) => attribute.name === 'markdown');
  assert.ok(markdownSpan?.type === 'expr');
  const value = layout.props?.['markdown'];
  assert.ok(value?.type === 'expr');
  assert.equal(docs.slice(markdownSpan.valueSpan.start, markdownSpan.valueSpan.end), value.value);
});

const propExpressions = [
  '{ outer: { inner: { label: "}" } } }',
  '`outer ${items.map(item => `${item.name}: ${`${item.value}`}`).join("\\n")}`',
  'content.replace(/[{}()<>?/:]/g, "")',
  'content.replace(/}\\/\\//, "")',
  'a / b / c',
  '(value) => value > 0 ? { nested: { value } } : undefined',
  '/* } > ? : */ ({ nested: { value: true } })',
  '"</Card><Fake />"',
] as const;

for (const expression of propExpressions) {
  test(`components survive prop expression ${expression}`, () => {
    const source = `{ready ? (<Card value={${expression}}><Child /></Card>) : (<Other />)}\n`;
    const model = parsed(source);
    assert.equal(model.nodes[0]?.kind, 'cond');
    const card = nativeNodes(model.nodes).find((node) => node.name === 'Card');
    assert.ok(card);
    assert.deepEqual(card.props?.['value'], { type: 'expr', value: expression });
    assert.equal(serializePage(model), source);
    const spread = parsed(`{ready && <Card {...${expression}}><Child /></Card>}\n`);
    assert.equal(spread.nodes[0]?.kind, 'cond');
  });
}

test('deep props are bounded by source size rather than a fixed object nesting pattern', () => {
  const value = '{ child: '.repeat(100) + 'true' + ' }'.repeat(100);
  const model = parsed(`{ready && <Card value={${value}} />}`);
  assert.equal(model.nodes[0]?.kind, 'cond');
  assert.equal(parseTemplate('<Card value={{ nested: true } />').clean, false);
  const templates = '`x ${'.repeat(LIMITS.treeDepthMax + 1) + 'value' + '}`'.repeat(65);
  assert.doesNotThrow(() => parsePage(`{ready && <Card value={${templates}} />}`));
  assert.equal(parsed('<Card />').nodes[0]?.kind, 'component');
});

test('marked docs components and their conditions compile with the Astro compiler', async () => {
  const { transform } = await import('@astrojs/compiler');
  const output = serializePageMarked(parsed(docs));
  assert.match(output, /<DocsShell[\s\S]*avb-s:/);
  assert.match(output, /<DocsLayout[\s\S]*avb-s:/);
  const result = await transform(output, { filename: '/Docs.astro' });
  assert.deepEqual(
    result.diagnostics.filter((diagnostic) => diagnostic.severity === 1),
    [],
  );
});

test('editing a nested native component preserves every surrounding JavaScript byte', () => {
  const snapshot = snapshotOf(toFilePath('/project/docs.astro'), encodeUtf8(docs));
  const intent = toIntent({
    id: toIntentId('docs-native-component'),
    file: snapshot.path,
    authoredChecksum: snapshot.checksum,
    anchor: anchorAt(snapshot, [0, 0, 0, 0]),
    operation: {
      tag: 'set-attribute',
      name: 'class',
      value: { type: 'string', value: 'examples_updated' },
    },
  });
  const plan = planIntent({ authored: snapshot, current: snapshot }, intent);
  assert.ok(plan.ok);
  const changed = decodeUtf8(applySplices(snapshot.bytes, plan.value.splices));
  assert.ok(changed.ok);
  assert.equal(changed.value, docs.replace('class="examples_wrap"', 'class="examples_updated"'));
  assert.equal(parsed(changed.value).nodes[0]?.kind, 'cond');
});
