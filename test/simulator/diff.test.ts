// Goal: shared/engine/diff.ts computes exact edit distances and a valid minimum edit
// script, and stops with a typed `too-costly` outcome — never a partial or
// approximate diff — when a budget runs out (plan §10, §14).
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
import { diffBytes, diffHunks, DIFF_BUDGET, type ByteDiff, type DiffBudget } from '#dist/shared/engine/diff.js';
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

test('the distance budget: at the bound computes, one past it is too-costly', () => {
  const source = encodeUtf8('abcdef');
  const target = encodeUtf8('abXYef'); // Two out, two in: distance 4.
  assert.equal(computed(source, target, { workMax: DIFF_BUDGET.workMax, distanceMax: 4 }).distance, 4);
  assert.deepEqual(diffBytes(source, target, { workMax: DIFF_BUDGET.workMax, distanceMax: 3 }), {
    tag: 'too-costly',
  });
  assert.deepEqual(diffBytes(source, target, { workMax: DIFF_BUDGET.workMax, distanceMax: 0 }), {
    tag: 'too-costly',
  });
});

test('the work budget: exhausted in frontier cells or in a long snake is too-costly', () => {
  const source = encodeUtf8('x'.repeat(1_000));
  const target = encodeUtf8(`${'x'.repeat(1_000)}y`);
  const spent = computed(source, target).workSpent;
  assert.ok(spent > 2_000, 'both directions scan the shared run');
  assert.equal(computed(source, target, { workMax: spent, distanceMax: 8 }).workSpent, spent);
  // One unit short fails, whichever loop reaches the bound first.
  for (const workMax of [spent - 1, 1_500, 500, 1, 0]) {
    assert.deepEqual(diffBytes(source, target, { workMax, distanceMax: 8 }), { tag: 'too-costly' });
  }
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
