// Goal: the diff view's rules hold without a DOM: rows and line numbers of a comparison, the counts
// of added and removed lines, how unchanged stretches fold and unfold, the word-level marks inside an
// edited line, and the bounds that keep a huge or hostile file from stalling the panel.
// Method: bundle the pure modules (lineDiff, diffModel, messageModel, permissionModel) with esbuild
// and call them with known-good inputs, then with the negative space: empty and absent files, CRLF,
// binary text, a file too large to align, lines too long to compare, and a cap smaller than the diff.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/aiDiffPure.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export * from './src/features/ai/lineDiff';",
      "export * from './src/features/ai/transcript/diffModel';",
      "export * from './src/features/ai/transcript/messageModel';",
      "export * from './src/features/ai/transcript/permissionModel';",
      "export { ENGLISH_TRANSLATE } from './shared/properties/i18n/englishTranslator';",
      "export { formattersFor } from './shared/core/i18n/format';",
    ].join('\n'),
    resolveDir: repoPath('package.json').replace(/package\.json$/, ''),
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
});
const raw = require(output);
// The English forms of the wording functions, which take the language's messages and date format.
const model = {
  ...raw,
  timeLabel: (at) => raw.timeLabel(at, raw.formattersFor('en').formatDate),
  verdictLabel: (item) => raw.verdictLabel(item, raw.ENGLISH_TRANSLATE),
};

const lines = (count, make = (index) => `line ${index + 1}`) => Array.from({ length: count }, (_, index) => make(index)).join('\n');

test('a one-line edit has one deleted and one added row, numbered from the top of each file', () => {
  const diff = model.buildFileDiff('a\nb\nc\n', 'a\nB\nc\n');
  assert.equal(diff.kind, 'text');
  assert.deepEqual(
    diff.rows.map((row) => [row.kind, row.kind === 'deleted' ? row.before : row.after]),
    [
      ['context', 1],
      ['deleted', 2],
      ['added', 2],
      ['context', 3],
    ],
  );
  assert.deepEqual([diff.added, diff.removed], [1, 1]);
});

test('an edit deep in a long file stays an exact edit: shared head and tail are set aside before alignment', () => {
  const before = lines(6000);
  const after = before.replace('line 3000', 'line three thousand');
  const result = model.diffRows(before, after);
  assert.equal(result.exact, true, 'a 6,000-line file with one change is not "too large"');
  const changed = result.rows.filter((row) => row.kind !== 'context');
  assert.deepEqual(
    changed.map((row) => [row.kind, row.kind === 'deleted' ? row.before : row.after]),
    [
      ['added', 3000],
      ['deleted', 3000],
    ].sort(),
  );
});

test('deletions come before additions inside a run, whatever order the aligner produced', () => {
  const diff = model.buildFileDiff('keep\nx\ny\nkeep2', 'keep\nX\nY\nkeep2');
  assert.deepEqual(
    diff.rows.map((row) => row.kind),
    ['context', 'deleted', 'deleted', 'added', 'added', 'context'],
  );
});

test('a created file is all additions, a deleted file all removals, and neither side is required to exist', () => {
  const created = model.buildFileDiff(undefined, 'one\ntwo');
  assert.deepEqual([created.kind, created.added, created.removed], ['text', 2, 0]);
  const deleted = model.buildFileDiff('one\ntwo\nthree', undefined);
  assert.deepEqual([deleted.kind, deleted.added, deleted.removed], ['text', 0, 3]);
  assert.equal(model.buildFileDiff(undefined, '').kind, 'same', 'an empty created file has nothing to draw');
  assert.equal(model.buildFileDiff('', '').kind, 'same');
});

test('line endings: CRLF equals LF, and a file that only changed endings says so', () => {
  const crlf = model.buildFileDiff('a\r\nb\r\n', 'a\r\nB\r\n');
  assert.deepEqual([crlf.added, crlf.removed], [1, 1]);
  assert.ok(
    crlf.rows.every((row) => !row.text.includes('\r')),
    'no carriage return reaches a row',
  );
  assert.deepEqual(model.buildFileDiff('a\nb\n', 'a\r\nb\r\n'), { kind: 'same', lineEndingsChanged: true });
  assert.deepEqual(model.buildFileDiff('a\nb', 'a\nb'), { kind: 'same', lineEndingsChanged: false });
});

test('a final newline is not a line: adding one is not a change, and adding a line before it is exactly one', () => {
  assert.equal(model.buildFileDiff('a\nb', 'a\nb\n').kind, 'same');
  const diff = model.buildFileDiff('a\nb\n', 'a\nb\nc\n');
  assert.deepEqual([diff.added, diff.removed], [1, 0]);
});

test('binary text (a NUL byte on either side) has no rows', () => {
  assert.deepEqual(model.buildFileDiff('PNG\u0000data', 'PNG\u0000other'), { kind: 'binary' });
  assert.deepEqual(model.buildFileDiff(undefined, 'a\u0000b'), { kind: 'binary' });
});

test('a change too large to align is flagged inexact and still counted without the row cap', () => {
  const before = lines(2500, (index) => `old ${index}`);
  const after = lines(2500, (index) => `new ${index}`);
  const diff = model.buildFileDiff(before, after);
  assert.equal(diff.kind, 'text');
  assert.equal(diff.exact, false);
  assert.deepEqual([diff.added, diff.removed], [2500, 2500]);
  // The old row cap of lineDiff() still applies to that function, but the counts above came from every row.
  assert.ok(model.lineDiff(before, after).length <= model.AI_DIFF_LIMITS.rowsMax);
});

test('every old line and every new line appears exactly once, for random edits', () => {
  let seed = 7;
  const next = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  for (let round = 0; round < 60; round++) {
    const base = Array.from({ length: 1 + Math.floor(next() * 30) }, (_, index) => `l${index}`);
    const edited = base.filter(() => next() > 0.2);
    for (let index = 0; index < 4; index++) {
      edited.splice(Math.floor(next() * (edited.length + 1)), 0, `new${index}`);
    }
    const { rows } = model.diffRows(base.join('\n'), edited.join('\n'));
    assert.equal(rows.filter((row) => row.kind !== 'added').length, base.length);
    assert.equal(rows.filter((row) => row.kind !== 'deleted').length, edited.length);
    const afterNumbers = rows.filter((row) => row.kind !== 'deleted').map((row) => row.after);
    assert.deepEqual(
      afterNumbers,
      afterNumbers.map((_, index) => index + 1),
      'new line numbers count 1..n in order',
    );
  }
});

test('unchanged stretches fold into gaps, three lines of context stay, and the first press brings back what touches a change', () => {
  const before = lines(100);
  const after = before.replace('line 50', 'LINE 50');
  const diff = model.buildFileDiff(before, after);
  const folded = model.visibleBlocks(diff.rows, { context: 3, revealed: new Map(), rowsMax: 400 });
  const gaps = folded.blocks.filter((block) => block.kind === 'gap');
  assert.equal(gaps.length, 2, 'one before and one after the change');
  assert.deepEqual(
    folded.blocks.filter((block) => block.kind === 'row').map((block) => block.row.kind),
    ['context', 'context', 'context', 'deleted', 'added', 'context', 'context', 'context'],
  );
  assert.equal(gaps[0].hidden, 46);
  assert.equal(gaps[0].step, 40, 'one press shows at most 40 lines');
  const leading = gaps[0];
  const revealed = model.visibleBlocks(diff.rows, { context: 3, revealed: new Map([[leading.key, 40]]), rowsMax: 400 });
  const firstRow = revealed.blocks.find((block) => block.kind === 'row');
  assert.equal(revealed.blocks[0].kind, 'gap', 'the leading gap stays above what it revealed');
  assert.equal(revealed.blocks[0].hidden, 6);
  assert.equal(firstRow.row.after, 7, 'a leading gap reveals from its bottom edge, next to the change');
});

test('a fully revealed gap disappears, and a trailing gap reveals from its top edge', () => {
  const diff = model.buildFileDiff(lines(30), lines(30).replace('line 1\n', 'LINE 1\n'));
  const start = model.visibleBlocks(diff.rows, { context: 3, revealed: new Map(), rowsMax: 400 });
  const trailing = start.blocks.find((block) => block.kind === 'gap');
  assert.ok(trailing);
  const some = model.visibleBlocks(diff.rows, { context: 3, revealed: new Map([[trailing.key, 5]]), rowsMax: 400 });
  const rowsAfterChange = some.blocks.filter((block) => block.kind === 'row').map((block) => block.row.after);
  assert.ok(rowsAfterChange.includes(5 + 4), 'rows continue straight on from the context below the change');
  const all = model.visibleBlocks(diff.rows, { context: 3, revealed: new Map([[trailing.key, 1000]]), rowsMax: 400 });
  assert.equal(all.blocks.filter((block) => block.kind === 'gap').length, 0);
});

test('a stretch of one or two unchanged lines between changes is drawn, not hidden behind a button', () => {
  const before = lines(20);
  const after = before.replace('line 5', 'LINE 5').replace('line 9', 'LINE 9');
  const diff = model.buildFileDiff(before, after);
  const folded = model.visibleBlocks(diff.rows, { context: 3, revealed: new Map(), rowsMax: 400 });
  // Line 1 is the only line above the first change's context, so it is drawn; the eight lines at the end fold.
  assert.equal(folded.blocks.filter((block) => block.kind === 'gap').length, 1, 'only the tail folds');
  assert.equal(folded.blocks[0].kind, 'row');
  const tiny = model.buildFileDiff(lines(12), lines(12).replace('line 1\n', 'LINE 1\n').replace('line 8', 'LINE 8'));
  const blocks = model.visibleBlocks(tiny.rows, { context: 3, revealed: new Map(), rowsMax: 400 }).blocks;
  assert.equal(blocks.filter((block) => block.kind === 'gap').length, 0, 'a one-line stretch (line 12) after the last context is drawn');
});

test('a rewrite is cut at the row cap and says how many blocks it dropped', () => {
  const diff = model.buildFileDiff(
    lines(1000, (index) => `old ${index}`),
    lines(1000, (index) => `new ${index}`),
  );
  const compact = model.visibleBlocks(diff.rows, { context: 3, revealed: new Map(), rowsMax: model.DIFF_VIEW_LIMITS.rowsCompactMax });
  assert.equal(compact.blocks.length, 400);
  assert.equal(compact.cut, 2000 - 400);
  assert.equal(compact.total, 2000);
  const full = model.visibleBlocks(diff.rows, { context: 3, revealed: new Map(), rowsMax: model.DIFF_VIEW_LIMITS.rowsFullMax });
  assert.equal(full.cut, 0);
});

test('negative space of visibleBlocks: a negative context or a zero cap is a programmer error', () => {
  assert.throws(() => model.visibleBlocks([], { context: -1, revealed: new Map(), rowsMax: 10 }), /visibleBlocks: context is a count/);
  assert.throws(() => model.visibleBlocks([], { context: 1, revealed: new Map(), rowsMax: 0 }), /visibleBlocks: the row cap is positive/);
  assert.deepEqual(model.visibleBlocks([], { context: 3, revealed: new Map(), rowsMax: 10 }), { blocks: [], cut: 0, total: 0 });
});

test('word change marks only the words that changed, by character range in each line', () => {
  const change = model.wordChange('const total = price * 2;', 'const total = price * quantity;');
  assert.ok(change);
  const marked = (line, ranges) => ranges.map(([start, end]) => line.slice(start, end));
  assert.deepEqual(marked('const total = price * 2;', change.oldRanges), ['2']);
  assert.deepEqual(marked('const total = price * quantity;', change.newRanges), ['quantity']);
});

test('word change declines lines that are not one edit, and lines too long to compare', () => {
  assert.equal(model.wordChange('alpha beta gamma', 'completely different words here'), undefined, 'too little shared text');
  const long = 'word '.repeat(200);
  assert.equal(model.wordChange(long, `${long}x`), undefined, 'over the token and character bounds');
  assert.equal(model.wordChange('', ''), undefined);
});

test('word ranges pair the k-th deletion with the k-th addition and stop at the pair bound', () => {
  const diff = model.buildFileDiff('a one\nb two', 'a ONE\nb TWO');
  const ranges = model.wordRangesByRow(diff.rows);
  assert.deepEqual([...ranges.keys()].sort(), [0, 1, 2, 3]);
  const many = model.buildFileDiff(
    lines(500, (index) => `value ${index} old`),
    lines(500, (index) => `value ${index} new`),
  );
  assert.ok(model.wordRangesByRow(many.rows).size <= model.DIFF_VIEW_LIMITS.wordPairsMax * 2);
});

test('marking tokens cuts a coloured line at range edges and keeps each token its colour', () => {
  const line = [{ text: 'let ', style: { color: 'red' } }, { text: 'valueA' }];
  const marked = model.markTokens(line, [[4, 9]]);
  assert.deepEqual(
    marked.map((part) => [part.text, part.marked, part.style?.color]),
    [
      ['let ', 'same', 'red'],
      ['value', 'changed', undefined],
      ['A', 'same', undefined],
    ],
  );
  assert.equal(marked.map((part) => part.text).join(''), 'let valueA', 'no character is lost');
  assert.deepEqual(model.markTokens([], [[0, 3]]), []);
  assert.deepEqual(
    model.markTokens(line, []).map((part) => part.marked),
    ['same', 'same'],
  );
});

test('count labels use the true minus sign the gutter draws', () => {
  assert.equal(model.countsLabel({ added: 12, removed: 3 }), '+12 −3');
});

test('long messages fold by lines or characters, and short ones never do', () => {
  assert.equal(model.exceedsClamp('hello'), false);
  assert.equal(model.exceedsClamp(lines(40)), false);
  assert.equal(model.exceedsClamp(lines(41)), true);
  assert.equal(model.exceedsClamp('x'.repeat(4000)), false);
  assert.equal(model.exceedsClamp('x'.repeat(4001)), true);
  assert.equal(model.exceedsClamp('\n'.repeat(1_000_000)), true, 'bounded: it stops counting at the limit');
});

test('only the last user message may be edited or resent', () => {
  const items = [
    { kind: 'user', id: 0 },
    { kind: 'text', id: 1 },
    { kind: 'user', id: 2 },
    { kind: 'text', id: 3 },
  ];
  assert.equal(model.lastUserMessageId(items), 2);
  assert.equal(model.lastUserMessageId([{ kind: 'text', id: 0 }]), undefined);
  assert.equal(model.lastUserMessageId([]), undefined);
});

test('timestamps: a missing or impossible time shows nothing rather than "Invalid Date"', () => {
  assert.equal(model.timeLabel(undefined), undefined);
  assert.equal(model.timeLabel(0), undefined);
  assert.equal(model.timeLabel(Number.NaN), undefined);
  assert.equal(model.timeLabel(8.64e15 + 1), undefined);
  assert.match(model.timeLabel(Date.UTC(2026, 0, 2, 15, 4)), /\d/);
});

test('permission options read allow first, the recommended one is primary, digits and Esc pick by the order drawn', () => {
  const options = [
    { id: 'no', name: 'No', kind: 'reject_once' },
    { id: 'always', name: 'Always', kind: 'allow_always' },
    { id: 'yes', name: 'Yes', kind: 'allow_once' },
  ];
  assert.deepEqual(
    model.sortedOptions(options).map((option) => option.id),
    ['yes', 'always', 'no'],
  );
  assert.equal(model.primaryOption(options).id, 'yes');
  assert.equal(model.denyOption(options).id, 'no');
  assert.equal(model.optionForKey(options, '1').id, 'yes');
  assert.equal(model.optionForKey(options, '3').id, 'no');
  assert.equal(model.optionForKey(options, '4'), undefined, 'a key with no button answers nothing');
  assert.equal(model.optionForKey(options, '0'), undefined);
  assert.equal(model.optionForKey(options, 'a'), undefined);
  assert.equal(model.optionForKey(options, '12'), undefined);
});

test('a request that offers only allow options has nothing for Esc to deny, and one without allow has no primary', () => {
  assert.equal(model.denyOption([{ id: 'y', name: 'Y', kind: 'allow_once' }]), undefined);
  assert.equal(model.primaryOption([{ id: 'n', name: 'N', kind: 'reject_once' }]), undefined);
  assert.equal(model.primaryOption([{ id: 'a', name: 'A', kind: 'allow_always' }]).id, 'a');
});

test('the verdict names what the person did, and a cancelled turn is "Stopped"', () => {
  const options = [
    { id: 'y', name: 'Y', kind: 'allow_once' },
    { id: 'a', name: 'A', kind: 'allow_always' },
    { id: 'n', name: 'N', kind: 'reject_once' },
  ];
  const item = (answer) => ({ kind: 'permission', options, answer });
  assert.equal(model.verdictLabel(item(undefined)), undefined);
  assert.equal(model.verdictLabel(item({ outcome: 'selected', optionId: 'y' })), 'Allowed');
  assert.equal(model.verdictLabel(item({ outcome: 'selected', optionId: 'a' })), 'Always allowed');
  assert.equal(model.verdictLabel(item({ outcome: 'selected', optionId: 'n' })), 'Denied');
  assert.equal(model.verdictLabel(item({ outcome: 'cancelled', optionId: undefined })), 'Stopped');
  assert.equal(model.verdictLabel(item({ outcome: 'selected', optionId: 'gone' })), 'Answered');
});

test('titles lose the project root wherever it appears, and are left alone when the root is unknown', () => {
  assert.equal(model.plainTitle('Edit /site/src/a.ts and /site/b.ts', '/site'), 'Edit src/a.ts and b.ts');
  assert.equal(model.plainTitle('Edit /x/a.ts', ''), 'Edit /x/a.ts');
  assert.equal(model.plainTitle('Edit /x/a.ts', '/'), 'Edit /x/a.ts');
});
