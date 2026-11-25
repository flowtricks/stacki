// Goal: shared/engine/diff.ts computes exact edit distances and a valid minimum edit
// script, and, when a budget runs out, degrades to a typed `coarse` outcome:
// the byte blocks proven equal and aligned, never an approximate script and
// never a refusal, because Stacki has no size limit (plan §10, §14).
// Method: (1) seeded random byte strings over tiny alphabets, where repeats and
// tied scripts are the norm, checked against the brute-force full tables in
// referenceDiff.ts: the total distance, the prefix and suffix distance at
// every point of the edit graph, and a traceback whose hunks rebuild the
// target and cost exactly the distance; (2) hand-built edge cases — empty
// files, identical files, pure insertions and deletions; (3) each budget at,
// just under and just past its bound; (4) the preconditions assert with pinned
// messages; (5) a 1 MB file with a small edit stays far inside the budget;
// (6) diffing leaves its inputs untouched, bytes read from disk included.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coarseHunks, diffBytes, diffHunks, DIFF_BUDGET, type ByteDiff, type DiffBudget } from '#dist/shared/engine/diff.js';
import { LIMITS } from '#dist/shared/core/limits.js';
import { encodeUtf8, toByteString, type ByteString } from '#dist/shared/core/span.js';
import { Prng } from './prng.ts';
import { referenceTables } from './referenceDiff.ts';

const SEEDS = 1_500;

function randomBytes(prng: Prng, lengthMax: number, alphabet: number): ByteString {
  const length = prng.below(lengthMax + 1);
  return toByteString(Uint8Array.from({ length }, () => 0x61 + prng.below(alphabet)));
}

function computed(source: ByteString, target: ByteString, budget: DiffBudget = DIFF_BUDGET): ByteDiff {
  const outcome = diffBytes(source, target, budget);
  assert.equal(outcome.tag, 'computed');
  if (outcome.tag !== 'computed') {
    throw new Error('unreachable');
  }
  return outcome.diff;
}

/** Apply hunks to the source; they must ascend, not overlap, and cost the distance. */
function rebuild(diff: ByteDiff): { readonly bytes: ByteString; readonly cost: number } {
  const parts: Uint8Array[] = [];
  let cursor = 0;
  let cost = 0;
  let targetCursor = 0;
  for (const hunk of diffHunks(diff)) {
    assert.ok(hunk.source.start >= cursor, 'hunks ascend in the source');
    assert.ok(hunk.target.start >= targetCursor, 'hunks ascend in the target');
    const hunkCost = hunk.source.end - hunk.source.start + hunk.target.end - hunk.target.start;
    assert.ok(hunkCost > 0, 'no empty hunk');
    parts.push(diff.source.subarray(cursor, hunk.source.start));
    parts.push(diff.target.subarray(hunk.target.start, hunk.target.end));
    cost += hunkCost;
    cursor = hunk.source.end;
    targetCursor = hunk.target.end;
  }
  parts.push(diff.source.subarray(cursor));
  return { bytes: toByteString(new Uint8Array(Buffer.concat(parts))), cost };
}

test('distances at every point agree with the full tables on seeded inputs', () => {
  for (let seed = 0; seed < SEEDS; seed++) {
    const prng = new Prng(seed);
    const alphabet = 1 + prng.below(4);
    const source = randomBytes(prng, 16, alphabet);
    const target = randomBytes(prng, 16, alphabet);
    const diff = computed(source, target);
    const tables = referenceTables(source, target);
    assert.equal(diff.distance, tables.distance, `seed ${seed}: distance`);
    for (let x = 0; x <= source.length; x++) {
      for (let y = 0; y <= target.length; y++) {
        const before = tables.before(x, y);
        const after = tables.after(x, y);
        const beyond = (value: number) => (value <= tables.distance ? value : undefined);
        assert.equal(diff.distanceBefore(x, y), beyond(before), `seed ${seed}: before (${x}, ${y})`);
        assert.equal(diff.distanceAfter(x, y), beyond(after), `seed ${seed}: after (${x}, ${y})`);
      }
    }
    const rebuilt = rebuild(diff);
    assert.deepEqual(rebuilt.bytes, target, `seed ${seed}: hunks rebuild the target`);
    assert.equal(rebuilt.cost, diff.distance, `seed ${seed}: hunks cost the distance`);
  }
});

test('edge cases: empty, identical, pure insertion, pure deletion', () => {
  const empty = encodeUtf8('');
  const page = encodeUtf8('<Hero title="Old" />\n');
  assert.equal(computed(empty, empty).distance, 0);
  assert.deepEqual(diffHunks(computed(empty, empty)), []);
  assert.equal(computed(page, page).distance, 0);
  assert.deepEqual(diffHunks(computed(page, page)), []);
  const inserted = computed(empty, page);
  assert.equal(inserted.distance, page.length);
  assert.deepEqual(
    diffHunks(inserted).map((hunk) => [hunk.source.start, hunk.source.end, hunk.target.start, hunk.target.end]),
    [[0, 0, 0, page.length]],
  );
  const deleted = computed(page, empty);
  assert.equal(deleted.distance, page.length);
  assert.equal(deleted.distanceBefore(page.length, 0), page.length);
  assert.equal(deleted.distanceAfter(0, 0), page.length);
  // One byte changed in the middle: one hunk, one byte out and one in.
  const changed = computed(encodeUtf8('title="Old"'), encodeUtf8('title="Odd"'));
  assert.equal(changed.distance, 2);
  assert.equal(rebuild(changed).cost, 2);
});

// What a coarse outcome must prove: blocks ascend, are disjoint, and hold equal
// bytes at equal relative places in both files.
function coarseBlocks(source: ByteString, target: ByteString, budget: DiffBudget) {
  const outcome = diffBytes(source, target, budget);
  assert.equal(outcome.tag, 'coarse');
  if (outcome.tag !== 'coarse') {
    throw new Error('unreachable');
  }
  let sourceEnd = 0;
  let targetEnd = 0;
  for (const block of outcome.diff.blocks) {
    assert.ok(block.length > 0);
    assert.ok(block.sourceStart >= sourceEnd);
    assert.ok(block.targetStart >= targetEnd);
    assert.deepEqual(
      source.subarray(block.sourceStart, block.sourceStart + block.length),
      target.subarray(block.targetStart, block.targetStart + block.length),
    );
    sourceEnd = block.sourceStart + block.length;
    targetEnd = block.targetStart + block.length;
  }
  return outcome.diff;
}

test('the distance budget: at the bound computes, one past it degrades to a coarse diff', () => {
  const source = encodeUtf8('abcdef');
  const target = encodeUtf8('abXYef'); // Two out, two in: distance 4.
  assert.equal(computed(source, target, { workMax: DIFF_BUDGET.workMax, distanceMax: 4 }).distance, 4);
  for (const distanceMax of [3, 0]) {
    const coarse = coarseBlocks(source, target, { workMax: DIFF_BUDGET.workMax, distanceMax });
    // The shared prefix `ab` and suffix `ef` are proven; the middle is not.
    assert.deepEqual(coarse.blocks, [
      { sourceStart: 0, targetStart: 0, length: 2 },
      { sourceStart: 4, targetStart: 4, length: 2 },
    ]);
    assert.deepEqual(
      coarseHunks(coarse).map((hunk) => [hunk.source.start, hunk.source.end, hunk.target.start, hunk.target.end]),
      [[2, 4, 2, 4]],
    );
  }
});

test('the work budget: an exact search that costs more than the linear scans degrades to a coarse diff', () => {
  // All `a` against all `a` but the last 200: the frontier cells alone are
  // about D² = 160 000, far past four linear passes over 2 000 bytes.
  const source = encodeUtf8('a'.repeat(1_000));
  const target = encodeUtf8(`${'a'.repeat(800)}${'b'.repeat(200)}`);
  const exact = computed(source, target, { workMax: DIFF_BUDGET.workMax, distanceMax: 1_000 });
  assert.equal(exact.distance, 400);
  assert.ok(exact.workSpent > 4 * (source.length + target.length), 'the exact search spent more than the linear allowance');
  const coarse = coarseBlocks(source, target, { workMax: 0, distanceMax: 1_000 });
  assert.deepEqual(coarse.blocks, [{ sourceStart: 0, targetStart: 0, length: 800 }]);
});

test('a small edit in a file of any size never trips the work budget by size alone', () => {
  // The budget is spent beyond the linear scans, so even a zero budget computes
  // an exact diff when the cost is just reading the file.
  const page = encodeUtf8('line\n'.repeat(40_000));
  const edited = encodeUtf8(`${'line\n'.repeat(20_000)}new\n${'line\n'.repeat(20_000)}`);
  const diff = computed(page, edited, { workMax: 0, distanceMax: 16 });
  assert.equal(diff.distance, 4);
});

test('a coarse diff aligns by unique lines: edits far apart in a big rewrite keep their islands', () => {
  // Three thousand bytes changed at each end of a file with a long unchanged
  // middle: the exact search cannot cross distance 2 048 + 2 048, but the unique
  // lines of the middle anchor it, so the middle is proven equal and aligned.
  const lines = Array.from({ length: 2_000 }, (_, index) => `<p id="row-${index}">content of row ${index}</p>\n`);
  const head = (text: string) => text.repeat(100);
  const source = encodeUtf8(`${head('old head ')}\n${lines.join('')}${head('old tail ')}\n`);
  const target = encodeUtf8(`${head('new HEAD 12 ')}\n${lines.join('')}${head('new TAIL 12 ')}\n`);
  const coarse = coarseBlocks(source, target, DIFF_BUDGET);
  const middleStart = lines.join('').length;
  const covered = coarse.blocks.reduce((total, block) => total + block.length, 0);
  assert.ok(covered >= middleStart, `${covered} bytes proven of ${middleStart}`);
  // A byte in the middle maps through, shifted by the change in the head.
  const shift = encodeUtf8(head('new HEAD 12 ')).length - encodeUtf8(head('old head ')).length;
  const inside = encodeUtf8(`${head('old head ')}\n`).length + 1_000;
  const block = coarse.blocks.find((candidate) => candidate.sourceStart <= inside && inside < candidate.sourceStart + candidate.length);
  assert.ok(block !== undefined, 'the middle byte lies in a proven block');
  assert.equal(block.targetStart - block.sourceStart, shift);
});

test('preconditions assert with pinned messages', () => {
  const bytes = encodeUtf8('abc');
  assert.throws(
    () => diffBytes(bytes, bytes, { workMax: LIMITS.diffWorkMax + 1, distanceMax: 1 }),
    /Assertion failed: The diff budget stays inside the work bound/,
  );
  assert.throws(
    () => diffBytes(bytes, bytes, { workMax: 1, distanceMax: LIMITS.diffDistanceMax + 1 }),
    /Assertion failed: The diff budget stays inside the distance/,
  );
  const diff = computed(bytes, encodeUtf8('abd'));
  assert.throws(() => diff.distanceBefore(4, 0), /Assertion failed: A diff point lies inside the source/);
  assert.throws(() => diff.distanceAfter(0, 4), /Assertion failed: A diff point lies inside the target/);
  assert.throws(() => diff.distanceBefore(-1, 0), /Assertion failed: A diff point lies right of the grid start/);
  assert.throws(() => diff.distanceBefore(0.5, 0), /Assertion failed: A diff point has an integer x/);
});

test('a 1 MB page with a small edit stays far inside the budget', () => {
  const block = '<section class="card">\n  <h2 title="Old">Heading</h2>\n  <p>Body text.</p>\n</section>\n';
  const page = block.repeat(Math.ceil(1_000_000 / block.length));
  const middle = Math.floor(page.length / 2);
  const edited = `${page.slice(0, middle)}<!-- external -->${page.slice(middle)}`;
  const diff = computed(encodeUtf8(page), encodeUtf8(edited));
  assert.equal(diff.distance, '<!-- external -->'.length);
  // Each direction scans the file once; the edit adds a few thousand units.
  assert.ok(diff.workSpent < 2 * (page.length + edited.length), `work ${diff.workSpent}`);
  assert.ok(diff.workSpent < LIMITS.diffWorkMax / 10);
  assert.deepEqual(rebuild(diff).bytes, encodeUtf8(edited));
});

// Found by the step-3 spike: bytes read with fs are a Buffer, whose `slice` is
// a view, so the backward run once reversed the caller's snapshot in place.
test('diffing never mutates its inputs, bytes that came from a Buffer included', () => {
  const page = '<section class="card">\n  <h2 title="Old">Heading</h2>\n</section>\n'.repeat(64);
  const edited = page.replace('title="Old"', 'title="New"');
  const source = toByteString(Buffer.from(page, 'utf8'));
  const target = toByteString(Buffer.from(edited, 'utf8'));
  const diff = computed(source, target);
  assert.equal(diff.distance, 6);
  assert.deepEqual(source, encodeUtf8(page), 'the source bytes are unchanged');
  assert.deepEqual(target, encodeUtf8(edited), 'the target bytes are unchanged');
});
