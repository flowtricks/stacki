// Goal: the panel's cascade ranks declarations the way the CSS Cascade specification does, and
// names the step at which each loser lost; and the stylesheet order follows `@import`s, not file names.
// Method: known-answer cases for every factor (importance, style attribute, layers incl. the
// important inversion, specificity incl. :where, source order, conditions), then the owner's
// structure: three `h3 { margin-top }` rules across three stylesheets where a global.css imports
// them in an order that differs from their alphabetical order. The browser-side differential
// lives in test/electron/preload/cascadeOrigins.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const bundle = path.join(directory, 'cascade-resolve.bundle.js');
esbuild.buildSync({
  stdin: {
    contents: [
      "export { rankCandidates, explainLoss, compareCandidates } from './src/features/style/model/cascadeResolve';",
      "export { LayerRegistry, compareLayerPositions } from './src/features/style/model/cascadeLayers';",
      "export { orderByImports, importsOf } from './src/features/style/model/cssImportOrder';",
      "export { collectRules } from './src/features/style/model/css';",
      "export { parseRegion } from './src/features/style/model/cssRegions';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
});
const cascade = require(bundle);

const base = { important: false, specificity: [0, 0, 1], order: 0 };
const win = (list) => cascade.rankCandidates(list)[0];

test('later source order wins an otherwise equal tie', () => {
  const earlier = { ...base, order: 1 };
  const later = { ...base, order: 2 };
  assert.equal(win([earlier, later]), later);
  assert.equal(cascade.explainLoss(earlier, later), 'order');
});

test('specificity beats order, and :where counts nothing', () => {
  const heavy = { ...base, specificity: [0, 1, 0], order: 1 };
  const light = { ...base, specificity: [0, 0, 1], order: 9 };
  const where = { ...base, specificity: [0, 0, 0], order: 9 };
  assert.equal(win([light, heavy]), heavy);
  assert.equal(cascade.explainLoss(light, heavy), 'specificity');
  assert.equal(win([where, light]), light);
});

test('importance beats specificity; the style attribute beats a rule of equal importance', () => {
  const important = { ...base, important: true };
  const id = { ...base, specificity: [1, 0, 0] };
  const inline = { ...base, inline: true, specificity: [1000000, 0, 0] };
  assert.equal(win([id, important]), important);
  assert.equal(cascade.explainLoss(id, important), 'importance');
  assert.equal(win([id, inline]), inline);
  assert.equal(win([inline, important]), important);
});

test('layers: unlayered beats layered, a later layer beats an earlier one', () => {
  const registry = new cascade.LayerRegistry();
  const early = registry.positionOf(['base']);
  const late = registry.positionOf(['theme']);
  const layeredEarly = { ...base, layer: early, specificity: [1, 0, 0] };
  const layeredLate = { ...base, layer: late };
  const unlayered = { ...base, order: 0 };
  assert.equal(win([layeredEarly, layeredLate]), layeredLate);
  assert.equal(cascade.explainLoss(layeredEarly, layeredLate), 'layer');
  assert.equal(win([layeredLate, unlayered]), unlayered);
});

test('layers: importance inverts the order, and a layered important beats an unlayered one', () => {
  const registry = new cascade.LayerRegistry();
  const early = { ...base, important: true, layer: registry.positionOf(['a']) };
  const late = { ...base, important: true, layer: registry.positionOf(['b']) };
  const plain = { ...base, important: true };
  assert.equal(win([late, early]), early);
  assert.equal(win([plain, late]), late);
});

test('a layer keeps the place its first mention gave it, and sub-layers sort inside their parent', () => {
  const registry = new cascade.LayerRegistry();
  const first = registry.positionOf(['a']);
  const second = registry.positionOf(['b']);
  const firstChild = registry.positionOf(['a', 'x']);
  assert.deepEqual(registry.positionOf(['a']), first);
  assert.ok(cascade.compareLayerPositions(second, firstChild) > 0);
  assert.ok(cascade.compareLayerPositions(first, firstChild) > 0);
});

test('a declaration whose condition does not hold ranks last', () => {
  const off = { ...base, important: true, order: 9, applies: false };
  const on = { ...base, order: 1 };
  assert.equal(win([off, on]), on);
  assert.equal(cascade.explainLoss(off, on), 'condition');
});

test('a winner is never its own loser', () => {
  const only = { ...base };
  assert.equal(cascade.explainLoss(only, only), undefined);
});

test('layers are read from @layer blocks, statements and nested names', () => {
  const css = '@layer base, theme;\n@layer theme { h3 { margin-top: 1px } }\n@layer base { h3 { margin-top: 2px } }\nh3 { margin-top: 3px }';
  const region = cascade.parseRegion({ start: 0, end: css.length, css, root: undefined });
  const rules = cascade.collectRules(region, {
    embedKey: 'k',
    embedLabel: 'k',
    fromComponent: false,
    componentName: undefined,
    regionIndex: 0,
    idSeed: 'k',
    order: { n: 0 },
  });
  const byValue = Object.fromEntries(rules.map((rule) => [rule.declarations[0].value, rule.layer]));
  assert.deepEqual(byValue['1px'], [1]);
  assert.deepEqual(byValue['2px'], [0]);
  assert.equal(byValue['3px'], undefined);
});

test('the owner structure: imports, not file names, set the order of three h3 margin-top rules', () => {
  const files = [
    { path: '/p/src/styles/base.css', code: 'h3 { margin-top: 0 }' },
    { path: '/p/src/styles/global.css', code: '@import "./live/webflow-shared.css";\n@import "./base.css";\n@import "./live/shared.css";' },
    { path: '/p/src/styles/live/shared.css', code: 'h3 { margin-top: 0 }' },
    { path: '/p/src/styles/live/webflow-shared.css', code: 'h3 { margin-top: 20px }' },
  ];
  const order = cascade.orderByImports(files).map((placement) => path.basename(placement.path));
  assert.deepEqual(order, ['webflow-shared.css', 'base.css', 'shared.css', 'global.css']);
});

test('imports: url() forms, comments, layer(), cycles and remote files', () => {
  assert.deepEqual(cascade.importsOf('/* @import "no.css"; */ @import url(a.css); @import url("b.css") layer(x.y); @import "c.css" layer;'), [
    { target: 'a.css', layer: undefined },
    { target: 'b.css', layer: 'x.y' },
    { target: 'c.css', layer: '' },
  ]);
  const cycle = cascade.orderByImports([
    { path: '/a.css', code: '@import "b.css";' },
    { path: '/b.css', code: '@import "a.css"; @import "https://x.test/r.css";' },
  ]);
  assert.equal(cycle.length, 2);
});
