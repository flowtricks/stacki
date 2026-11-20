// Goal: Create component's "Move styles" lists the classes of the extracted markup that have CSS, says
// where that CSS is, and offers checked only the classes nothing else uses: a custom class is moved by
// default, a shared class is offered unchecked, and a utility is never offered.
// Method: hand-built page nodes and CSS sources (a stylesheet and the page's own <style>), run through
// the real paste rule, with the Style panel's utility rule (`u-`). The negative space: a utility used only
// here, a rule that also needs a class outside the markup, a rule on bare tags, a class without CSS, a
// class on another element of the page, a class another file names, and a class main could not answer for.
// The moved rules' layout in the new tag (tagIndentedRules, templateRulesDepth) is pinned byte for byte against the
// Style panel's Create <style> layout (newStyleTagLayout.test.js), from sources indented with spaces and with tabs,
// nested and starting one level in, with the bad depths that must throw.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { moveStyleCandidates, movableSheets, classesOutside, tagIndentedRules, templateRulesDepth } = load('src/editor/componentStyles.ts');
const { isUtilityClassName } = load('src/features/style/model/defaultSelector.ts');

const element = (id, classes, children = []) => ({
  id,
  kind: 'element',
  name: 'div',
  props: classes === '' ? {} : { class: { type: 'string', value: classes } },
  children,
});

// The card that becomes a component, and the page around it.
const card = element('card', 'card centered u-gap', [element('title', 'card_title'), element('note', 'plain')]);
const page = [element('header', 'site-header centered'), card];
const stylesheet = (rel, css) => ({ home: { kind: 'stylesheet', rel }, styles: [{ css, scope: 'global', defineVars: undefined }] });
const pageStyles = (css) => ({ home: { kind: 'page' }, styles: [{ css, scope: 'global', defineVars: undefined }] });
const noOtherFiles = (names) => ({ classes: names.map((name) => ({ name, files: [] })) });
const ALL = ['card', 'card_title', 'centered', 'plain', 'u-gap'];

test('custom classes are offered checked with every place their CSS is; a shared class unchecked', () => {
  const sources = [
    stylesheet('src/styles/base.css', '.card { padding: 1rem; } .centered { text-align: center; } h3 { margin: 0; }'),
    pageStyles('.card .card_title { font-weight: 700; } @media (width > 40em) { .card { padding: 2rem; } }'),
  ];
  const candidates = moveStyleCandidates(card, sources, classesOutside(page, 'card'), noOtherFiles(ALL), isUtilityClassName);
  assert.deepEqual(
    candidates.map((candidate) => [candidate.name, candidate.homes.map((home) => home.rel ?? home.kind), candidate.checked]),
    [
      ['card', ['src/styles/base.css', 'page'], true],
      ['card_title', ['page'], true],
      ['centered', ['src/styles/base.css'], false],
    ],
  );
  assert.deepEqual(candidates[2].reach, { kind: 'page' }, 'centered is also on the page header');
});

test('a utility is never offered, even when only this markup uses it', () => {
  const sources = [stylesheet('src/styles/utilities.css', '.u-gap { gap: 1rem; } .card.u-gap { gap: 2rem; }')];
  const candidates = moveStyleCandidates(card, sources, classesOutside(page, 'card'), noOtherFiles(ALL), isUtilityClassName);
  assert.deepEqual(
    candidates.map((candidate) => candidate.name),
    ['card'],
    'the rule naming both offers .card alone',
  );
});

test('a locked stylesheet keeps its rules, whatever its classes are called; the page’s <style> is never locked', () => {
  const { stylesheetLockMatcher } = load('shared/properties/styleKeepList.ts');
  const keepList = { version: 1, keep: [], lockedStylesheets: ['src/styles/utilities.css', 'src/styles/framework/'] };
  const sheets = [
    { rel: 'src/styles/utilities.css', css: '.text-center { text-align: center; }' },
    { rel: 'src/styles/framework/grid.css', css: '.card { display: grid; }' },
    { rel: 'src/styles/base.css', css: '.card { padding: 1rem; }' },
  ];
  const movable = movableSheets(sheets, stylesheetLockMatcher(keepList));
  assert.deepEqual(
    movable.map((sheet) => sheet.rel),
    ['src/styles/base.css'],
  );
  const sources = [...movable.map((sheet) => stylesheet(sheet.rel, sheet.css)), pageStyles('.card_title { margin: 0; }')];
  const textCard = element('card', 'card text-center', [element('title', 'card_title')]);
  const candidates = moveStyleCandidates(textCard, sources, new Set(), noOtherFiles(['card', 'card_title', 'text-center']), isUtilityClassName);
  assert.deepEqual(
    candidates.map((candidate) => [candidate.name, candidate.homes.map((home) => home.rel ?? home.kind)]),
    [
      ['card', ['src/styles/base.css']],
      ['card_title', ['page']],
    ],
    'text-center is not offered, and .card is offered from base.css only',
  );
  assert.equal(movableSheets(sheets, () => false).length, sheets.length, 'nothing locked: every sheet may move');
});

test('a class another file names is offered unchecked, with those files; an unanswered class too', () => {
  const sources = [stylesheet('src/styles/base.css', '.card { padding: 1rem; } .card_title { margin: 0; }')];
  const usage = { classes: [{ name: 'card', files: ['src/pages/about.astro'] }] };
  const candidates = moveStyleCandidates(card, sources, new Set(), usage, isUtilityClassName);
  assert.deepEqual(candidates[0], {
    name: 'card',
    homes: [{ kind: 'stylesheet', rel: 'src/styles/base.css' }],
    reach: { kind: 'files', files: ['src/pages/about.astro'] },
    checked: false,
  });
  assert.equal(candidates[1].name, 'card_title');
  assert.equal(candidates[1].checked, false, 'a class main did not answer for stays where it is');
});

test('no candidate for a class without CSS, a rule that needs an outside class, or a rule on bare tags', () => {
  const sources = [stylesheet('src/styles/base.css', '.site-header .card { color: red; } h3, p { margin: 0; } .other { color: blue; }')];
  const candidates = moveStyleCandidates(card, sources, classesOutside(page, 'card'), noOtherFiles(ALL), isUtilityClassName);
  assert.deepEqual(candidates, []);
});

test('classesOutside: the page’s classes except those inside the subtree', () => {
  assert.deepEqual([...classesOutside(page, 'card')].sort(), ['centered', 'site-header']);
  assert.deepEqual([...classesOutside([card], 'card')], []);
  assert.deepEqual([...classesOutside(page, 'missing')].sort(), ['card', 'card_title', 'centered', 'plain', 'site-header', 'u-gap']);
});

test('tagIndentedRules: a stylesheet’s rule goes one tab inside the layer, its declarations two, as Create <style> writes', () => {
  const portfolio = '.portfolio {\n  display: grid;\n  grid-template-columns: repeat(3, minmax(0, 1fr));\n}';
  assert.deepEqual(tagIndentedRules([portfolio], 1), ['\t.portfolio {\n\t\tdisplay: grid;\n\t\tgrid-template-columns: repeat(3, minmax(0, 1fr));\n\t}']);
  assert.deepEqual(tagIndentedRules([portfolio], 0), ['.portfolio {\n\tdisplay: grid;\n\tgrid-template-columns: repeat(3, minmax(0, 1fr));\n}'], 'no wrapper');
});

test('tagIndentedRules: nesting, a four-space step, a rule read one level in, and blank lines', () => {
  const media = '@media (width < 48rem) {\n    .card {\n        gap: 1rem;\n    }\n}';
  assert.deepEqual(tagIndentedRules([media], 1), ['\t@media (width < 48rem) {\n\t\t.card {\n\t\t\tgap: 1rem;\n\t\t}\n\t}'], 'four spaces are one level');
  const fromPageStyle = '\t.card {\n\t\tcolor: red;\n\n\t\tgap: 1rem;\n\t}';
  assert.deepEqual(tagIndentedRules([fromPageStyle], 1), ['\t.card {\n\t\tcolor: red;\n\n\t\tgap: 1rem;\n\t}'], 'a rule read one level in starts at the depth');
  assert.deepEqual(
    tagIndentedRules(['.a { color: red; }', '.b {\n  gap: 0;\n}'], 1),
    ['\t.a { color: red; }', '\t.b {\n\t\tgap: 0;\n\t}'],
    'one rule out per rule in',
  );
  assert.deepEqual(tagIndentedRules([], 1), []);
});

test('tagIndentedRules: only the indentation changes, and a bad depth is a programmer error', () => {
  const rule = '.a::after {\n  content: "  two  spaces  ";\n}';
  assert.equal(tagIndentedRules([rule], 0)[0], '.a::after {\n\tcontent: "  two  spaces  ";\n}', 'what a line says is kept byte for byte');
  assert.throws(() => tagIndentedRules([rule], -1), /tagIndentedRules: the depth is not negative/);
  assert.throws(() => tagIndentedRules([rule], 1.5), /tagIndentedRules: the depth is an integer/);
});

test('templateRulesDepth: one level inside a wrapping layer, none for no template, a plain one or a placeholder', () => {
  assert.equal(templateRulesDepth('@layer components {\n\n}'), 1);
  assert.equal(templateRulesDepth('@layer components {\n}'), 1);
  assert.equal(templateRulesDepth(''), 0);
  assert.equal(templateRulesDepth('/* Component styles */'), 0);
  assert.equal(templateRulesDepth('@layer components {\n\t/* stacki:rules */\n}'), 0, 'the placeholder’s line carries its own indent');
});
