// Goal: the panel never crowns a rule that does not produce the value the page uses. Given the
// browser's own answer for a property, the resolved style is confirmed, corrected (another listed
// rule is crowned and every loser says why) or marked as an unlisted used value.
// Method: the owner's structure through the panel's real parser, matcher and resolver: three
// `h3 { margin-top }` rules in three stylesheets that a `global.css` imports in an order that
// differs from their alphabetical one. The ranking is run with the files listed alphabetically
// (the old order, where the 20px rule is crowned) and in import order; then the browser's answer
// is applied, including an answer no listed rule explains, and a value that matches only by text.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const bundle = path.join(directory, 'cascade-truth.bundle.js');
esbuild.buildSync({
  stdin: {
    contents: [
      "export { collectRules } from './src/features/style/model/css';",
      "export { parseRegion } from './src/features/style/model/cssRegions';",
      "export { computeRuleModel } from './src/features/style/model/cascade';",
      "export { resolveStyle } from './src/features/style/model/resolved';",
      "export { applyCascadeTruth, sameDeclaredValue, sameSelector } from './src/features/style/model/cascadeTruth';",
      "export { orderByImports } from './src/features/style/model/cssImportOrder';",
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

const FILES = [
  { path: '/p/src/styles/base.css', code: 'h3 { margin-top: 0; }' },
  { path: '/p/src/styles/global.css', code: '@import "./live/webflow-shared.css";\n@import "./base.css";\n@import "./live/shared.css";' },
  { path: '/p/src/styles/live/shared.css', code: 'h3 { margin-top: 0; }' },
  { path: '/p/src/styles/live/webflow-shared.css', code: 'h3 { margin-top: 20px; }' },
];

async function resolved(files) {
  const order = { n: 0 };
  const rules = files.flatMap((file) => {
    const region = model.parseRegion({ start: 0, end: file.code.length, css: file.code, root: undefined });
    return model.collectRules(region, {
      embedKey: `file:${file.path}`,
      embedLabel: file.path,
      fromComponent: false,
      componentName: undefined,
      regionIndex: 0,
      idSeed: file.path,
      order,
    });
  });
  const domMatched = new Map([['h3', true]]);
  const ruleModel = await model.computeRuleModel(rules, { rootKey: 'root', view: undefined, domMatched });
  return model.resolveStyle(ruleModel, '', 'h3');
}

const origin = (selector, value, order) => ({ selector, value, important: false, conditions: [], order });

test('listed alphabetically the 20px rule is crowned, in import order the last 0 is', async () => {
  const alphabetical = [...FILES].sort((left, right) => left.path.localeCompare(right.path));
  const wrong = await resolved(alphabetical.filter((file) => !file.path.endsWith('global.css')));
  assert.equal(wrong.props.get('margin-top').winner.value, '20px');
  const placed = model.orderByImports(FILES);
  const ordered = placed.map((placement) => FILES.find((file) => file.path === placement.path));
  const right = await resolved(ordered.filter((file) => !file.path.endsWith('global.css')));
  assert.equal(right.props.get('margin-top').winner.value, '0');
  assert.match(right.props.get('margin-top').winner.embedKey, /live\/shared\.css$/);
});

test('the browser confirms the listed winner, and every loser says why it lost', async () => {
  const style = await resolved([FILES[3], FILES[0], FILES[2]]);
  const truth = new Map([
    ['margin-top', { used: '0px', winner: origin('h3', '0px', 3), candidates: [origin('h3', '20px', 1), origin('h3', '0px', 2), origin('h3', '0px', 3)] }],
  ]);
  const next = model.applyCascadeTruth(style, truth).props.get('margin-top');
  assert.equal(next.winner.value, '0');
  assert.equal(next.contributors.filter((contributor) => contributor.winning).length, 1);
  const losers = next.contributors.filter((contributor) => !contributor.winning);
  assert.deepEqual(
    losers.map((contributor) => [contributor.value, contributor.lossReason]),
    [
      ['0', 'order'],
      ['20px', 'order'],
    ],
  );
});

test('a wrongly crowned rule is corrected from the browser order', async () => {
  const wrongOrder = await resolved([FILES[0], FILES[2], FILES[3]]);
  assert.equal(wrongOrder.props.get('margin-top').winner.value, '20px');
  const truth = new Map([
    ['margin-top', { used: '0px', winner: origin('h3', '0px', 3), candidates: [origin('h3', '20px', 1), origin('h3', '0px', 2), origin('h3', '0px', 3)] }],
  ]);
  const next = model.applyCascadeTruth(wrongOrder, truth).props.get('margin-top');
  assert.equal(next.winner.value, '0');
  assert.equal(next.contributors.find((contributor) => contributor.winning).order, 3);
  assert.equal(next.contributors.filter((contributor) => contributor.value === '20px')[0].lossReason, 'order');
});

test('a used value no listed rule explains is shown as such, and no listed rule is crowned', async () => {
  const style = await resolved([FILES[3], FILES[0], FILES[2]]);
  const truth = new Map([['margin-top', { used: '13px', winner: origin('.script', '13px', 9), candidates: [origin('.script', '13px', 9)] }]]);
  const next = model.applyCascadeTruth(style, truth).props.get('margin-top');
  assert.equal(next.winner.origin, 'browser');
  assert.equal(next.winner.value, '13px');
  assert.equal(next.contributors.filter((contributor) => contributor.winning).length, 1);
  assert.ok(next.contributors.filter((contributor) => contributor.origin !== 'browser').every((contributor) => contributor.lossReason === 'other'));
});

test('a property the page did not answer for keeps the panel reading, and equal text counts as confirmed', async () => {
  const style = await resolved([FILES[3], FILES[0], FILES[2]]);
  assert.equal(model.applyCascadeTruth(style, new Map()), style);
  const same = new Map([['margin-top', { used: '0px', winner: origin('some, other, list', '0px', 2), candidates: [] }]]);
  assert.equal(model.applyCascadeTruth(style, same).props.get('margin-top').winner.origin, 'embed');
});

test('declared values and selectors compare the way the browser spells them', () => {
  assert.ok(model.sameDeclaredValue('0', '0px'));
  assert.ok(model.sameDeclaredValue('0 auto', '0px auto'));
  assert.ok(model.sameDeclaredValue('VAR(--a)', 'var(--a)'));
  assert.ok(!model.sameDeclaredValue('1px', '2px'));
  assert.ok(model.sameSelector('h3', 'h1, h2, h3'));
  assert.ok(model.sameSelector('a[href=x]', 'a[href="x"]'));
  assert.ok(!model.sameSelector('h3', 'h4'));
});
