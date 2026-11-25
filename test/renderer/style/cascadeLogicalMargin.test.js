// Goal: the Style panel shows the cascade winner for a side the spacing box draws,
// also when the winner sets it through a logical property. `.margin-block-8 {
// margin-block: 2rem }` sets the top and bottom margins, so it must beat an earlier
// `.heading { margin-top: var(--_margin-top) }` of equal specificity, as the browser
// does; before, the box read the physical `margin-top` only and kept showing the
// loser. The same test pins the grid case that was reported beside it: with
// `.grid` and `.grid.autofit` both setting grid-template-columns, the winner for
// the element is the later, equally specific nested rule, and the selected chip
// keeps its own value.
// Method: the real parser (parseRegion, collectRules), cascade (computeRuleModel)
// and resolver (resolveStyle), bundled as the panel loads them. Negative space: a
// value with too many parts reads no side, a vertical-only rule leaves the
// horizontal sides alone, and a later physical longhand still beats an earlier
// logical shorthand.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const bundle = path.join(directory, 'cascade-logical-margin.bundle.js');
esbuild.buildSync({
  stdin: {
    contents: [
      "export { parseRegion } from './src/features/style/model/cssRegions';",
      "export { collectRules } from './src/features/style/model/css';",
      "export { computeRuleModel } from './src/features/style/model/cascade';",
      "export { resolveStyle } from './src/features/style/model/resolved';",
      "export { spacingSides } from './src/features/style/model/spacingShorthand';",
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
const model = require(bundle);

// The picked selector's resolved style over `css`, for an element every selector of the sheet matches.
async function resolve(css, activeSelector) {
  const region = model.parseRegion({ start: 0, end: css.length, css, root: undefined });
  const rules = model.collectRules(region, {
    embedKey: 'file:/site.css',
    embedLabel: 'site.css',
    fromComponent: false,
    componentName: undefined,
    regionIndex: 0,
    idSeed: 'site',
    order: { n: 0 },
  });
  const domMatched = new Map(rules.flatMap((rule) => rule.selectors.map((selector) => [selector.text, true])));
  const ruleModel = await model.computeRuleModel(rules, { rootKey: 'root', view: undefined, domMatched });
  return model.resolveStyle(ruleModel, '', activeSelector);
}

const winnerOf = (resolved, prop) => resolved.props.get(prop)?.winner;

test('margin-block in a later rule beats an earlier margin-top, as the browser ranks them', async () => {
  const css = '.heading { margin-top: var(--_margin-top) } .margin-block-8 { margin-block: 2rem }';
  for (const active of ['.margin-block-8', '.heading']) {
    const resolved = await resolve(css, active);
    assert.equal(winnerOf(resolved, 'margin-top')?.value, '2rem', `${active}: top`);
    assert.equal(winnerOf(resolved, 'margin-top')?.selectorText, '.margin-block-8', `${active}: top rule`);
    assert.equal(winnerOf(resolved, 'margin-bottom')?.value, '2rem', `${active}: bottom`);
  }
});

test('a rule only reaches the sides its logical property names', async () => {
  const resolved = await resolve('.a { margin-block: 1rem 2rem; margin-inline-start: 3px; padding-inline-end: 4px }', '.a');
  assert.equal(winnerOf(resolved, 'margin-top')?.value, '1rem');
  assert.equal(winnerOf(resolved, 'margin-bottom')?.value, '2rem');
  assert.equal(winnerOf(resolved, 'margin-left')?.value, '3px');
  assert.equal(winnerOf(resolved, 'margin-right'), undefined);
  assert.equal(winnerOf(resolved, 'padding-right')?.value, '4px');
  assert.equal(winnerOf(resolved, 'padding-left'), undefined);
});

test('a later physical longhand still beats an earlier logical shorthand', async () => {
  const resolved = await resolve('.a { margin-block: 1rem } .a { margin-top: 5px }', '.a');
  assert.equal(winnerOf(resolved, 'margin-top')?.value, '5px');
  assert.equal(winnerOf(resolved, 'margin-bottom')?.value, '1rem');
});

test('a logical value with too many parts reads no side', () => {
  assert.equal(model.spacingSides('margin-block', '1px 2px 3px').size, 0);
  assert.equal(model.spacingSides('margin-inline-start', '1px 2px').size, 0);
  assert.deepEqual(
    [...model.spacingSides('margin-inline', '1px 2px')],
    [
      ['margin-left', '1px'],
      ['margin-right', '2px'],
    ],
  );
});

test('the losing declaration of a side says which rule beat it', async () => {
  const resolved = await resolve('.heading { margin-top: 1px } .margin-block-8 { margin-block: 2rem }', '.heading');
  const heading = resolved.props.get('margin-top')?.contributors.find((contributor) => contributor.selectorText === '.heading');
  assert.equal(heading?.winning, false);
});

const GRID = `.grid { grid-template-columns: repeat(var(--_cols), minmax(0, 1fr));
  &:is(.autofit, .autofill) { --_track: 12rem }
  &.autofit { grid-template-columns: repeat(auto-fit, minmax(var(--_track), 1fr)) } }`;

test('grid columns: the element shows the nested rule that wins, each chip its own value', async () => {
  const combo = await resolve(GRID, '.grid.autofit');
  assert.equal(winnerOf(combo, 'grid-template-columns')?.selectorText, '.grid.autofit');
  assert.equal(combo.props.get('grid-template-columns')?.selectedValue?.value, 'repeat(auto-fit, minmax(var(--_track), 1fr))');
  const plain = await resolve(GRID, '.grid');
  assert.equal(plain.props.get('grid-template-columns')?.selectedValue?.value, 'repeat(var(--_cols), minmax(0, 1fr))');
  assert.equal(winnerOf(plain, 'grid-template-columns')?.selectorText, '.grid.autofit');
  assert.equal(plain.props.get('grid-template-columns')?.overridden, true);
});
