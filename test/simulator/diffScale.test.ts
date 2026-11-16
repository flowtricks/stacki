// Goal: the diff and the span mapper have no size limit. A file of tens of
// megabytes diffs exactly when the edit is small, and degrades to the blocks it
// can prove equal (never refuses) when the edit is huge or the content is so
// repetitive that an exact script is not worth its cost; a span inside a proven
// block still maps to the right bytes, and a span over an unproven region is
// `gone`, never a guess. The code-patch diff, which feeds the editor's saves,
// holds the same: any pair of texts patches, and the patch applies.
// Method: generate large inputs in memory (nothing is written to the repository)
// sized by `scaleMegabytes()`, run the real diff over them, check the outcome's
// tag and the blocks it proves, and print one `SCALE` line per scenario with
// the wall time. The diff is synchronous pure work, so what is asserted about
// time is that it stays linear: each scenario must finish inside a generous
// per-megabyte allowance, which a quadratic blow-up would miss by orders of
// magnitude.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyCodePatch, diffCodePatch } from '#dist/shared/engine/codePatch.js';
import { diffBytes, DIFF_BUDGET, type CoarseDiff } from '#dist/shared/engine/diff.js';
import { mapSpanThroughOutcome } from '#dist/shared/engine/mapSpan.js';
import { encodeUtf8, toByteSpan, toByteString } from '#dist/shared/core/span.js';
import { measureOperation, scaleMegabytes } from '../helpers/scaleFixtures.ts';

const MEGABYTE = 1024 * 1024;
/** Milliseconds one megabyte of diff work may take on the slowest machine we run on. */
const MS_PER_MEGABYTE_MAX = 600;

function rows(count: number, label: string): string {
  const parts: string[] = [];
  for (let index = 0; index < count; index++) {
    parts.push(`<p id="${label}-${index}">content of row ${index} in ${label}</p>\n`);
  }
  return parts.join('');
}

// Rows of about 50 bytes fill the requested megabytes.
function rowCountFor(megabytes: number): number {
  return Math.floor((megabytes * MEGABYTE) / 50);
}

function within(wallMs: number, megabytes: number, what: string): void {
  assert.ok(wallMs < MS_PER_MEGABYTE_MAX * megabytes + 2_000, `${what} took ${Math.round(wallMs)} ms for ${megabytes} MB`);
}

test('a big file with a small edit diffs exactly, and spans on both sides map through it', async () => {
  const megabytes = scaleMegabytes();
  const count = rowCountFor(megabytes);
  const head = rows(count / 2, 'a');
  const tail = rows(count / 2, 'b');
  const source = encodeUtf8(head + tail);
  const inserted = '<!-- edited elsewhere -->\n';
  const target = encodeUtf8(head + inserted + tail);
  const { value: outcome, wallMs } = await measureOperation('diff exact', `${megabytes} MB, one inserted line`, async () =>
    diffBytes(source, target, DIFF_BUDGET),
  );
  assert.equal(outcome.tag, 'computed', 'a small edit never degrades, however big the file');
  within(wallMs, megabytes, 'exact diff');
  const before = mapSpanThroughOutcome(outcome, toByteSpan(1_000, 1_020));
  assert.deepEqual(before, { tag: 'resolved', span: toByteSpan(1_000, 1_020) });
  const afterStart = encodeUtf8(head).length + 5_000;
  const after = mapSpanThroughOutcome(outcome, toByteSpan(afterStart, afterStart + 30));
  assert.equal(after.tag, 'resolved');
  if (after.tag === 'resolved') {
    assert.equal(after.span.start, afterStart + encodeUtf8(inserted).length, 'bytes after the edit move by the inserted length');
  }
});

test('a big file edited past the exact search degrades to proven blocks and still maps the unchanged middle', async () => {
  const megabytes = scaleMegabytes();
  const count = rowCountFor(megabytes);
  const middle = rows(count, 'm');
  // Eight kilobytes rewritten at each end: more than the exact search's
  // distance bound, so only the unique lines of the middle can align it.
  const headOld = 'old head line\n'.repeat(600);
  const headNew = 'new HEAD content\n'.repeat(500);
  const tailOld = 'old tail line\n'.repeat(600);
  const tailNew = 'new TAIL content\n'.repeat(500);
  const source = encodeUtf8(headOld + middle + tailOld);
  const target = encodeUtf8(headNew + middle + tailNew);
  const { value: outcome, wallMs } = await measureOperation('diff coarse', `${megabytes} MB, rewritten ends`, async () =>
    diffBytes(source, target, DIFF_BUDGET),
  );
  assert.equal(outcome.tag, 'coarse');
  within(wallMs, megabytes, 'coarse diff');
  if (outcome.tag !== 'coarse') {
    throw new Error('unreachable: the tag was asserted');
  }
  const coarse: CoarseDiff = outcome.diff;
  const middleBytes = encodeUtf8(middle).length;
  const proven = coarse.blocks.reduce((total, block) => total + block.length, 0);
  assert.ok(proven >= middleBytes, `${proven} of ${middleBytes} middle bytes proven`);
  const shift = encodeUtf8(headNew).length - encodeUtf8(headOld).length;
  const inside = encodeUtf8(headOld).length + Math.floor(middleBytes / 2);
  const mapped = mapSpanThroughOutcome(outcome, toByteSpan(inside, inside + 40));
  assert.deepEqual(mapped, { tag: 'resolved', span: toByteSpan(inside + shift, inside + shift + 40) });
  // A span over the rewritten head is not proven kept: `gone`, never a guess.
  assert.deepEqual(mapSpanThroughOutcome(outcome, toByteSpan(10, 40)), { tag: 'gone' });
});

test('a file with nothing in common still diffs: no block is proven, every span is gone, nothing is refused', async () => {
  const megabytes = Math.max(1, Math.floor(scaleMegabytes() / 2));
  const count = rowCountFor(megabytes);
  const source = encodeUtf8(rows(count, 'left'));
  const target = encodeUtf8(rows(count, 'right'));
  const { value: outcome, wallMs } = await measureOperation('diff disjoint', `${megabytes} MB against ${megabytes} MB`, async () =>
    diffBytes(source, target, DIFF_BUDGET),
  );
  assert.equal(outcome.tag, 'coarse');
  within(wallMs, megabytes, 'disjoint diff');
  assert.deepEqual(mapSpanThroughOutcome(outcome, toByteSpan(5_000, 5_020)), { tag: 'gone' });
});

test('a file of one repeated byte diffs in linear time and maps spans only where they have one place', async () => {
  const megabytes = scaleMegabytes();
  const size = megabytes * MEGABYTE;
  const sourceBytes = new Uint8Array(size).fill(0x61);
  const targetBytes = new Uint8Array(size).fill(0x61);
  targetBytes.fill(0x62, size - 40);
  const source = toByteString(sourceBytes);
  const target = toByteString(targetBytes);
  const { value: outcome, wallMs } = await measureOperation('diff repetitive', `${megabytes} MB of one byte, 40 changed`, async () =>
    diffBytes(source, target, DIFF_BUDGET),
  );
  within(wallMs, megabytes, 'repetitive diff');
  // Either outcome is honest. Where every byte repeats, no span has one place to
  // go: it is refused as ambiguous, or, in a coarse diff, kept at its own bytes.
  const mapped = mapSpanThroughOutcome(outcome, toByteSpan(1_000, 1_100));
  assert.ok(mapped.tag === 'ambiguous' || (mapped.tag === 'resolved' && mapped.span.start === 1_000), `mapped as ${mapped.tag}`);
});

test('the code patch of two big texts applies, whether the edit is small or the texts differ throughout', async () => {
  const megabytes = Math.max(1, Math.floor(scaleMegabytes() / 2));
  const count = rowCountFor(megabytes);
  const base = rows(count, 'x');
  const small = base.replace('row 100 ', 'row one hundred ');
  const smallPatch = await measureOperation('codepatch small', `${megabytes} MB, one word`, async () => diffCodePatch(base, small));
  assert.ok(smallPatch.value.ok);
  if (smallPatch.value.ok) {
    assert.equal(smallPatch.value.value.length, 1, 'one small edit is one hunk');
    assert.equal(applyCodePatch(base, smallPatch.value.value), small);
  }
  within(smallPatch.wallMs, megabytes, 'small code patch');
  const other = rows(count, 'y');
  const wholePatch = await measureOperation('codepatch rewrite', `${megabytes} MB against ${megabytes} MB`, async () => diffCodePatch(base, other));
  assert.ok(wholePatch.value.ok, 'a rewrite as large as the file is never refused');
  if (wholePatch.value.ok) {
    assert.equal(applyCodePatch(base, wholePatch.value.value), other);
  }
  within(wholePatch.wallMs, megabytes, 'rewrite code patch');
});
