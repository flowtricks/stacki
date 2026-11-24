// Goal: every Raw value and Unit finding is listed as its declaration and goes to its code. Pinned: a lone raw value in a
// `<style>` still gets its block's row (so Modal > style and Slider > style open to their one declaration, never a bare
// "style"), a stylesheet's finding reads as its declaration with its selector and line; each row has an identity that tells
// two identical declarations apart; the code target is the block's own text for a style block and the file line for a
// stylesheet, and the block line counted from an offset is right after frontmatter, markup and an earlier block; the rule's
// quick actions offer exactly the unit groups still flagged, and "Don't flag widths and heights" only when sizes are tracked
// and a size is among the findings.
// Method: bundle the pure module (src/features/audits/tokenActions.ts) with esbuild and call it on findings written here,
// and on a real .astro text split into style blocks by hand, with the negative cases beside each positive one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/token-actions.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: "export * from './src/features/audits/tokenActions';",
    resolveDir: repoPath('.'),
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
});
const { codeTarget, declarationNote, declarationUnderElement, findingRowKey, flaggedUnitGroups, holdsSizeFindings, lineAtOffset, unitGroupText } = require(
  output,
);

function raw(property, token, extra = {}) {
  return {
    id: `token-value|src/components/Select.astro|1|.form-select_field { ${property}: ${token} }`,
    check: 'token-value',
    file: 'src/components/Select.astro',
    fileKind: 'component',
    element: { path: [1], tag: 'style', line: 8 },
    detail: `.form-select_field { ${property}: ${token} }`,
    source: 'static',
    fix: undefined,
    css: { selector: '.form-select_field', property, value: token, token, line: 10, group: 'spacing', place: { tag: 'style-block', path: [1], offset: 40 } },
    ...extra,
  };
}

test('a lone raw value in a style block keeps its block row; a stylesheet finding and other findings do not', () => {
  assert.equal(declarationUnderElement(raw('padding-inline-end', '3em')), true);
  const sheet = raw('padding', '12px', { element: undefined, file: 'src/styles/utilities.css' });
  assert.equal(declarationUnderElement(sheet), false, 'no element: the declaration is the row itself');
  assert.equal(declarationUnderElement({ css: undefined, element: { path: [0], tag: 'img', line: 1 } }), false, 'a markup finding stays one row');
});

test('a declaration row says its selector and line', () => {
  assert.equal(declarationNote({ selector: '.nav_toggle', line: 42 }), '.nav_toggle · line 42');
  assert.equal(declarationNote({ selector: '.nav_toggle', line: undefined }), '.nav_toggle');
});

test('two identical declarations have different row keys; the same one keeps its key', () => {
  const first = raw('max-width', '22rem');
  const second = raw('max-width', '22rem', { css: { ...first.css, place: { tag: 'style-block', path: [1], offset: 120 } } });
  assert.equal(first.id, second.id, 'the ids collide, as in Dropdown > style');
  assert.notEqual(findingRowKey(first), findingRowKey(second));
  assert.equal(findingRowKey(first), findingRowKey(raw('max-width', '22rem')));
});

test('the code target: the block text for a style block, the file line for a stylesheet, none without a place', () => {
  assert.deepEqual(codeTarget(raw('padding', '3em')), { tag: 'style-block', path: [1], offset: 40 });
  const sheet = raw('padding', '12px', { css: { ...raw('padding', '12px').css, line: 7, place: { tag: 'stylesheet', offset: 99 } } });
  assert.deepEqual(codeTarget(sheet), { tag: 'file', line: 7 });
  assert.equal(codeTarget({ css: { ...sheet.css, line: undefined } }), undefined, 'a stylesheet finding without a line has nowhere to go');
  const inline = raw('padding', '12px');
  const { place: _place, ...withoutPlace } = inline.css;
  assert.equal(codeTarget({ css: withoutPlace }), undefined, 'an inline style="" has no code window');
  assert.equal(codeTarget({ css: undefined }), undefined);
});

test('the block line of an offset is counted in the block, whatever comes before it in the file', () => {
  const file = [
    '---',
    'const { label } = Astro.props;',
    '---',
    '<div class="a">{label}</div>',
    '<style is:global>',
    '  .a { padding: 1rem; }',
    '</style>',
    '<style is:global>',
    '  @layer components {',
    '    @supports (appearance: base-select) {',
    '      .b::before { gap: 0.5em; }',
    '    }',
    '  }',
    '</style>',
  ].join('\n');
  const blocks = [...file.matchAll(/<style is:global>([\s\S]*?)<\/style>/g)].map((match) => match[1] ?? '');
  const [first, second] = blocks;
  assert.equal(lineAtOffset(first, first.indexOf('1rem')), 2, 'the text starts with the newline after the tag');
  assert.equal(lineAtOffset(second, second.indexOf('0.5em')), 4);
  assert.equal(lineAtOffset(second, 0), 1);
  assert.equal(lineAtOffset(second, second.length + 50), lineAtOffset(second, second.length), 'past the end is the last line');
  assert.throws(() => lineAtOffset(second, -1), /non-negative offset/);
  assert.throws(() => lineAtOffset(second, 1.5), /integer offset/);
});

test('quick actions: the unit groups still flagged, and widths and heights only when tracked', () => {
  const findings = [raw('padding', '3em'), raw('gap', '0.5em'), raw('padding', '5vw'), raw('padding', '12px'), raw('width', '20rem')];
  assert.deepEqual(flaggedUnitGroups(findings, { allowedUnits: [] }), ['em', 'viewport']);
  assert.deepEqual(flaggedUnitGroups(findings, { allowedUnits: ['em'] }), ['viewport'], 'an allowed group is not offered again');
  assert.deepEqual(flaggedUnitGroups([raw('padding', '12px')], { allowedUnits: [] }), [], 'px and rem have their own switches');
  assert.deepEqual(flaggedUnitGroups([{ ...raw('padding', '3em'), check: 'token-color' }], { allowedUnits: [] }), [], 'colours are not raw sizes');
  assert.equal(holdsSizeFindings(findings), true);
  assert.equal(holdsSizeFindings([raw('MAX-INLINE-SIZE', '20rem')]), true);
  assert.equal(holdsSizeFindings([raw('padding', '20rem')]), false);
  assert.equal(unitGroupText('viewport', 'short'), 'vw, vh, vmin…');
  assert.equal(unitGroupText('viewport', 'full'), 'vw, vh, vmin, vmax, svh, dvh, lvh');
  assert.equal(unitGroupText('em', 'short'), 'em');
});
