// Goal: a query view shows every rule the browser applies across that query's
// whole width range, not only Base and the queries it nests inside. In a
// desktop-first component with `max-width: 70%` at Base and `80%` in
// `@media (width < 48rem)`, the phone view `@media (width < 30rem)` showed 70%
// while the page rendered 80%: the tablet query always holds below 30rem, but
// it is a sibling of the phone query, and siblings were never folded in.
// Method: real stylesheets through the panel's own parser (parseRegion,
// collectRules), cascade (computeRuleModel) and resolver (resolveStyle), the
// element matching every selector. Each case names the value shown, whether it
// is the picked selector's own (blue) or inherited (orange), and where an edit
// goes (editableRuleFor). The containment reader (queryContextImplies) is
// pinned directly for the bounds, units, media types, chains and the queries
// it must not guess at.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const bundle = path.join(directory, 'implied-query-context.bundle.js');
esbuild.buildSync({
  stdin: {
    contents: [
      "export { parseRegion } from './src/features/style/model/cssRegions';",
      "export { collectRules } from './src/features/style/model/css';",
      "export { computeRuleModel } from './src/features/style/model/cascade';",
      "export { editableRuleFor, resolveStyle, selectedRulesSetting } from './src/features/style/model/resolved';",
      "export { queryContextImplies } from './src/features/style/model/queryWidth';",
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

const PHONE = '@media (width < 30rem)';
const TABLET = '@media (width < 48rem)';

// The picked selector's resolved style over `css` in `context`, for an element every selector matches.
async function resolve(css, context, activeSelector = '.box') {
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
  const selectors = rules.flatMap((rule) => rule.selectors.map((selector) => selector.text));
  const domMatched = new Map(selectors.map((text) => [text, true]));
  const ruleModel = await model.computeRuleModel(rules, { rootKey: 'root', view: undefined, domMatched });
  return model.resolveStyle(ruleModel, context, activeSelector);
}

const shown = (resolved, prop) => resolved.props.get(prop)?.winner.value;

test('desktop-first: the phone view shows the tablet value the page renders, as inherited', async () => {
  const css = `.box { max-width: 70%; }\n${TABLET} { .box { max-width: 80%; } }\n${PHONE} { .box { color: red; } }`;
  const phone = await resolve(css, PHONE);
  const prop = phone.props.get('max-width');
  assert.equal(prop.winner.value, '80%');
  assert.equal(prop.source, 'other', 'inherited from the tablet query, never the edit target');
  assert.equal(prop.overridden, false);
  // An edit writes into the phone query's own rule; clearing touches nothing inherited.
  assert.equal(model.editableRuleFor(phone, 'max-width')?.atContext.join(' › '), PHONE);
  assert.deepEqual(model.selectedRulesSetting(phone, 'max-width'), []);
  // The phone view's own value is still blue and editable.
  assert.equal(phone.props.get('color').source, 'selected');
});

test('desktop-first: the phone view with no rule of its own still shows the tablet value, and an edit creates one', async () => {
  const css = `.box { max-width: 70%; }\n${TABLET} { .box { max-width: 80%; } }`;
  const phone = await resolve(css, PHONE);
  assert.equal(shown(phone, 'max-width'), '80%');
  assert.equal(phone.props.get('max-width').source, 'other');
  assert.equal(model.editableRuleFor(phone, 'max-width'), undefined, 'the edit creates a rule in the phone query');
  assert.equal(phone.selectedRules.size, 0, 'the tablet rule is never the target');
});

test('desktop-first: a phone override written after the tablet one wins, and is the selected value', async () => {
  const css = `.box { max-width: 70%; }\n${TABLET} { .box { max-width: 80%; } }\n${PHONE} { .box { max-width: 90%; } }`;
  const phone = await resolve(css, PHONE);
  const prop = phone.props.get('max-width');
  assert.equal(prop.winner.value, '90%');
  assert.equal(prop.source, 'selected');
  assert.equal(prop.overridden, false);
});

test('source order decides: a tablet rule written after the phone one wins in the phone view, as the browser renders it', async () => {
  const css = `.box { max-width: 70%; }\n${PHONE} { .box { max-width: 90%; } }\n${TABLET} { .box { max-width: 80%; } }`;
  const phone = await resolve(css, PHONE);
  const prop = phone.props.get('max-width');
  assert.equal(prop.winner.value, '80%');
  assert.equal(prop.source, 'selected', 'the phone value is still the one being edited');
  assert.equal(prop.overridden, true, 'and it reads as overridden by the tablet rule');
});

test('importance decides: an !important wider-query value outranks a later phone value', async () => {
  const css = `${TABLET} { .box { max-width: 80% !important; } }\n${PHONE} { .box { max-width: 90%; } }`;
  const phone = await resolve(css, PHONE);
  assert.equal(shown(phone, 'max-width'), '80%');
  assert.equal(phone.props.get('max-width').overridden, true);
});

test('the tablet view does not show the phone value: the phone query holds for only part of it', async () => {
  const css = `.box { max-width: 70%; }\n${TABLET} { .box { max-width: 80%; } }\n${PHONE} { .box { max-width: 90%; } }`;
  const tablet = await resolve(css, TABLET);
  assert.equal(shown(tablet, 'max-width'), '80%');
  assert.equal(tablet.props.get('max-width').contributors.length, 2, 'Base and the tablet rule only');
});

test('mobile-first: the desktop view shows the tablet value, the tablet view not the desktop one', async () => {
  const css = `.box { max-width: 70%; }\n@media (width >= 48rem) { .box { max-width: 80%; } }\n@media (width >= 64rem) { .box { color: red; } }`;
  const desktop = await resolve(css, '@media (width >= 64rem)');
  assert.equal(shown(desktop, 'max-width'), '80%');
  assert.equal(desktop.props.get('max-width').source, 'other');
  const tablet = await resolve(css, '@media (width >= 48rem)');
  assert.equal(tablet.props.get('color'), undefined);
});

test('a nested chain is compared per level, and an unrelated wrapper level is never guessed', async () => {
  const css = [
    `${TABLET} { .box { max-width: 80%; } }`,
    `@supports (display: grid) { ${TABLET} { .box { color: red; } } }`,
    `@supports (display: grid) { ${PHONE} { .box { padding: 1rem; } } }`,
  ].join('\n');
  const phone = await resolve(css, `@supports (display: grid) › ${PHONE}`);
  assert.equal(shown(phone, 'color'), 'red', 'same @supports level, containing width level');
  assert.equal(shown(phone, 'max-width'), undefined, 'level by level, a lone @media is not compared with @supports');
  assert.equal(phone.props.get('padding').source, 'selected');
});

test('queryContextImplies: exact bounds', () => {
  const implies = model.queryContextImplies;
  assert.equal(implies('@media (width < 30rem)', '@media (width < 48rem)'), true);
  assert.equal(implies('@media (width < 48rem)', '@media (width < 30rem)'), false);
  assert.equal(implies('@media (width < 48rem)', '@media (width <= 48rem)'), true);
  assert.equal(implies('@media (width <= 48rem)', '@media (width < 48rem)'), false, '48rem itself is outside');
  assert.equal(implies('@media (max-width: 767px)', '@media (width < 48rem)'), true, '767px < 768px');
  assert.equal(implies('@media (max-width: 768px)', '@media (width < 48rem)'), false);
  assert.equal(implies('@media (min-width: 64rem)', '@media (width > 48rem)'), true);
  assert.equal(implies('@media (width > 48rem)', '@media (min-width: 48rem)'), true);
  assert.equal(implies('@media (min-width: 48rem)', '@media (width > 48rem)'), false, '48rem itself is outside');
  assert.equal(implies('@media (30rem <= width < 48rem)', '@media (width < 64rem)'), true);
  assert.equal(implies('@media (30rem <= width < 48rem)', '@media (width >= 20rem)'), true);
  assert.equal(implies('@media (width < 48rem)', '@media (30rem <= width < 64rem)'), false, 'holds for part only');
  assert.equal(implies('@media (width < 30rem)', '@media (width >= 48rem)'), false);
});

test('queryContextImplies: media types', () => {
  const implies = model.queryContextImplies;
  assert.equal(implies('@media screen and (width < 30rem)', '@media (width < 48rem)'), true);
  assert.equal(implies('@media only screen and (width < 30rem)', '@media screen and (width < 48rem)'), true);
  assert.equal(implies('@media (width < 30rem)', '@media screen and (width < 48rem)'), false, 'print is not screen');
  assert.equal(implies('@media print and (width < 30rem)', '@media (width < 48rem)'), false, 'unread type: not guessed');
});

test('queryContextImplies: nothing unmeasurable is guessed', () => {
  const implies = model.queryContextImplies;
  for (const outer of [
    '@media (width < 48em)',
    '@media (width < 48rem), print',
    '@media (width < 48rem) or (hover: hover)',
    '@media not (width < 48rem)',
    '@media (hover: hover) and (width < 48rem)',
    '@media (height < 48rem)',
    '@media (orientation: portrait)',
    '@supports (display: grid)',
  ]) {
    assert.equal(implies('@media (width < 30rem)', outer), false, outer);
    assert.equal(implies(outer, '@media (width < 64rem)'), false, `${outer} as the view`);
  }
  assert.equal(implies('@media (width > 48rem) and (width < 30rem)', '@media (width < 10rem)'), false, 'an empty view proves nothing');
});

test('queryContextImplies: containers only within the same name and unit', () => {
  const implies = model.queryContextImplies;
  assert.equal(implies('@container card (width < 20rem)', '@container card (width < 30rem)'), true);
  assert.equal(implies('@container (width < 20rem)', '@container (width < 30rem)'), true);
  assert.equal(implies('@container card (width < 20rem)', '@container hero (width < 30rem)'), false, 'another container');
  assert.equal(implies('@container card (width < 20rem)', '@container (width < 30rem)'), false, 'a named and an unnamed container');
  assert.equal(implies('@container card (width < 300px)', '@container card (width < 30rem)'), false, 'rem is the page root size there');
  assert.equal(implies('@container card (width < 20rem)', '@media (width < 30rem)'), false);
});

test('queryContextImplies: chains', () => {
  const implies = model.queryContextImplies;
  assert.equal(implies(PHONE, ''), true, 'Base always holds');
  assert.equal(implies(`@supports (display: grid) › ${PHONE}`, '@supports (display: grid)'), true, 'an ancestor');
  assert.equal(implies(`@supports (display: grid) › ${PHONE}`, `@supports (display: grid) › ${TABLET}`), true);
  assert.equal(implies(`@supports (display: flex) › ${PHONE}`, `@supports (display: grid) › ${TABLET}`), false);
  assert.equal(implies(PHONE, `${PHONE} › @supports (display: grid)`), false, 'a deeper chain adds a condition');
  assert.equal(implies(PHONE, PHONE), true);
});
