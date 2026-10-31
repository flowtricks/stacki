// Goal: every inline callback syntax exposes its markup without changing code.
// Method: round-trip callback variants and the reported renderer, compile their
// marked previews, and apply a real attribute intent within an early return.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transform } from '@astrojs/compiler';
import { transform as transformModern } from '@astrojs/compiler-rs';
import { transform as compileJavaScript } from 'esbuild';
import { parsePage, serializePage, serializePageMarked } from '#dist/electron/parse/astroParser.js';
import { parsePageResult, parsePageNode } from '#dist/shared/page/pageNode.js';
import type { ParserNode } from '#dist/electron/parse/astroParserTypes.js';
import { LIMITS } from '#dist/shared/core/limits.js';
import { toFilePath, toIntentId } from '#dist/shared/core/brand.js';
import { encodeUtf8, decodeUtf8 } from '#dist/shared/core/span.js';
import { toIntent } from '#dist/shared/engine/intent.js';
import { planIntent } from '#dist/shared/engine/planner.js';
import { applySplices } from '#dist/shared/engine/splice.js';
import { snapshotOf } from '../../simulator/project.ts';
import { anchorAt } from '../../simulator/oracleIntent.ts';

const nativeNodes = readFileSync('test/fixtures/editor-core/native-nodes.astro', 'utf8');
const jsonNull: unknown = JSON.parse('null');

function parsed(source: string) {
  const result = parsePage(source, { locs: true });
  assert.ok(result.editable);
  assert.equal(parsePageResult(result).editable, true);
  assert.equal(result.model.nodes[0]?.kind, 'map');
  return result.model;
}

function tags(nodes: readonly ParserNode[], depth = 0): readonly ParserNode[] {
  assert.ok(depth <= LIMITS.treeDepthMax);
  return nodes
    .flatMap((node) => [node, ...tags(node.children ?? [], depth + 1)])
    .filter((node) => node.kind === 'element' || node.kind === 'component');
}

const callbacks = [
  'item => <div>{item.name}</div>',
  '(item, index, array) => (<div>{array[index].name}</div>)',
  'async item => <div>{await item.name}</div>',
  'async (item) => { await load(item); return <div>{item.name}</div>; }',
  '({ name = choose("a", "b"), ...rest }, index = 0) => <div {...rest}>{name}</div>',
  '([first, ...rest], index) => <div>{first}{rest.length}{index}</div>',
  '(item: Item, index: number): JSX.Element => <div>{item.name}</div>',
  '<T extends Item,>(item: T) => <div>{item.name}</div>',
  'function (item) { return <div>{item.name}</div>; }',
  'function render({name}) { if (!name) return null; return <div>{name}</div>; }',
  'async function render(item) { await load(item); return <div>{item.name}</div>; }',
  '(function (item) { return <div>{this.prefix}{item.name}</div>; })',
  'item => { if (item.hidden) return null; if (item.link) return <a/>; return <div/>; }',
  'item => { switch (item.kind) { case "a": return <a/>; default: return <div/>; } }',
  'item => { try { return <div/>; } catch { return <aside/>; } finally { log(item); } }',
  'item => { const view = <div/>; return view; }',
  'item => { const view = <aside/>; return <div>{view}</div>; }',
  'item => { return item.children.map(child => <div>{child.name}</div>); }',
  'item => item.link ? <a/> : <div/>',
  'item => item.visible && <div/>',
  'item => item.view ?? <div/>',
  'item => (<div/>, item.result)',
  'item => item.visible ? (<div/> || item.fallback) : <aside/>',
  'item => { return\n<div/>; }',
  'item => [<div/>, <aside/>]',
  'item => (<><div/><aside/></>)',
  'item => { const text = "<Fake/>"; /* <Wrong/> */ return <div>{text}</div>; }',
  'item => { const pattern = /[{}<>]/; return <div>{pattern.test(item)}</div>; }',
  'async item => { return <div><!-- Astro comment --><span>{item.name}</span></div>; }',
  'async item => { const label = "🙂"; return <div>é🙂 {label}</div>; }',
  'function* (item) { yield <div>{item.name}</div>; }',
  'async function* (item) { yield <div>{await item.name}</div>; }',
] as const;

for (const method of ['map', 'flatMap']) {
  for (const callback of callbacks) {
    test(`${method} callback markup: ${callback}`, async () => {
      const source = `{items.${method}(${callback})}\n`;
      const model = parsed(source);
      assert.ok(tags(model.nodes).length > 0);
      assert.ok(tags(model.nodes).every((node) => node.name !== 'Fake' && node.name !== 'Wrong'));
      assert.equal(serializePage(model), source);
      const marked = serializePageMarked(model);
      const result = await transform(marked, { filename: '/Callback.astro' });
      assert.deepEqual(
        result.diagnostics.filter((diagnostic) => diagnostic.severity === 1),
        [],
      );
      assert.match(marked, /data-avb-p/);
      const modern = await transformModern(marked, { filename: '/Callback.astro' });
      await compileJavaScript(modern.code, { loader: 'ts' });
      for (const node of tags(model.nodes)) {
        assert.ok(node.start !== undefined);
        assert.ok(node.end !== undefined);
        assert.ok(source.slice(node.start, node.end).startsWith('<'));
      }
    });
  }
}

test('NativeNodes exposes every markup return and recursive child', async () => {
  const model = parsed(nativeNodes);
  assert.deepEqual(
    tags(model.nodes).map((node) => node.name),
    ['Fragment', 'Component', 'Tag', 'Astro.self', 'Tag', 'Tag', 'Tag', 'Astro.self'],
  );
  assert.equal(serializePage(model), nativeNodes);
  const marked = serializePageMarked(model);
  const result = await transform(marked, { filename: '/NativeNodes.astro' });
  assert.deepEqual(
    result.diagnostics.filter((diagnostic) => diagnostic.severity === 1),
    [],
  );
  assert.match(marked, /if \(!loader\) return null;/);
  assert.match(marked, /await loader\(\)/);
  const modern = await transformModern(marked, { filename: '/NativeNodes.astro' });
  await compileJavaScript(modern.code, { loader: 'ts' });
});

test('editing an early-return component changes only its source attribute', () => {
  const snapshot = snapshotOf(toFilePath('/project/NativeNodes.astro'), encodeUtf8(nativeNodes));
  const intent = toIntent({
    id: toIntentId('native-return-attribute'),
    file: snapshot.path,
    authoredChecksum: snapshot.checksum,
    anchor: anchorAt(snapshot, [0, 1]),
    operation: { tag: 'set-attribute', name: 'class', value: { type: 'string', value: 'updated' } },
  });
  const plan = planIntent({ authored: snapshot, current: snapshot }, intent);
  assert.ok(plan.ok);
  const changed = decodeUtf8(applySplices(snapshot.bytes, plan.value.splices));
  assert.ok(changed.ok);
  assert.equal(
    changed.value,
    nativeNodes.replace(
      '__cms={context.Dynamo || {}} />',
      '__cms={context.Dynamo || {}} class="updated" />',
    ),
  );
  parsed(changed.value);
});

test('call syntax and referenced or value callbacks remain loops without invented elements', () => {
  for (const expression of [
    'items.map(renderItem)',
    'items.map(renderer.render, renderer)',
    'items.map(item => item.name)',
    'items.map(item => { return null; })',
    'items . map (async item => <div/>, context)',
    'items?.map?.(item => <div/>)',
    'items["map"](item => <div/>)',
    'items.map((item => <div/>), context,)',
  ]) {
    const source = `{${expression}}\n`;
    assert.equal(serializePage(parsed(source)), source);
  }
  const broken = parsePage('{items.map(item => { return <div/>;)}');
  if (broken.editable) {
    assert.notEqual(broken.model.nodes[0]?.kind, 'map');
  }
});

test('callback code parts are validated at the page and serialization boundaries', () => {
  const node = parsed('{items.map(async item => <div/>)}').nodes[0];
  assert.ok(node?.kind === 'map');
  assert.equal(node.bodyParts?.length, 2);
  for (const bodyParts of [
    jsonNull,
    {},
    ['only one'],
    [0, 'tail'],
    ['', 'x'.repeat(LIMITS.nodeValueCharsMax + 1)],
    Array.from({ length: LIMITS.treeNodesMax + 2 }, () => ''),
  ]) {
    assert.throws(() => parsePageNode({ ...node, bodyParts }), /Map.bodyParts/);
    assert.throws(
      () =>
        serializePage({
          ...parsed('{items.map(async item => <div/>)}'),
          nodes: [{ ...node, bodyParts }],
        }),
      /Map.bodyParts/,
    );
  }
});
