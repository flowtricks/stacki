// Goal: the Style panel's CSS Code editor shows a rule flush left with two
// spaces per level and a closing brace at column 0, types the same way, and a
// save writes the rule back in the <style> block's own layout. A rule in an
// indented Astro <style> block used to show the file's whitespace as is
// (`.a {\n        color: red;\n    }`). The style writer's new nested rules
// had the same fault in the file: inside an indented, nested @media a new
// rule's body ran far right and its brace landed off its selector.
// Method: the real css.ts, cssRuleText.ts and cssEditorIndent.ts are bundled
// as the app bundles them (with the CodeMirror pieces they share, so one copy
// of @codemirror/state is in play). Pages are split into <style> regions and
// rendered back; text is compared byte for byte. Typing is driven through
// CodeMirror's own state commands and an `input.type` transaction, which is
// what the editor's keymap and indentOnInput act on.
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

test('the editor shows a rule from an indented block flush left with two-space levels', () => {
  const { region } = regionOf(INDENTED_PAGE);
  const node = ruleNode(region, '.text-style-h1');
  assert.equal(ruleText.ruleEditorText(node), ['.text-style-h1 {', '  font-size: var(--h1);', '}'].join('\n'));
});

test('nested levels, tabs and blank lines map to two spaces per level', () => {
  const page = ['<style>', '\t.a {', '\t\tcolor: red;', '', '\t\t&:hover {', '\t\t\tcolor: blue;', '\t\t}', '\t}', '</style>', ''].join('\n');
  const { region } = regionOf(page);
  const text = ruleText.ruleEditorText(ruleNode(region, '.a'));
  assert.equal(text, ['.a {', '  color: red;', '', '  &:hover {', '    color: blue;', '  }', '}'].join('\n'));
  assert.equal(ruleText.sourceTextFromEditor(text, ruleText.ruleLayout(ruleNode(region, '.a'))), ruleNode(region, '.a').toString());
});

test('a rule written flush left already reads as it is', () => {
  const page = ['<style>', '.a {', '  color: red;', '}', '</style>', ''].join('\n');
  const { region } = regionOf(page);
  assert.equal(ruleText.ruleEditorText(ruleNode(region, '.a')), ['.a {', '  color: red;', '}'].join('\n'));
});

test('a saved edit goes back in the block layout and leaves the other rules alone', () => {
  const { segments, region } = regionOf(INDENTED_PAGE);
  const node = ruleNode(region, '.text-style-h1');
  const edited = ['.text-style-h1 {', '  font-size: var(--h1);', '  line-height: 1.1;', '}'].join('\n');
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

test('Enter inside a rule starts the line two spaces in', () => {
  let next;
  const handled = bundle.insertNewlineAndIndent({ state: editorState('.a {\n  color: red;'), dispatch: (transaction) => (next = transaction.state) });
  assert.equal(handled, true);
  assert.equal(next.doc.toString(), '.a {\n  color: red;\n  ');
});

test('a typed closing brace moves back to column 0', () => {
  const state = editorState('.a {\n  color: red;\n  ');
  const end = state.doc.length;
  const next = state.update({ changes: { from: end, insert: '}' }, selection: { anchor: end + 1 }, userEvent: 'input.type' }).state;
  assert.equal(next.doc.toString(), '.a {\n  color: red;\n}');
});
