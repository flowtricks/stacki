// Goal: sticky scroll pins the right lines at every scroll position. Blocks come from
// the syntax tree, so braces in strings and comments mean nothing; the stack is
// outermost first and capped to the innermost lines; a line slides out as its block
// ends; a folded block is one line; and all of it holds in the dedented view.
// Method: the real codeStickyLines.ts is bundled with CodeMirror and run on real
// EditorStates with fully parsed trees. A small height map stands in for the editor's,
// with uniform lines and optional folds, since that is all the module reads from it.
// Each test scrolls to a place named by line and reads back lines and offsets. Layout
// on screen is covered by the mounted test and by hand in Chromium.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { ROOT } = require('../../helpers/sources.js');

const bundle = (() => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-code-sticky-'));
  const output = path.join(directory, 'module.cjs');
  try {
    buildSync({
      stdin: {
        contents: `
          export * from './src/ui/codeStickyLines';
          export * from './src/ui/codeIndentView';
          export * from './src/ui/codeLineRoles';
          export { EditorState } from '@codemirror/state';
          export { ensureSyntaxTree } from '@codemirror/language';
          export { css } from '@codemirror/lang-css';
          export { javascript } from '@codemirror/lang-javascript';
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

const LINE = 10;
// The stack takes its limit as an input, so these tests give it room to show nesting
// past the real cap. `stickyRowsMax` is where the cap itself is tested.
const ROWS_ROOMY = 5;
const lines = (...items) => items.join('\n');

const LANGUAGES = {
  css: () => bundle.css(),
  script: () => bundle.javascript({ typescript: true }),
};

function stateOf(text, language = 'css') {
  const state = bundle.EditorState.create({ doc: text, extensions: [LANGUAGES[language]()] });
  assert.ok(bundle.ensureSyntaxTree(state, text.length, 10_000), 'the fixture parses in full');
  // A state takes up what was parsed behind it on its next update, as an editor's does.
  return state.update({}).state;
}

// Visual lines of a document, each a line tall. `folds` are 1-based [first, last]
// line pairs, which become one visual line as CodeMirror's height map makes them.
function heightMap(state, folds = []) {
  const boxes = [];
  for (let number = 1; number <= state.doc.lines; number++) {
    const line = state.doc.line(number);
    const fold = folds.find(([first]) => first === number);
    const last = fold === undefined ? line : state.doc.line(fold[1]);
    boxes.push({ from: line.from, to: last.to, top: boxes.length * LINE, bottom: (boxes.length + 1) * LINE });
    number = last.number;
  }
  return {
    lineBlockAt: (position) => boxes.find((box) => position <= box.to) ?? boxes.at(-1),
    lineBlockAtHeight: (height) => boxes[Math.max(0, Math.min(boxes.length - 1, Math.floor(height / LINE)))],
  };
}

function stackAt(state, scrollTop, options = {}) {
  const { rowsMax = ROWS_ROOMY, folds = [] } = options;
  return bundle.stickyStack({
    scrollTop,
    lineHeight: LINE,
    rowsMax,
    lines: heightMap(state, folds),
    blocksAt: (position) => bundle.stickyBlocksAt(state, position),
  });
}

// `[text, offset]` per row, for comparing a whole stack at once.
const shown = (state, stack) => stack.rows.map((row) => [state.doc.lineAt(row.block.headerFrom).text.trim(), row.offsetPx]);
const texts = (state, stack) => shown(state, stack).map(([text]) => text);
const topOfLine = (number) => (number - 1) * LINE;

const NESTED = lines(
  '@media (width < 50rem) {', //  1
  '  :root {', //                 2
  '    --a: 1;', //               3
  '    --b: 2;', //               4
  '    --c: 3;', //               5
  '  }', //                       6
  '  .hero_wrap {', //            7
  '    .container {', //          8
  '      & > :first-child {', //  9
  '        color: red;', //      10
  '        margin: 0;', //       11
  '        padding: 0;', //      12
  '      }', //                  13
  '      gap: 0;', //            14
  '      gap: 1px;', //          15
  '      gap: 2px;', //          16
  '    }', //                    17
  '  }', //                      18
  '}', //                        19
  '.after {', //                 20
  '  color: blue;', //           21
  '}', //                        22
  ...Array.from({ length: 30 }, () => '/* Filler. */'),
);

test('nothing pins at the top of the file, so the first line stays clickable', () => {
  const state = stateOf(NESTED);
  assert.deepEqual(stackAt(state, 0), { rows: [], heightPx: 0 });
  assert.deepEqual(stackAt(state, -8), { rows: [], heightPx: 0 });
});

test('a header pins only once it has passed its row', () => {
  const state = stateOf(NESTED);
  // With line 7 exactly in row 1, the real line shows and needs no copy over it.
  const inRow = topOfLine(7) - LINE;
  assert.deepEqual(texts(state, stackAt(state, inRow)), ['@media (width < 50rem) {']);
  assert.deepEqual(texts(state, stackAt(state, inRow + 1)).slice(0, 2), ['@media (width < 50rem) {', '.hero_wrap {']);
});

test('the stack holds the enclosing blocks, outermost first, each a row lower', () => {
  const state = stateOf(NESTED);
  const stack = stackAt(state, topOfLine(11) - 4 * LINE);
  assert.deepEqual(shown(state, stack), [
    ['@media (width < 50rem) {', 0],
    ['.hero_wrap {', 10],
    ['.container {', 20],
    ['& > :first-child {', 30],
  ]);
  assert.equal(stack.heightPx, 40);
  assert.deepEqual(shown(state, stackAt(state, topOfLine(5) - LINE)), [
    ['@media (width < 50rem) {', 0],
    [':root {', 10],
  ]);
});

test('headers on consecutive lines pin in place, each taking over from its real line', () => {
  const state = stateOf(NESTED);
  // All three reach their rows together, one pixel apart from where they already are.
  const stack = stackAt(state, topOfLine(7) - LINE + 1);
  assert.deepEqual(texts(state, stack), ['@media (width < 50rem) {', '.hero_wrap {', '.container {', '& > :first-child {']);
});

test('levels pin with their real line numbers, a parent and child apart, and a sibling only changes the inner row', () => {
  const state = stateOf(
    lines(
      ...Array.from({ length: 69 }, () => '/* Filler. */'), // 1 to 69
      '.container {', // 70
      '  width: 100%;', // 71
      '  max-width: 80rem;', // 72
      '  margin: 0 auto;', // 73
      '  padding: 0 1rem;', // 74
      '  &.centered {', // 75
      '    display: flex;', // 76
      '    .inner {', // 77
      '      gap: 1rem;', // 78
      '      gap: 2rem;', // 79
      '      gap: 3rem;', // 80
      '    }', // 81
      '    margin: 0;', // 82
      '  }', // 83
      '  &.wide {', // 84
      '    max-width: none;', // 85
      '    padding: 0;', // 86
      '    margin: 0;', // 87
      '    gap: 0;', // 88
      '  }', // 89
      '}', // 90
      ...Array.from({ length: 30 }, () => '/* Filler. */'),
    ),
  );
  const numbered = (stack) => stack.rows.map((row) => [state.doc.lineAt(row.block.headerFrom).number, row.offsetPx]);
  // One level: lines 71 to 74 scroll under line 70.
  assert.deepEqual(numbered(stackAt(state, topOfLine(73))), [[70, 0]]);
  // Two levels, with four lines between them: line 75 joins at its row as it gets there.
  assert.deepEqual(numbered(stackAt(state, topOfLine(75) - LINE)), [[70, 0]]);
  assert.deepEqual(numbered(stackAt(state, topOfLine(75) - LINE + 1)), [
    [70, 0],
    [75, 10],
  ]);
  // Three levels.
  assert.deepEqual(numbered(stackAt(state, topOfLine(79) - 2 * LINE)), [
    [70, 0],
    [75, 10],
    [77, 20],
  ]);
  // Back to two as line 77's block ends.
  assert.deepEqual(numbered(stackAt(state, topOfLine(82) - 2 * LINE)), [
    [70, 0],
    [75, 10],
  ]);
  // `&.centered` ends and `&.wide` starts: line 70 never moves, line 75 slides out, line 84 takes the row.
  assert.deepEqual(numbered(stackAt(state, topOfLine(83) - LINE + 4)), [
    [70, 0],
    [75, 6],
  ]);
  assert.deepEqual(numbered(stackAt(state, topOfLine(84) - LINE + 1)), [
    [70, 0],
    [84, 10],
  ]);
  assert.deepEqual(numbered(stackAt(state, topOfLine(87) - LINE)), [
    [70, 0],
    [84, 10],
  ]);
});

test('a line gives way as its block ends: the closing line reaches it, then content pushes it', () => {
  const state = stateOf(NESTED);
  // Line 13 closes the block in row 3. Its bottom is 13 lines down.
  const closingUnderRow = topOfLine(13) - 3 * LINE;
  assert.deepEqual(shown(state, stackAt(state, closingUnderRow)).at(-1), ['& > :first-child {', 30]);
  assert.deepEqual(shown(state, stackAt(state, closingUnderRow + 4)).at(-1), ['& > :first-child {', 26]);
  assert.deepEqual(shown(state, stackAt(state, closingUnderRow + 9)).at(-1), ['& > :first-child {', 21]);
  // The stack shrinks with it, which is what uncovers the next line.
  assert.equal(stackAt(state, closingUnderRow + 4).heightPx, 36);
  // Hidden behind the row above, it is gone and the row above is unaffected.
  assert.deepEqual(texts(state, stackAt(state, closingUnderRow + LINE)), ['@media (width < 50rem) {', '.hero_wrap {', '.container {']);
});

test('blocks closing on consecutive lines leave one after another', () => {
  const state = stateOf(NESTED);
  const sweep = [];
  for (let scrollTop = topOfLine(15); scrollTop < topOfLine(21); scrollTop += 2) {
    sweep.push(stackAt(state, scrollTop).heightPx);
  }
  // Never a jump of more than the scroll itself on the way down, only the next rule at the end.
  for (let index = 1; index < sweep.length; index++) {
    const delta = sweep[index - 1] - sweep[index];
    assert.ok(delta <= 2 || delta < 0, `height falls smoothly at step ${index}: ${sweep.join(' ')}`);
  }
  assert.deepEqual(texts(state, stackAt(state, topOfLine(21))), ['.after {']);
});

test('a block closing on the same line as its parent leaves with it, covered by it', () => {
  const state = stateOf(lines('.a {', '  .b {', '    x: y;', '    x: y;', '    x: y;', '  }}', '.c {', '  x: y;', '}'));
  assert.deepEqual(shown(state, stackAt(state, topOfLine(5) - LINE)), [
    ['.a {', 0],
    ['.b {', 10],
  ]);
  assert.deepEqual(shown(state, stackAt(state, topOfLine(6) - 3)), [
    ['.a {', 0],
    ['.b {', 3],
  ]);
  // The inner line is behind the outer one by now, and the outer one takes it along.
  assert.deepEqual(shown(state, stackAt(state, topOfLine(6) + 3)), [['.a {', -3]]);
});

test('past the cap the innermost lines stay', () => {
  const depth = 8;
  const open = Array.from({ length: depth }, (_, index) => `${'  '.repeat(index)}.level-${index} {`);
  const close = Array.from({ length: depth }, (_, index) => `${'  '.repeat(depth - index - 1)}}`);
  const state = stateOf(lines(...open, ...Array.from({ length: 10 }, () => 'x: y;'), ...close));
  const stack = stackAt(state, topOfLine(depth + 2));
  assert.deepEqual(texts(state, stack), ['.level-3 {', '.level-4 {', '.level-5 {', '.level-6 {', '.level-7 {']);
  assert.deepEqual(
    stack.rows.map((row) => row.offsetPx),
    [0, 10, 20, 30, 40],
  );
  assert.equal(stack.heightPx, 50);
  assert.deepEqual(texts(state, stackAt(state, topOfLine(depth + 2), { rowsMax: 2 })), ['.level-6 {', '.level-7 {']);
});

test('past the cap the window moves with the content, never in a jump', () => {
  const inner = (name) => [`      ${name} {`, ...Array.from({ length: 6 }, () => '        x: y;'), '      }'];
  const state = stateOf(
    lines(
      '.a {',
      '  .b {',
      '    .c {',
      ...inner('.d'),
      '',
      ...inner('.e'),
      ...inner('.f'),
      '      tail: 0;',
      '      tail: 0;',
      '    }',
      '  }',
      '}',
      '',
      '',
      '',
      '',
      '',
    ),
  );
  const step = 1;
  let previous = stackAt(state, 0, { rowsMax: 2 });
  for (let scrollTop = step; scrollTop < topOfLine(state.doc.lines); scrollTop += step) {
    const stack = stackAt(state, scrollTop, { rowsMax: 2 });
    assert.ok(stack.heightPx <= 30, `the stack stays near its limit at ${scrollTop}`);
    for (const row of stack.rows) {
      const before = previous.rows.find((item) => item.block.headerFrom === row.block.headerFrom);
      if (before !== undefined) {
        assert.ok(Math.abs(before.offsetPx - row.offsetPx) <= step, `a line moves no faster than the scroll at ${scrollTop}`);
      }
    }
    previous = stack;
  }
});

test('three lines pin at most, and deeper the innermost three stay', () => {
  assert.equal(bundle.STICKY_LINES_MAX, 3);
  const state = stateOf(
    lines(
      'section.faq {',
      '  details {',
      '    summary {',
      '      &::after {',
      ...Array.from({ length: 12 }, () => '        color: red;'),
      '      }',
      '    }',
      '  }',
      '}',
    ),
  );
  const stack = stackAt(state, topOfLine(10), { rowsMax: bundle.stickyRowsMax(400, LINE) });
  assert.deepEqual(shown(state, stack), [
    ['details {', 0],
    ['summary {', 10],
    ['&::after {', 20],
  ]);
});

test('a short editor pins fewer lines, and a tiny one none', () => {
  assert.equal(bundle.stickyRowsMax(1000, 18), 3);
  assert.equal(bundle.stickyRowsMax(190, 18), 3);
  assert.equal(bundle.stickyRowsMax(90, 18), 2);
  assert.equal(bundle.stickyRowsMax(40, 18), 0);
  assert.equal(bundle.stickyRowsMax(0, 18), 0);
  const state = stateOf(NESTED);
  assert.deepEqual(stackAt(state, 100, { rowsMax: 0 }), { rows: [], heightPx: 0 });
});

test('braces in strings and comments are not blocks', () => {
  const state = stateOf(
    lines(
      '.a::before {', // 1
      '  content: "}";', // 2
      '  /* } */', // 3
      '  content: "{";', // 4
      '  /* { */', // 5
      '  color: red;', // 6
      '  color: red;', // 7
      '}', // 8
      '/* .b {', // 9
      '   still a comment', // 10
      '   still a comment', // 11
      '*/', // 12
      '.c {}', // 13
      ...Array.from({ length: 12 }, () => '/* Filler. */'),
    ),
  );
  assert.deepEqual(texts(state, stackAt(state, topOfLine(6))), ['.a::before {']);
  assert.deepEqual(texts(state, stackAt(state, topOfLine(10))), [], 'a commented-out rule pins nothing, and neither does the comment');
});

test('script blocks: functions, classes, objects and callbacks', () => {
  const state = stateOf(
    lines(
      'export class Pigeon {', // 1
      '  fly(height: number) {', // 2
      '    const route = {', // 3
      '      legs: [', // 4
      '        "}",', // 5
      '        `{${height}`,', // 6
      '      ],', // 7
      '    };', // 8
      '    items.map((item) => {', // 9
      '      return item;', // 10
      '    });', // 11
      '  }', // 12
      '}', // 13
      ...Array.from({ length: 20 }, () => '// Filler.'),
    ),
    'script',
  );
  assert.deepEqual(texts(state, stackAt(state, topOfLine(6) - 4 * LINE)), ['export class Pigeon {', 'fly(height: number) {', 'const route = {', 'legs: [']);
  assert.deepEqual(texts(state, stackAt(state, topOfLine(10) - 3 * LINE + 1)), ['export class Pigeon {', 'fly(height: number) {', 'items.map((item) => {']);
});

test('a block is named by the line that starts its statement, and an else by its own', () => {
  const state = stateOf(
    lines(
      'function long(', // 1
      '  first: string,', // 2
      '  second: string,', // 3
      '): void {', // 4
      '  if (first) {', // 5
      '    a();', // 6
      '    a();', // 7
      '  } else {', // 8
      '    b();', // 9
      '    b();', // 10
      '    b();', // 11
      '  }', // 12
      '}', // 13
      ...Array.from({ length: 20 }, () => '// Filler.'),
    ),
    'script',
  );
  assert.deepEqual(texts(state, stackAt(state, topOfLine(3))), [], 'its parameters are part of the header, still in view');
  assert.deepEqual(texts(state, stackAt(state, topOfLine(7) - 2 * LINE)), ['function long(', 'if (first) {']);
  assert.deepEqual(texts(state, stackAt(state, topOfLine(10) - 2 * LINE)), ['function long(', '} else {']);
});

test('a closing line with something after its brace still holds its block', () => {
  const state = stateOf(
    lines(
      'run({', // 1
      '  a: [', // 2
      '    1,', // 3
      '    2,', // 4
      '  ],', // 5
      '  b: {', // 6
      '    c: 1,', // 7
      '  },', // 8
      '  d: 1,', // 9
      '});', // 10
      ...Array.from({ length: 20 }, () => '// Filler.'),
    ),
    'script',
  );
  // Line 8 in row 1, its block's own row: it slides from here rather than vanishing.
  assert.deepEqual(shown(state, stackAt(state, topOfLine(8) - LINE + 4)), [
    ['run({', 0],
    ['b: {', 6],
  ]);
  assert.deepEqual(shown(state, stackAt(state, topOfLine(10) + 4)), [['run({', -4]]);
});

test('a line that closes one block and opens another hands its row straight over', () => {
  const state = stateOf(lines('if (a) {', '  b();', '  b();', '  b();', '} else {', '  c();', '  c();', '  c();', '}', '// Filler.', '// Filler.'), 'script');
  assert.deepEqual(texts(state, stackAt(state, topOfLine(4) + 4)), ['if (a) {']);
  assert.deepEqual(shown(state, stackAt(state, topOfLine(5) + 1)), [['} else {', 0]]);
});

const SELECTOR_LIST = lines(
  '/* Filler. */', // 1
  'h1,', // 2
  'h2,', // 3
  '  h3,', // 4
  'p {', // 5
  '  color: red;', // 6
  '  color: red;', // 7
  '  color: red;', // 8
  '  color: red;', // 9
  '}', // 10
  ...Array.from({ length: 12 }, () => '/* Filler. */'),
);

// The row's text as the DOM shows it.
function headerText(state, block) {
  return bundle
    .stickyHeaderPieces(state, block)
    .map((piece) => piece.separator + state.sliceDoc(piece.from, piece.to))
    .join('');
}

test('a multi-line selector does not pin while any of it is in view', () => {
  const state = stateOf(SELECTOR_LIST);
  assert.deepEqual(stackAt(state, topOfLine(2)).rows, []);
  assert.deepEqual(stackAt(state, topOfLine(2) + 4).rows, [], 'its first line leaving changes nothing');
  assert.deepEqual(stackAt(state, topOfLine(4)).rows, []);
  assert.deepEqual(stackAt(state, topOfLine(5)).rows, [], 'the line with the brace is exactly at the top: it still shows itself');
});

test('it pins the moment the line with the brace crosses the top, whole, on one row', () => {
  const state = stateOf(SELECTOR_LIST);
  const { rows } = stackAt(state, topOfLine(5) + 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].offsetPx, 0);
  assert.equal(headerText(state, rows[0].block), 'h1, h2, h3, p {');
  assert.equal(state.doc.lineAt(rows[0].block.headerFrom).number, 2, "the row carries the first line's number, which is where a click goes");
  assert.equal(state.doc.lineAt(rows[0].block.openFrom).number, 5);
  assert.equal(state.sliceDoc(rows[0].block.openTo - 1, rows[0].block.openTo), '{');
  // It stays and leaves like any other row.
  assert.equal(stackAt(state, topOfLine(9)).rows.length, 1);
  assert.equal(stackAt(state, topOfLine(10) + 4).rows[0].offsetPx, -4);
});

test('a nested selector list waits for its own row, and keeps its indentation', () => {
  const state = stateOf(lines('.a {', '  .b,', '  .c {', '    x: y;', '    x: y;', '    x: y;', '  }', '}', '/* Filler. */', '/* Filler. */'));
  assert.deepEqual(texts(state, stackAt(state, topOfLine(3) - LINE)), ['.a {'], 'line 3 sits in row 1');
  const { rows } = stackAt(state, topOfLine(3) - LINE + 1);
  assert.equal(rows.length, 2);
  assert.equal(headerText(state, rows[1].block), '  .b, .c {');
  assert.equal(rows[1].offsetPx, LINE);
});

test('a multi-line signature joins the same way, without a space inside its brackets', () => {
  const state = stateOf(
    lines(
      'export function long(',
      '  first: string,',
      '  second: string',
      '): void {',
      '  go();',
      '  go();',
      '  go();',
      '}',
      '// Filler.',
      '// Filler.',
      '// Filler.',
    ),
    'script',
  );
  assert.deepEqual(stackAt(state, topOfLine(4)).rows, [], 'its `{` line is still at the top');
  const { rows } = stackAt(state, topOfLine(4) + 1);
  assert.equal(headerText(state, rows[0].block), 'export function long(first: string, second: string): void {');
  assert.equal(state.doc.lineAt(rows[0].block.headerFrom).number, 1);
});

test('an opening too tall to name anything falls back to its first line', () => {
  const selectors = Array.from({ length: 40 }, (_, index) => `.item-${index},`);
  const state = stateOf(lines(...selectors, '.last {', '  x: y;', '  x: y;', '  x: y;', '}', '/* Filler. */', '/* Filler. */'));
  const { rows } = stackAt(state, topOfLine(41) + 1);
  assert.equal(headerText(state, rows[0].block), '.item-0,');
});

test('a block on one line never pins, and blocks opening on a line share a row', () => {
  const oneLine = stateOf(lines('.a { color: red; }', '.b { color: red; }', '.c { color: red; }', '.d { color: red; }'));
  assert.deepEqual(stackAt(oneLine, 15).rows, []);
  const shared = stateOf(lines('run(() => { return {', '  a: 1,', '  b: 2,', '  c: 3,', '}; });', '// Filler.', '// Filler.', '// Filler.'), 'script');
  assert.deepEqual(shown(shared, stackAt(shared, topOfLine(3))), [['run(() => { return {', 0]]);
});

test('a folded block is one line: it scrolls away instead of pinning', () => {
  const state = stateOf(NESTED);
  const folds = [[7, 18]];
  // With the fold, line 19 is the eighth visual line.
  const stack = stackAt(state, 6 * LINE + 4, { folds });
  assert.deepEqual(texts(state, stack), ['@media (width < 50rem) {']);
  const folded = stateOf(lines('.a {', '  x: y;', '}', '.b {', '  x: y;', '}', '/* Filler. */', '/* Filler. */'));
  assert.deepEqual(stackAt(folded, 3, { folds: [[1, 3]] }).rows, []);
});

test('a fold inside a block moves its closing line up with it', () => {
  const state = stateOf(NESTED);
  const folds = [[9, 13]];
  // Line 14 follows the folded rule at the ninth place, so the block ends four lines sooner.
  const closing = 13 * LINE - 2 * LINE;
  assert.deepEqual(shown(state, stackAt(state, closing - 3 * LINE, { folds })), [
    ['@media (width < 50rem) {', 0],
    ['.hero_wrap {', 10],
    ['.container {', 20],
  ]);
  assert.deepEqual(shown(state, stackAt(state, closing - 6, { folds })).at(-1), ['.container {', 16]);
});

test("in the dedented view, lines and numbers are the view's own", () => {
  const source = lines(
    '',
    '      @media (width < 50rem) {',
    '        .a {',
    '          color: red;',
    '          color: red;',
    '          color: red;',
    '        }',
    '      }',
    '    ',
  );
  const view = bundle.openCodeView(source, { extent: 'block', classify: bundle.codeLineClassifier('css') });
  assert.equal(view.text.split('\n')[0], '@media (width < 50rem) {', 'the block shows flush left');
  const state = stateOf(view.text);
  const stack = stackAt(state, topOfLine(4) - 2 * LINE);
  assert.deepEqual(
    stack.rows.map((row) => state.doc.lineAt(row.block.headerFrom).number),
    [1, 2],
    'the numbers match the gutter, which counts shown lines',
  );
  assert.deepEqual(
    stack.rows.map((row) => state.doc.lineAt(row.block.headerFrom).text),
    ['@media (width < 50rem) {', '\t.a {'],
    'a pinned line keeps the indentation of the line it copies',
  );
  assert.equal(state.sliceDoc(stack.rows[1].block.to - 1, stack.rows[1].block.to), '}', 'a block ends in the view, not at a source offset');
});

test('the space kept for the caret is what will pin with its line at the top', () => {
  const state = stateOf(NESTED);
  const heightAt = (number, rowsMax = 5) => bundle.stickyHeightAt(state, state.doc.line(number).from, { lineHeight: LINE, rowsMax });
  assert.equal(heightAt(1), 0, 'a top-level line has nothing above it');
  assert.equal(heightAt(2), LINE, 'a header counts its parents, not itself');
  assert.equal(heightAt(10), 4 * LINE);
  assert.equal(heightAt(10, 2), 2 * LINE, 'and never more than can pin');
  assert.equal(heightAt(13), 4 * LINE, 'a closing line is still inside its block');
  assert.equal(heightAt(20), 0);
  // Scrolled so that the line sits right below that space, nothing covers it, whether
  // its parents show as pinned rows or, as here, some are still real lines.
  assert.ok(stackAt(state, topOfLine(10) - heightAt(10)).heightPx <= heightAt(10));
  assert.ok(stackAt(state, topOfLine(16) - heightAt(16)).heightPx <= heightAt(16));
});

test('the work per scroll is bound by nesting, not by the length of the file', () => {
  const rule = lines('.card {', '  color: red;', '  .inner {', '    margin: 0;', '    & > a {', '      color: blue;', '    }', '  }', '}', '');
  const state = stateOf(Array.from({ length: 501 }, () => rule).join('\n'));
  assert.ok(state.doc.lines >= 5000, 'the fixture is the large file');
  let lookups = 0;
  const lineMap = heightMap(state);
  const stack = bundle.stickyStack({
    scrollTop: topOfLine(2506) - 3 * LINE + 1,
    lineHeight: LINE,
    rowsMax: bundle.STICKY_LINES_MAX,
    lines: lineMap,
    blocksAt: (position) => {
      lookups += 1;
      return bundle.stickyBlocksAt(state, position);
    },
  });
  assert.deepEqual(texts(state, stack), ['.card {', '.inner {', '& > a {']);
  assert.ok(lookups <= 6, `at most one lookup per row, and got ${lookups}`);
});

test('invariants fail loudly', () => {
  const state = stateOf(NESTED);
  const input = { scrollTop: 10, lineHeight: LINE, rowsMax: 5, lines: heightMap(state), blocksAt: () => [] };
  assert.throws(() => bundle.stickyStack({ ...input, scrollTop: Number.NaN }), /stickyStack: the scroll position is finite/);
  assert.throws(() => bundle.stickyStack({ ...input, lineHeight: 0 }), /stickyStack: a line has height/);
  assert.throws(() => bundle.stickyStack({ ...input, rowsMax: 1.5 }), /stickyStack: the row limit is a whole number/);
  assert.throws(() => bundle.stickyStack({ ...input, rowsMax: -1 }), /stickyStack: the row limit is not negative/);
  assert.throws(() => bundle.stickyRowsMax(100, 0), /stickyRowsMax: a line has height/);
  assert.throws(() => bundle.stickyBlocksAt(state, state.doc.length + 1), /stickyBlocksAt: the position is in the document/);
  assert.throws(() => bundle.stickyHeightAt(state, 0, { lineHeight: 0, rowsMax: 5 }), /stickyHeightAt: a line has height/);
  assert.throws(
    () => bundle.stickyHeaderPieces(state, { headerFrom: 10, openFrom: 0, openTo: 1, to: 20 }),
    /stickyHeaderPieces: a block opens at or after its first line/,
  );
});
