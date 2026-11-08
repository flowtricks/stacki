// Goal: the Style panel's CSS Code editor shows a rule flush left with a tab
// per level and a closing brace at column 0, types the same way, and a
// save writes the rule back in the <style> block's own layout. A rule in an
// indented Astro <style> block used to show the file's whitespace as is
// (`.a {\n        color: red;\n    }`). The style writer's new nested rules
// had the same fault in the file: inside an indented, nested @media a new
// rule's body ran far right and its brace landed off its selector. A selector
// list spanning lines showed its later lines at the file's extra indentation
// (`h1,\n    h2,\n    p {`), because they were re-indented as body levels; they
// now sit at the rule's own level, and a save gives them the file's indentation.
// Method: the real css.ts, cssRuleText.ts and cssEditorIndent.ts are bundled
// as the app bundles them (with the CodeMirror pieces they share, so one copy
// of @codemirror/state is in play). Pages are split into <style> regions and
// rendered back; text is compared byte for byte. Typing is driven through
// CodeMirror's own state commands and an `input.type` transaction, which is
// what the editor's keymap and indentOnInput act on.
// A nested rule shows the chain it sits in, read only, and saves to the rule
// alone: those tests compare the shown text, the file after a save, and what
// CodeMirror's change filter lets through.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { ROOT } = require('../../helpers/sources.js');

const bundle = (() => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-css-rule-text-'));
  const output = path.join(directory, 'module.cjs');
  try {
    buildSync({
      stdin: {
        contents: `
          export * as css from './src/features/style/model/css';
          export * as ruleText from './src/features/style/model/cssRuleText';
          export { cssEditorIndentExtensions } from './src/features/style/components/cssEditorIndent';
          export { lockedEdgeExtensions } from './src/ui/codeEditorLockedEdges';
          export { buildCssRuleView } from './src/features/style/model/cssRuleView';
          export { ExternalChange } from '@uiw/react-codemirror';
          export { EditorState, EditorSelection } from '@codemirror/state';
          export { insertNewlineAndIndent } from '@codemirror/commands';
          export { ensureSyntaxTree } from '@codemirror/language';
        `,
        resolveDir: ROOT,
        loader: 'ts',
      },
      outfile: output,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
    });
    return require(output);
  } finally {
    delete require.cache[output];
    fs.rmSync(directory, { recursive: true, force: true });
  }
})();
const { css, ruleText } = bundle;

// The page's single <style> region, parsed.
const regionOf = (page) => {
  const { segments, regions } = css.splitEmbed(page);
  assert.equal(regions.length, 1, 'the page has one <style> region');
  return { segments, region: css.parseRegion(regions[0]) };
};

// The first rule in the region whose selector is `selector`, at any depth.
const ruleNode = (region, selector) => {
  let found;
  region.root.walkRules((rule) => {
    if (found === undefined && rule.selector === selector) {
      found = rule;
    }
  });
  assert.ok(found, `the region has a ${selector} rule`);
  return found;
};

const INDENTED_PAGE = [
  '---',
  '---',
  '<style is:global>',
  '    .hero {',
  '        color: red;',
  '    }',
  '    .text-style-h1 {',
  '        font-size: var(--h1);',
  '    }',
  '</style>',
  '',
].join('\n');

test('the editor shows a rule from an indented block flush left with a tab per level', () => {
  const { region } = regionOf(INDENTED_PAGE);
  const node = ruleNode(region, '.text-style-h1');
  assert.equal(ruleText.ruleEditorText(node), ['.text-style-h1 {', '\tfont-size: var(--h1);', '}'].join('\n'));
});

test('nested levels, tabs and blank lines map to a tab per level', () => {
  const page = ['<style>', '\t.a {', '\t\tcolor: red;', '', '\t\t&:hover {', '\t\t\tcolor: blue;', '\t\t}', '\t}', '</style>', ''].join('\n');
  const { region } = regionOf(page);
  const text = ruleText.ruleEditorText(ruleNode(region, '.a'));
  assert.equal(text, ['.a {', '\tcolor: red;', '', '\t&:hover {', '\t\tcolor: blue;', '\t}', '}'].join('\n'));
  assert.equal(ruleText.sourceTextFromEditor(text, ruleText.ruleLayout(ruleNode(region, '.a'))), ruleNode(region, '.a').toString());
});

test('a rule written flush left already reads as it is', () => {
  const page = ['<style>', '.a {', '  color: red;', '}', '</style>', ''].join('\n');
  const { region } = regionOf(page);
  assert.equal(ruleText.ruleEditorText(ruleNode(region, '.a')), ['.a {', '\tcolor: red;', '}'].join('\n'));
});

test('a saved edit goes back in the block layout and leaves the other rules alone', () => {
  const { segments, region } = regionOf(INDENTED_PAGE);
  const node = ruleNode(region, '.text-style-h1');
  const edited = ['.text-style-h1 {', '\tfont-size: var(--h1);', '\tline-height: 1.1;', '}'].join('\n');
  assert.deepEqual(css.replaceRuleCss({ node }, edited), { ok: true });
  const expected = INDENTED_PAGE.replace('        font-size: var(--h1);\n', '        font-size: var(--h1);\n        line-height: 1.1;\n');
  assert.notEqual(expected, INDENTED_PAGE, 'the expectation adds a line');
  assert.equal(css.renderEmbed(segments, [region]), expected);
});

test('an unchanged editor text writes the file back byte for byte', () => {
  const { segments, region } = regionOf(INDENTED_PAGE);
  const node = ruleNode(region, '.hero');
  assert.deepEqual(css.replaceRuleCss({ node }, ruleText.ruleEditorText(node)), { ok: true });
  assert.equal(css.renderEmbed(segments, [region]), INDENTED_PAGE);
});

// A global reset whose selector list continues four spaces past the rule's own
// line, with a two-space body: the layout the user reported.
const SELECTOR_LIST_PAGE = [
  '<style is:global>',
  '    h1,',
  '        h2,',
  '        h3,',
  '        h4,',
  '        h5,',
  '        h6,',
  '        p {',
  '      margin-block: 0;',
  '    }',
  '    .after {',
  '      color: red;',
  '    }',
  '</style>',
  '',
].join('\n');
const SELECTOR_LIST = 'h1,\n        h2,\n        h3,\n        h4,\n        h5,\n        h6,\n        p';

test('a selector list spanning lines shows every selector line flush left', () => {
  const { region } = regionOf(SELECTOR_LIST_PAGE);
  const node = ruleNode(region, SELECTOR_LIST);
  assert.equal(ruleText.ruleEditorText(node), ['h1,', 'h2,', 'h3,', 'h4,', 'h5,', 'h6,', 'p {', '\tmargin-block: 0;', '}'].join('\n'));
});

test('an unchanged multi-line selector writes the file back byte for byte', () => {
  const { segments, region } = regionOf(SELECTOR_LIST_PAGE);
  const node = ruleNode(region, SELECTOR_LIST);
  assert.deepEqual(css.replaceRuleCss({ node }, ruleText.ruleEditorText(node)), { ok: true });
  assert.equal(css.renderEmbed(segments, [region]), SELECTOR_LIST_PAGE);
});

test('editing a declaration keeps the selector lines at their source indentation', () => {
  const { segments, region } = regionOf(SELECTOR_LIST_PAGE);
  const node = ruleNode(region, SELECTOR_LIST);
  const edited = ruleText.ruleEditorText(node).replace('\tmargin-block: 0;', '\tmargin-block: 0;\n\tpadding: 0;');
  assert.deepEqual(css.replaceRuleCss({ node }, edited), { ok: true });
  const expected = SELECTOR_LIST_PAGE.replace('      margin-block: 0;\n', '      margin-block: 0;\n      padding: 0;\n');
  assert.notEqual(expected, SELECTOR_LIST_PAGE, 'the expectation adds a line');
  assert.equal(css.renderEmbed(segments, [region]), expected);
});

test('a selector line added in the editor takes the file continuation indentation', () => {
  const { segments, region } = regionOf(SELECTOR_LIST_PAGE);
  const node = ruleNode(region, SELECTOR_LIST);
  const edited = ruleText.ruleEditorText(node).replace('p {', 'p,\nli {');
  assert.deepEqual(css.replaceRuleCss({ node }, edited), { ok: true });
  assert.equal(css.renderEmbed(segments, [region]), SELECTOR_LIST_PAGE.replace('        p {\n', '        p,\n        li {\n'));
});

test('a selector list without extra indentation in the file keeps it on save', () => {
  const page = ['<style>', '  h1,', '  h2 {', '    margin: 0;', '  }', '</style>', ''].join('\n');
  const { segments, region } = regionOf(page);
  const node = ruleNode(region, 'h1,\n  h2');
  const edited = ruleText.ruleEditorText(node).replace('h2 {', 'h2,\nh3 {');
  assert.equal(edited, ['h1,', 'h2,', 'h3 {', '\tmargin: 0;', '}'].join('\n'));
  assert.deepEqual(css.replaceRuleCss({ node }, edited), { ok: true });
  assert.equal(css.renderEmbed(segments, [region]), page.replace('  h2 {\n', '  h2,\n  h3 {\n'));
});

test('a nested multi-line selector and a multi-line @media prelude sit at their own level', () => {
  const page = [
    '<style>',
    '  .card {',
    '    color: red;',
    '    h2,',
    '        h3 {',
    '      margin: 0;',
    '    }',
    '    @media (width > 40rem) and',
    '        (width < 60rem) {',
    '      color: blue;',
    '    }',
    '    grid-template-areas:',
    '      "a b"',
    '      "c d";',
    '  }',
    '</style>',
    '',
  ].join('\n');
  const { segments, region } = regionOf(page);
  const outer = ruleNode(region, '.card');
  const outerText = ruleText.ruleEditorText(outer);
  assert.equal(
    outerText,
    [
      '.card {',
      '\tcolor: red;',
      '\th2,',
      '\th3 {',
      '\t\tmargin: 0;',
      '\t}',
      '\t@media (width > 40rem) and',
      '\t(width < 60rem) {',
      '\t\tcolor: blue;',
      '\t}',
      '\tgrid-template-areas:',
      '\t\t"a b"',
      '\t\t"c d";',
      '}',
    ].join('\n'),
  );
  const inner = ruleNode(region, 'h2,\n        h3');
  assert.equal(ruleText.ruleEditorText(inner), ['h2,', 'h3 {', '\tmargin: 0;', '}'].join('\n'));
  assert.deepEqual(css.replaceRuleCss({ node: outer }, outerText), { ok: true });
  assert.equal(css.renderEmbed(segments, [region]), page, 'an unchanged outer rule writes back byte for byte');
});

test('invalid editor text is refused and the file is untouched', () => {
  const { segments, region } = regionOf(INDENTED_PAGE);
  const node = ruleNode(region, '.hero');
  const result = css.replaceRuleCss({ node }, 'color: red;');
  assert.equal(result.ok, false);
  assert.equal(css.renderEmbed(segments, [region]), INDENTED_PAGE);
});

test('a new rule in an indented, nested @media indents one step past its own line', () => {
  const page = [
    '<style>',
    '  .developer_layout {',
    '    display: grid;',
    '    @media (width < 42rem) {',
    '      grid-template-columns: repeat(1, minmax(0, 1fr));',
    '    }',
    '  }',
    '  .other {',
    '    color: red;',
    '  }',
    '</style>',
    '',
  ].join('\n');
  const { segments, region } = regionOf(page);
  const blocks = css.listAtRuleBlocks(region);
  assert.equal(blocks.length, 1, 'the page has one query block');
  assert.equal(css.createRuleInAtRule(blocks[0].node, '.button-wrapper', 'margin-top', { value: '5.11rem', important: false }), true);
  const expected = [
    '<style>',
    '  .developer_layout {',
    '    display: grid;',
    '    @media (width < 42rem) {',
    '      grid-template-columns: repeat(1, minmax(0, 1fr));',
    '      .button-wrapper {',
    '        margin-top: 5.11rem;',
    '      }',
    '    }',
    '  }',
    '  .other {',
    '    color: red;',
    '  }',
    '</style>',
    '',
  ].join('\n');
  assert.equal(css.renderEmbed(segments, [region]), expected);
});

// An editor state over `text` with the caret at its end, the syntax tree parsed.
const editorState = (text) => {
  const state = bundle.EditorState.create({ doc: text, selection: bundle.EditorSelection.cursor(text.length), extensions: bundle.cssEditorIndentExtensions() });
  assert.ok(bundle.ensureSyntaxTree(state, text.length, 1000), 'the CSS parses in time');
  return state;
};

test('Enter inside a rule starts the line a tab in', () => {
  let next;
  const handled = bundle.insertNewlineAndIndent({ state: editorState('.a {\n\tcolor: red;'), dispatch: (transaction) => (next = transaction.state) });
  assert.equal(handled, true);
  assert.equal(next.doc.toString(), '.a {\n\tcolor: red;\n\t');
});

test('a typed closing brace moves back to column 0', () => {
  const state = editorState('.a {\n\tcolor: red;\n\t');
  const end = state.doc.length;
  const next = state.update({ changes: { from: end, insert: '}' }, selection: { anchor: end + 1 }, userEvent: 'input.type' }).state;
  assert.equal(next.doc.toString(), '.a {\n\tcolor: red;\n}');
});

// Nested rules. The chain around a rule is what the source says, each level on
// its own line, and a save goes to the rule alone.

const NESTED_PAGE = [
  '<style>',
  '  .hero_wrap {',
  '    color: red;',
  '    .container {',
  '      padding-block: 0;',
  '    }',
  '    .other {',
  '      margin: 0;',
  '    }',
  '  }',
  '</style>',
  '',
].join('\n');

const collected = (region) =>
  css.collectRules(region, { idSeed: 't', regionIndex: 0, order: { n: 0 }, embedKey: 'e', embedLabel: 'e', fromComponent: false, componentName: undefined });

const chainOf = (css_) => {
  const { region } = regionOf(['<style>', css_, '</style>', ''].join('\n'));
  return (selector) => ruleText.ruleChainText(ruleNode(region, selector)).text;
};

test('a nested rule shows the structure it is written in, not the resolved selector', () => {
  const { region } = regionOf(NESTED_PAGE);
  const chain = ruleText.ruleChainText(ruleNode(region, '.container'));
  assert.equal(chain.text, ['.hero_wrap {', '\t.container {', '\t\tpadding-block: 0;', '\t}', '}'].join('\n'));
  assert.ok(!chain.text.includes('color: red'), 'the parent shows no declaration of its own');
  assert.ok(!chain.text.includes('.other'), 'the parent shows no other rule');
});

test('a rule written flat stays flat', () => {
  const text = chainOf('.hero_wrap .container {\n  padding-block: 0;\n}')('.hero_wrap .container');
  assert.equal(text, ['.hero_wrap .container {', '\tpadding-block: 0;', '}'].join('\n'));
});

test('& forms are shown as written, never resolved', () => {
  for (const selector of ['& > :first-child', '&:hover', '&.active']) {
    const text = chainOf(`.card {\n  ${selector} {\n    color: red;\n  }\n}`)(selector);
    assert.equal(text, ['.card {', `\t${selector} {`, '\t\tcolor: red;', '\t}', '}'].join('\n'));
  }
});

test('deeper nesting, queries around a rule and queries inside one keep their levels', () => {
  const deep = chainOf('.a {\n  .b {\n    .c {\n      color: red;\n    }\n  }\n}')('.c');
  assert.equal(deep, ['.a {', '\t.b {', '\t\t.c {', '\t\t\tcolor: red;', '\t\t}', '\t}', '}'].join('\n'));
  const around = chainOf('@media (width > 40rem) {\n  .a {\n    .b {\n      color: red;\n    }\n  }\n}')('.b');
  assert.equal(around, ['@media (width > 40rem) {', '\t.a {', '\t\t.b {', '\t\t\tcolor: red;', '\t\t}', '\t}', '}'].join('\n'));
  const inside = chainOf('.a {\n  @container (width < 50em) {\n    .b {\n      color: red;\n    }\n  }\n}')('.b');
  assert.equal(inside, ['.a {', '\t@container (width < 50em) {', '\t\t.b {', '\t\t\tcolor: red;', '\t\t}', '\t}', '}'].join('\n'));
});

test('selector lists stay as written at each level', () => {
  const text = chainOf('.a, .b {\n  .c,\n  .d {\n    color: red;\n  }\n}')('.c,\n  .d');
  assert.equal(text, ['.a, .b {', '\t.c,', '\t.d {', '\t\tcolor: red;', '\t}', '}'].join('\n'));
});

test('editing the nested rule changes its body only, in place', () => {
  const { segments, region } = regionOf(NESTED_PAGE);
  const node = ruleNode(region, '.container');
  const chain = ruleText.ruleChainText(node);
  const edited = ruleText.ruleTextFromChain(chain.text.replace('padding-block: 0;', 'padding-block: 1rem;'), chain);
  assert.deepEqual(css.replaceRuleCss({ node }, edited), { ok: true });
  assert.equal(css.renderEmbed(segments, [region]), NESTED_PAGE.replace('padding-block: 0;', 'padding-block: 1rem;'));
});

test('an unchanged chain writes back byte for byte', () => {
  const { segments, region } = regionOf(NESTED_PAGE);
  const node = ruleNode(region, '.container');
  const chain = ruleText.ruleChainText(node);
  assert.deepEqual(css.replaceRuleCss({ node }, ruleText.ruleTextFromChain(chain.text, chain)), { ok: true });
  assert.equal(css.renderEmbed(segments, [region]), NESTED_PAGE);
});

test('text whose chain lines changed is not a rule edit', () => {
  const { region } = regionOf(NESTED_PAGE);
  const chain = ruleText.ruleChainText(ruleNode(region, '.container'));
  assert.equal(ruleText.ruleTextFromChain(chain.text.replace('.hero_wrap', '.renamed'), chain), undefined);
  assert.equal(ruleText.ruleTextFromChain(chain.text.replace(/}$/, '} /* tail */'), chain), undefined);
  assert.equal(ruleText.ruleTextFromChain('', chain), undefined);
});

test('a nested query with bare declarations saves into the same at-rule', () => {
  const page = ['<style>', '  .a {', '    @media (width > 40rem) {', '      color: red;', '    }', '  }', '</style>', ''].join('\n');
  const { segments, region } = regionOf(page);
  const rule = collected(region).find((entry) => entry.node.type === 'atrule');
  assert.ok(rule, 'the query is surfaced as a rule');
  const chain = ruleText.ruleChainText(rule.node);
  assert.equal(chain.text, ['.a {', '\t@media (width > 40rem) {', '\t\tcolor: red;', '\t}', '}'].join('\n'));
  const edited = ruleText.ruleTextFromChain(chain.text.replace('color: red', 'color: blue'), chain);
  assert.deepEqual(css.replaceRuleCss(rule, edited), { ok: true });
  assert.equal(css.renderEmbed(segments, [region]), page.replace('color: red', 'color: blue'));
});

test('matching keeps the resolved selector while the display keeps the written one', () => {
  const { region } = regionOf(NESTED_PAGE);
  const rule = collected(region).find((entry) => entry.node.selector === '.container');
  assert.equal(rule.selectorText, '.hero_wrap .container');
  assert.deepEqual(rule.written, { parents: ['.hero_wrap'], head: '.container' });
});

test('a top-level rule carries no written chain', () => {
  const { region } = regionOf(INDENTED_PAGE);
  assert.equal(collected(region).find((entry) => entry.node.selector === '.hero').written, undefined);
});

// The preview of matching rules prints chains too.
const previewOf = (css_, selector) => {
  const { region } = regionOf(['<style>', css_, '</style>', ''].join('\n'));
  const rule = collected(region).find((entry) => entry.node.selector === selector);
  const matchedSelectors = rule.selectors.map((entry) => ({ ...entry, specificity: [0, 1, 0] }));
  return bundle.buildCssRuleView([{ rule, matchedSelectors, declStatus: {} }]);
};

test('the read-only preview shows the chain and only the rule’s own declarations', () => {
  const view = previewOf('.hero_wrap {\n  color: red;\n  .container {\n    padding-block: 0;\n  }\n}', '.container');
  assert.equal(view.code, ['.hero_wrap {', '\t.container {', '\t\tpadding-block: 0;', '\t}', '}'].join('\n'));
  assert.equal(view.code.slice(view.selectors[0].from, view.selectors[0].to), '.container', 'the rule’s own selector is the one marked');
});

test('the preview of a flat selector stays flat', () => {
  const view = previewOf('.hero_wrap .container {\n  padding-block: 0;\n}', '.hero_wrap .container');
  assert.equal(view.code, ['.hero_wrap .container {', '\tpadding-block: 0;', '}'].join('\n'));
});

// The chain is locked through CodeMirror's own change filter.
const lockedState = (chain) =>
  bundle.EditorState.create({
    doc: chain.text,
    extensions: bundle.lockedEdgeExtensions({ prefixLength: chain.prefix.length, suffixLength: chain.suffix.length }),
  });

test('edits to the chain lines are refused, edits to the rule pass', () => {
  const { region } = regionOf(NESTED_PAGE);
  const chain = ruleText.ruleChainText(ruleNode(region, '.container'));
  const state = lockedState(chain);
  const typed = (changes) => state.update({ changes, userEvent: 'input.type' }).state.doc.toString();
  assert.equal(typed({ from: 1, insert: 'x' }), chain.text, 'inside the opening line');
  assert.equal(typed({ from: 0, insert: 'x' }), chain.text, 'before the chain');
  assert.equal(typed({ from: chain.text.length, insert: 'x' }), chain.text, 'after the chain');
  assert.equal(typed({ from: 0, to: 5 }), chain.text, 'deleting the parent');
  const at = chain.text.indexOf('0;');
  assert.equal(typed({ from: at, to: at + 1, insert: '1' }), chain.text.replace('0;', '1;'), 'the rule itself');
  const all = typed({ from: 0, to: chain.text.length });
  assert.equal(all, chain.prefix + chain.suffix, 'select-all and delete clears only the rule');
});

test('a value set from outside passes the lock', () => {
  const { region } = regionOf(NESTED_PAGE);
  const chain = ruleText.ruleChainText(ruleNode(region, '.container'));
  const state = lockedState(chain);
  const next = state.update({ changes: { from: 0, to: chain.text.length, insert: '.new {}' }, annotations: [bundle.ExternalChange.of(true)] }).state;
  assert.equal(next.doc.toString(), '.new {}');
});

test('new rules are tab-indented in an empty block and follow a block that has its own indentation', () => {
  const written = (page) => {
    const { segments, region } = regionOf(page);
    css.createRuleAtRoot(region, '.a', 'color', { value: 'red', important: false });
    css.createRuleInMedia(region, '(width > 1px)', '.b', 'color', { value: 'red', important: false });
    return css.renderEmbed(segments, [region]);
  };
  assert.equal(written('<style>\n</style>\n'), '<style>\n.a {\n\tcolor: red;\n}\n@media (width > 1px) {\n\t.b {\n\t\tcolor: red;\n\t}\n}\n</style>\n');
  const spaced = '<style>\n  .x {\n    color: red;\n  }\n</style>\n';
  assert.equal(
    written(spaced),
    spaced.replace('</style>', '  .a {\n    color: red;\n  }\n  @media (width > 1px) {\n    .b {\n      color: red;\n    }\n  }\n</style>'),
  );
});
