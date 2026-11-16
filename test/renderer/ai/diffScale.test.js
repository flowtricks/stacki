// Goal: the AI panel's diff has no size limit. A file of hundreds of thousands of lines with
// edits spread through it is aligned line by line (not shown as wholly replaced), every row is
// reachable by pages, and the work grows with the file, not with its square.
// Method: before/after texts are generated in memory, sized by scaleMegabytes(), with a known
// number of changed lines and an inserted block. diffRows must report exactly those counts and
// stay exact; the rows are checked to account for every line of both sides once. A second pair
// four times shorter gives the time ratio, which a quadratic alignment would blow past.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule.js');
const { measureOperation, scaleMegabytes } = loadRenderer('test/helpers/scaleFixtures.ts');
const { diffRows } = loadRenderer('src/features/ai/lineDiff.ts');

const LINE_CHARS = 40;

function pair(lineCount) {
  const before = [];
  const after = [];
  for (let index = 0; index < lineCount; index++) {
    const text = `const value${index} = compute(${index}); // line`;
    before.push(text);
    after.push(index % 1000 === 500 ? `const changed${index} = recompute(${index}); // edited` : text);
    if (index % 25_000 === 0) {
      after.push(`// inserted block ${index}`, `// inserted second line ${index}`);
    }
  }
  return { before: before.join('\n'), after: after.join('\n'), changed: Math.floor((lineCount + 499) / 1000), inserted: 2 * Math.ceil(lineCount / 25_000) };
}

test('a file of hundreds of thousands of lines is aligned line by line', async () => {
  const lineCount = Math.floor((scaleMegabytes() * 1024 * 1024) / (LINE_CHARS + 10));
  assert.ok(lineCount > 300_000, 'the generated file is hundreds of thousands of lines');
  const texts = pair(lineCount);
  const run = await measureOperation('lineDiff-large', `${lineCount} lines`, async () => diffRows(texts.before, texts.after));
  const rows = run.value.rows;
  assert.equal(run.value.exact, true);
  assert.equal(rows.filter((row) => row.kind === 'deleted').length, texts.changed);
  assert.equal(rows.filter((row) => row.kind === 'added').length, texts.changed + texts.inserted);
  assert.equal(rows.filter((row) => row.kind === 'context').length, lineCount - texts.changed);
});

test('the alignment grows in proportion to the file', async () => {
  const small = pair(100_000);
  const large = pair(400_000);
  const first = await measureOperation('lineDiff-small', '100000 lines', async () => diffRows(small.before, small.after));
  const second = await measureOperation('lineDiff-4x', '400000 lines', async () => diffRows(large.before, large.after));
  assert.ok(second.wallMs < Math.max(first.wallMs, 50) * 10, `${first.wallMs} ms became ${second.wallMs} ms`);
});
