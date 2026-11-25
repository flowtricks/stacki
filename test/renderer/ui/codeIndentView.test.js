// Goal: every code editor shows tab indentation, a <style> or <script> block
// shows flush left without the blank lines around it, and what goes back to the
// file is the file: an untouched line keeps its bytes, a new line follows the
// source's own indentation, and nothing inside a string changes.
// Method: the real codeIndentView.ts, codeLineRoles.ts and codeEditorIndent.ts are
// bundled as the app bundles them, with CodeMirror. Blocks are plain strings
// holding what a parser reads between the tags, compared byte for byte after
// open, edit and undo. Keys run through CodeMirror's own keymap and commands on a
// real state, which is what a key press reaches.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { ROOT } = require('../../helpers/sources.js');

const bundle = (() => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-code-indent-'));
  const output = path.join(directory, 'module.cjs');
  try {
    buildSync({
      stdin: {
        contents: `
          export * from './src/ui/codeIndentView';
          export * from './src/ui/codeLineRoles';
          export * from './src/ui/codeEditorIndent';
          export * from './shared/core/indent';
          export { EditorState, EditorSelection } from '@codemirror/state';
          export { insertNewlineAndIndent, insertTab, indentLess } from '@codemirror/commands';
          export { indentUnit, ensureSyntaxTree, getIndentUnit } from '@codemirror/language';
          export { keymap } from '@codemirror/view';
          export { css } from '@codemirror/lang-css';
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

const open = (source, language = 'css', extent = 'block') => bundle.openCodeView(source, { extent, classify: bundle.codeLineClassifier(language) });
const lines = (...items) => items.join('\n');

// What a parser reads inside the page's indented <style>: four spaces of block
// indent, two per level, a blank first line and the closing tag's indent last.
const STYLE = lines(
  '',
  '    :root {',
  '      --a: 1;',
  '    }',
  '',
  '    @media (width > 40rem) {',
  '      .a {',
  '        color: red;',
  '      }',
  '    }',
  '  ',
);
const STYLE_SHOWN = lines(':root {', '\t--a: 1;', '}', '', '@media (width > 40rem) {', '\t.a {', '\t\tcolor: red;', '\t}', '}');

test('a block shows flush left, a tab per level, with no blank line around it', () => {
  assert.equal(open(STYLE).text, STYLE_SHOWN);
});

test('the least indented line decides the block indent, not the first', () => {
  const view = open(lines('', '      .a {}', '    .b {}', '  '));
  assert.equal(view.text, lines('\t.a {}', '.b {}'));
});

test('opening writes nothing, and no edit gives back the same bytes', () => {
  const view = open(STYLE);
  assert.equal(view.source, STYLE);
  assert.equal(bundle.editCodeView(view, view.text).source, STYLE);
});

test('an edit changes that line and restores the block indentation', () => {
  const view = open(STYLE);
  const edited = bundle.editCodeView(view, view.text.replace('color: red', 'color: blue'));
  assert.equal(edited.source, STYLE.replace('color: red', 'color: blue'));
});

test('a new line takes the block indent and the source unit', () => {
  const view = open(STYLE);
  const edited = bundle.editCodeView(view, view.text.replace('\t\tcolor: red;', '\t\tcolor: red;\n\t\tmargin: 0;'));
  assert.equal(edited.source, STYLE.replace('        color: red;\n', '        color: red;\n        margin: 0;\n'));
});

test('undoing an edit returns the original bytes, odd indentation included', () => {
  const source = lines('', '    .a {', '       color: red;', '    }', '');
  const view = open(source);
  const typed = bundle.editCodeView(view, view.text.replace('red', 'blue'));
  assert.equal(bundle.editCodeView(typed, view.text).source, source);
});

test('a tab-indented block writes tabs', () => {
  const source = lines('', '\t\t.a {', '\t\t\tcolor: red;', '\t\t}', '\t');
  const view = open(source);
  assert.equal(view.text, lines('.a {', '\tcolor: red;', '}'));
  const edited = bundle.editCodeView(view, lines('.a {', '\tcolor: red;', '\tmargin: 0;', '}'));
  assert.equal(edited.source, lines('', '\t\t.a {', '\t\t\tcolor: red;', '\t\t\tmargin: 0;', '\t\t}', '\t'));
});

test('mixed tabs and spaces dedent by width and untouched lines keep their bytes', () => {
  const source = lines('', '\t\t.a {', '      color: red;', '    }', '');
  const view = open(source);
  assert.equal(view.text, lines('.a {', '\tcolor: red;', '}'));
  const edited = bundle.editCodeView(view, view.text.replace('red', 'blue'));
  assert.equal(edited.source, source.replace('red', 'blue'), 'a changed line keeps its indent when its shown indent is the same');
});

test('blank lines stay blank, and whitespace on them survives when untouched', () => {
  const source = lines('', '  .a {}', '     ', '  .b {}', '');
  const view = open(source);
  assert.equal(view.text, lines('.a {}', '', '.b {}'));
  assert.equal(bundle.editCodeView(view, view.text.replace('.b', '.c')).source, source.replace('.b', '.c'));
});

test('content on the tag’s own line is shown and restored', () => {
  const view = open('.a { color: red; }');
  assert.equal(view.text, '.a { color: red; }');
  assert.equal(bundle.editCodeView(view, '.a { color: blue; }').source, '.a { color: blue; }');
  const multiline = lines('.a {', '    color: red;', '  }');
  const shown = open(multiline);
  assert.equal(shown.text, lines('.a {', '\tcolor: red;', '}'));
  assert.equal(bundle.editCodeView(shown, shown.text).source, multiline);
});

test('an empty block shows nothing and takes its first line between its tags', () => {
  assert.equal(open('').text, '');
  assert.equal(bundle.editCodeView(open(''), '.a {}').source, '.a {}');
  const spaced = open('\n    ');
  assert.equal(spaced.text, '');
  assert.equal(spaced.source, '\n    ');
  assert.equal(bundle.editCodeView(spaced, '.a {}').source, '\n    .a {}\n    ');
});

test('clearing a block leaves the closing tag on its own line', () => {
  const view = open(STYLE);
  assert.equal(bundle.editCodeView(view, '').source, '\n  ');
});

test('a template literal keeps its text, in both directions', () => {
  const source = lines('', '    const a = 1;', '    const html = `', '  <p>', 'at zero', '    </p>`;', '    run(a);', '  ');
  const view = open(source, 'javascript');
  assert.equal(view.text, lines('const a = 1;', 'const html = `', '  <p>', 'at zero', '    </p>`;', 'run(a);'), 'the literal is shown byte for byte');
  assert.equal(bundle.editCodeView(view, view.text).source, source);
  const edited = bundle.editCodeView(view, view.text.replace('run(a);', 'run(a, html);'));
  assert.equal(edited.source, source.replace('run(a);', 'run(a, html);'));
});

test('a line typed inside a template literal is written as typed', () => {
  const source = lines('', '    const html = `', '  <p>`;', '  ');
  const view = open(source, 'javascript');
  const edited = bundle.editCodeView(view, view.text.replace('  <p>`;', '  <p>\n   <b>`;'));
  assert.equal(edited.source, lines('', '    const html = `', '  <p>', '   <b>`;', '  '));
});

test('a backtick in a regular expression opens no literal', () => {
  const view = open(lines('', '    const tick = /`/;', '    run();', '  '), 'javascript');
  assert.equal(view.text, lines('const tick = /`/;', 'run();'));
});

test('a CSS string continued on the next line keeps its whitespace', () => {
  const source = lines('', '    .a {', '      content: "one\\', '        two";', '    }', '  ');
  const view = open(source);
  assert.equal(view.text, lines('.a {', '\tcontent: "one\\', '        two";', '}'));
  assert.equal(bundle.editCodeView(view, view.text.replace('.a', '.b')).source, source.replace('.a', '.b'));
});

test('a CSS comment at column 0 does not hold the block to the left, and keeps its bytes', () => {
  const source = lines('', '    /* one', 'two', '       three */', '    .a {', '      color: red;', '    }', '  ');
  const view = open(source);
  assert.equal(view.text, lines('/* one', 'two', '\t three */', '.a {', '\tcolor: red;', '}'));
  assert.equal(bundle.editCodeView(view, view.text.replace('red', 'blue')).source, source.replace('red', 'blue'));
});

test('a space-indented document shows tabs and untouched lines stay byte identical', () => {
  const source = lines('import a from "a";', 'function run() {', '    if (a) {', '        return 1;', '    }', '}', '');
  const view = open(source, 'javascript', 'document');
  assert.equal(view.text, lines('import a from "a";', 'function run() {', '\tif (a) {', '\t\treturn 1;', '\t}', '}', ''));
  assert.equal(view.source, source);
  const edited = bundle.editCodeView(view, view.text.replace('\t\treturn 1;', '\t\trun();\n\t\treturn 1;'));
  assert.equal(edited.source, source.replace('        return 1;', '        run();\n        return 1;'));
});

test('two edits far apart leave every line between them alone', () => {
  const source = lines('a {', '   b: 1;', '  c: 2;', ' d: 3;', '  e: 4;', '}', '');
  const view = open(source, 'css', 'document');
  const next = view.text.split('\n');
  next[0] = 'x {';
  next[5] = '} /* end */';
  const edited = bundle.editCodeView(view, next.join('\n'));
  assert.equal(edited.source, source.replace('a {', 'x {').replace('}\n', '} /* end */\n'));
});

test('a document with tabs only is shown as it is and costs no view', () => {
  const source = lines('a {', '\tb: 1;', '}', '');
  const view = open(source, 'css', 'document');
  assert.equal(view.opened, undefined);
  assert.equal(view.text, source);
});

test('carriage returns stay on untouched lines and go on new ones', () => {
  const source = '\r\n    .a {\r\n      color: red;\r\n    }\r\n  ';
  const view = open(source);
  assert.equal(view.text, '.a {\n\tcolor: red;\n}');
  assert.equal(bundle.editCodeView(view, view.text).source, source);
  assert.equal(
    bundle.editCodeView(view, '.a {\n\tcolor: red;\n\tmargin: 0;\n}').source,
    '\r\n    .a {\r\n      color: red;\r\n      margin: 0;\r\n    }\r\n  ',
  );
});

test('a file with CRLF line ends gains no carriage return at its end when its last line is edited', () => {
  const opened = (source) => bundle.openCodeView(source, { extent: 'document', classify: bundle.codeLineClassifier('css') });
  const unended = opened('a {\r\n  color: red;\r\n}');
  assert.equal(bundle.editCodeView(unended, 'a {\n\tcolor: red;\n}x').source, 'a {\r\n  color: red;\r\n}x');
  const ended = opened('a {\r\n  color: red;\r\n}\r\n');
  assert.equal(bundle.editCodeView(ended, 'a {\n\tcolor: blue;\n}\n').source, 'a {\r\n  color: blue;\r\n}\r\n');
});

test('offsets map through the indentation, in both directions', () => {
  const view = open(STYLE);
  const sourceAt = STYLE.indexOf('color');
  const shownAt = view.text.indexOf('color');
  assert.equal(bundle.codeViewOffset(view, sourceAt), shownAt);
  assert.equal(bundle.codeSourceOffset(view, shownAt), sourceAt);
  assert.equal(bundle.codeViewOffset(view, 0), 0, 'the blank head sits before the first line');
  assert.equal(view.headLineCount, 1);
});

test('the block’s unit comes from its steps, not its base', () => {
  assert.equal(bundle.indentUnitOf(lines('      a', '          b', '      c', '          d')), '    ');
  assert.equal(bundle.indentUnitOf(lines('\ta', '\t\tb')), '\t');
  assert.equal(bundle.indentUnitOf(lines('a', 'b')), '\t', 'nothing indented means tabs');
  assert.equal(bundle.indentUnitOf(lines('  a', '\tb')), '\t', 'spaces are not clear on a tie');
});

test('withIndentUnit rewrites leading tabs only', () => {
  assert.equal(bundle.withIndentUnit('\ta\tb\n\t\tc', '  '), '  a\tb\n    c');
  assert.throws(() => bundle.withIndentUnit('a', ''), /a unit is never empty/);
  assert.throws(() => bundle.withIndentUnit('a', 'x'), /a unit is only whitespace/);
});

const stateOf = (text, cursor, style) =>
  bundle.EditorState.create({ doc: text, selection: bundle.EditorSelection.cursor(cursor), extensions: [bundle.codeIndentExtensions(style), bundle.css()] });

// Runs the Tab binding the shared extensions install.
const pressTab = (state) => {
  let next = state;
  const bindings = state.facet(bundle.keymap).flat();
  const tab = bindings.find((binding) => binding.key === 'Tab');
  assert.ok(tab, 'Tab is bound');
  assert.equal(tab.run({ state, dispatch: (transaction) => (next = transaction.state) }), true);
  return next;
};

test('the Tab key inserts a tab at the caret, in the middle of a line too', () => {
  assert.equal(pressTab(stateOf('ab', 1)).doc.toString(), 'a\tb');
  assert.equal(pressTab(stateOf('', 0)).doc.toString(), '\t');
});

test('the shared setting is a tab, two columns wide', () => {
  const state = stateOf('', 0);
  assert.equal(state.facet(bundle.indentUnit), '\t');
  assert.equal(state.tabSize, 2);
  assert.equal(bundle.getIndentUnit(state), 2);
});

test('auto-indent uses tabs', () => {
  const text = '.a {';
  const state = stateOf(text, text.length);
  assert.ok(bundle.ensureSyntaxTree(state, text.length, 1000));
  let next;
  bundle.insertNewlineAndIndent({ state, dispatch: (transaction) => (next = transaction.state) });
  assert.equal(next.doc.toString(), '.a {\n\t');
});

test('a format that forbids tabs indents with spaces', () => {
  assert.equal(bundle.codeIndentStyleFor('src/content/a.yaml'), 'spaces');
  assert.equal(bundle.codeIndentStyleFor('src/content/a.yml'), 'spaces');
  assert.equal(bundle.codeIndentStyleFor('src/content/a.json'), 'tabs');
  assert.equal(stateOf('', 0, 'spaces').facet(bundle.indentUnit), '  ');
  assert.equal(pressTab(stateOf('a', 0, 'spaces')).doc.toString(), '  a');
});
