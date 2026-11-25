// Goal: flatMap callbacks expose real navigator elements without changing their JavaScript.
// Method: round-trip nested cards, compile marked previews with both Astro compilers,
// and apply a source-preserving attribute intent to a card inside the callback.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transform } from '@astrojs/compiler';
import { transform as transformModern } from '@astrojs/compiler-rs';
import { transform as compileJavaScript } from 'esbuild';
import { parsePage, serializePage, serializePageMarked } from '#dist/electron/parse/astroParser.js';
import { parsePageResult } from '#dist/shared/page/pageNode.js';
import { toFilePath, toIntentId } from '#dist/shared/core/brand.js';
import { encodeUtf8, decodeUtf8 } from '#dist/shared/core/span.js';
import { toIntent } from '#dist/shared/engine/intent.js';
import { planIntent } from '#dist/shared/engine/planner.js';
import { applySplices } from '#dist/shared/engine/splice.js';
import { snapshotOf } from '../../simulator/project.ts';
import { anchorAt } from '../../simulator/oracleIntent.ts';

const cards = `{groups.flatMap((group) => group.cards.map((card) => (
  <div class="featured_slider_card_wrap swiper-slide"
    data-show-only={group.campuses.length ? group.campuses.join(",") : undefined}>
    <div data-trigger="hover focus" class="featured_slider_card_element">
      <h2 class="featured_slider_card_title text-style-h6">{card.title}</h2>
      <p class="featured_slider_card_text text-style-small">
        <span class="featured_slider_card_span">{card.action}</span>
        <svg viewBox="0 0 9 15"><path d="M0 0" fill="currentColor" /></svg>
      </p>
      <a href={card.href} aria-label={card.title} class="clickable_link cover-absolute" />
    </div>
  </div>
)))}\n`;

function cardModel(source: string) {
  const parsed = parsePage(source, { locs: true });
  assert.ok(parsed.editable);
  assert.equal(parsePageResult(parsed).editable, true);
  const loop = parsed.model.nodes[0];
  assert.equal(loop?.kind, 'map');
  assert.ok(loop?.bodyParts);
  assert.equal(loop.children[0]?.name, 'div');
  assert.equal(loop.children[0]?.children?.[0]?.children?.[0]?.name, 'h2');
  return parsed.model;
}

test('nested flatMap cards retain editable elements, source and preview syntax', async () => {
  const model = cardModel(cards);
  assert.equal(serializePage(model), cards);
  const marked = serializePageMarked(model);
  assert.match(marked, /data-avb-p/);
  assert.match(marked, /groups\.flatMap/);
  assert.match(marked, /group\.cards\.map/);
  const legacy = await transform(marked, { filename: '/FeaturedSlider.astro' });
  assert.deepEqual(
    legacy.diagnostics.filter((diagnostic) => diagnostic.severity === 1),
    [],
  );
  const modern = await transformModern(marked, { filename: '/FeaturedSlider.astro' });
  await compileJavaScript(modern.code, { loader: 'ts' });
});

test('editing a nested card preserves both callback scopes and all unrelated source', () => {
  cardModel(cards);
  const snapshot = snapshotOf(toFilePath('/project/FeaturedSlider.astro'), encodeUtf8(cards));
  const intent = toIntent({
    id: toIntentId('flat-map-card-class'),
    file: snapshot.path,
    authoredChecksum: snapshot.checksum,
    anchor: anchorAt(snapshot, [0, 0]),
    operation: { tag: 'set-attribute', name: 'class', value: { type: 'string', value: 'updated' } },
  });
  const plan = planIntent({ authored: snapshot, current: snapshot }, intent);
  assert.ok(plan.ok);
  const changed = decodeUtf8(applySplices(snapshot.bytes, plan.value.splices));
  assert.ok(changed.ok);
  assert.equal(changed.value, cards.replace('featured_slider_card_wrap swiper-slide', 'updated'));
  cardModel(changed.value);
});

test('unrelated method names and invalid callbacks are not accepted as loops', () => {
  for (const expression of [
    'items.flatmap(item => <div/>)',
    'items.flatMapper(item => <div/>)',
    'items[method](item => <div/>)',
    'items.flatMap(item => { return <div/>;)',
    'items.flatMap()',
  ]) {
    const parsed = parsePage(`{${expression}}`);
    if (parsed.editable) {
      assert.notEqual(parsed.model.nodes[0]?.kind, 'map');
    }
  }
});

test('flatMap access variants and callback references retain their exact call syntax', () => {
  for (const expression of [
    'items.flatMap(renderItem)',
    'items.flatMap(renderer.render, renderer)',
    'items.flatMap(item => item.name)',
    'items . flatMap (item => <div/>, context)',
    'items?.flatMap?.(item => <div/>)',
    'items["flatMap"](item => <div/>)',
    "items['flatMap'](item => <div/>)",
    'items.flatMap((item => <div/>), context,)',
    'items.map(select).flatMap(item => <div/>)',
    'items.flatMap(item => item.children.flatMap(child => <div>{child.name}</div>))',
  ]) {
    const source = `{${expression}}\n`;
    const parsed = parsePage(source, { locs: true });
    assert.ok(parsed.editable);
    const loop = parsed.model.nodes[0];
    assert.equal(loop?.kind, 'map');
    assert.ok(loop?.bodyParts);
    assert.equal(serializePage(parsed.model), source);
  }
});
