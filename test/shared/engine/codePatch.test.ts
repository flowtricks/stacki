// Goal: the code editor's patch (shared/engine/codePatch.ts, step 8) is the byte
// diff from its baseline to its text — exact, witnessed, on whole code points,
// and bounded. Applying it gives back the text for every fixture under seeded
// edits (Unicode, CRLF, BOM, malformed intermediates included); separate edits
// stay separate hunks so an outside edit between them still merges; a text
// past the file bound fails with `resource-limit` and nothing partial comes
// back. The three-way merge used when a save lands while the user kept typing
// merges disjoint changes and refuses touching or overlapping ones.
// Method: known-good cases with hand-derived hunks; a seeded sweep over every
// corpus, editor-core and round-trip fixture compared against applying the
// patch (the slow, obviously right reference is the text itself); then each
// known-bad shape.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { applyCodePatch, codePatchBytes, diffCodePatch, mergeTyping, type CodeHunk } from '#dist/shared/engine/codePatch.js';
import { LIMITS } from '#dist/shared/core/limits.js';
import { shiftUntouched } from '#dist/shared/engine/rebase.js';
import { encodeUtf8, toByteSpan } from '#dist/shared/core/span.js';

// Repository paths: the runner starts every suite at the repository root.
const FIXTURE_DIRECTORIES = ['test/corpus', 'test/fixtures/editor-core', 'test/fixtures/round-trip'];

function fixtures(): readonly {
  readonly name: string;
  readonly text: string;
}[] {
  return FIXTURE_DIRECTORIES.flatMap((directory) =>
    fs
      .readdirSync(path.resolve(directory))
      .filter((name) => /\.(astro|mdx?|css)$/.test(name))
      .map((name) => ({
        name,
        text: fs.readFileSync(path.resolve(directory, name), 'utf8'),
      })),
  );
}

function patch(baseline: string, next: string): readonly CodeHunk[] {
  const result = diffCodePatch(baseline, next);
  assert.ok(result.ok, 'a text inside the bounds has a patch');
  return result.value;
}

// A small linear congruential generator: the sweep is the same on every run.
function prng(seed: number): (below: number) => number {
  let state = seed >>> 0;
  return (below) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state % below;
  };
}

const INSERTS = ['x', 'é', '🎉', '\r\n', '<div', '{', '---\n', '</p>', 'naïve 👋🏽'];

// A code-point-safe offset: never inside a surrogate pair.
function offsetIn(text: string, roll: number): number {
  let at = roll % (text.length + 1);
  const code = text.charCodeAt(at - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    at -= 1;
  }
  return at;
}

function mutate(text: string, next: (below: number) => number): string {
  const at = offsetIn(text, next(1_000_003));
  const end = offsetIn(text, at + next(12));
  switch (next(3)) {
    case 0:
      return text.slice(0, at) + INSERTS[next(INSERTS.length)] + text.slice(at);
    case 1:
      return text.slice(0, at) + text.slice(Math.max(at, end));
    default:
      return text.slice(0, at) + INSERTS[next(INSERTS.length)] + text.slice(Math.max(at, end));
  }
}

test('equal texts need no patch; one edit is one hunk with its witness', () => {
  assert.deepEqual(patch('<p>a</p>', '<p>a</p>'), []);
  assert.deepEqual(patch('<p title="Old">', '<p title="New">'), [{ span: { start: 10, end: 13 }, expected: 'Old', text: 'New' }]);
  assert.deepEqual(patch('ab', 'axb'), [{ span: { start: 1, end: 1 }, expected: '', text: 'x' }]);
  assert.deepEqual(patch('abc', ''), [{ span: { start: 0, end: 3 }, expected: 'abc', text: '' }]);
});

test('hunks sit on whole code points, in bytes of the baseline', () => {
  // é and è share their lead byte: a byte diff alone would replace half a character.
  assert.deepEqual(patch('café!', 'cafè!'), [{ span: { start: 3, end: 5 }, expected: 'é', text: 'è' }]);
  // Offsets count bytes: the emoji before the edit is four of them.
  assert.deepEqual(patch('🎉 a', '🎉 b'), [{ span: { start: 5, end: 6 }, expected: 'a', text: 'b' }]);
  const bom = '﻿---\r\ntitle: x\r\n---\r\n<p>x</p>\r\n';
  const [hunk] = patch(bom, bom.replace('<p>x', '<p>y'));
  assert.deepEqual(hunk, { span: { start: 26, end: 27 }, expected: 'x', text: 'y' }, 'BOM counted');
});

test('edits far apart stay apart; a word rewritten in place is one hunk', () => {
  const lines = Array.from({ length: 40 }, (_, index) => `<p>line ${index}</p>`).join('\n');
  const both = lines.replace('line 3<', 'line three<').replace('line 36<', 'line 36!<');
  const hunks = patch(lines, both);
  assert.equal(hunks.length, 2, 'an outside edit between them can still be merged');
  assert.ok(hunks.every((hunk) => hunk.text !== ''));
  const rewritten = patch('<h1>Welcome home</h1>', '<h1>Wandering alone</h1>');
  assert.equal(rewritten.length, 1, 'small matched islands join the hunk around them');
});

test('seeded edits of every fixture: the patch gives the text back exactly', () => {
  const all = fixtures();
  assert.ok(all.length >= 50, `the sweep covers the fixtures: ${all.length}`);
  let checked = 0;
  for (const [index, { name, text }] of all.entries()) {
    const next = prng(index + 1);
    let current = text;
    for (let round = 0; round < 12; round++) {
      const edited = mutate(current, next);
      const hunks = patch(current, edited);
      assert.equal(applyCodePatch(current, hunks), edited, `${name}, round ${round}`);
      for (const [at, hunk] of hunks.entries()) {
        const previous = hunks[at - 1];
        assert.ok(previous === undefined || previous.span.end < hunk.span.start, 'disjoint');
        const bytes = Buffer.from(current, 'utf8').subarray(hunk.span.start, hunk.span.end);
        assert.equal(bytes.toString('utf8'), hunk.expected, 'the witness is the baseline slice');
      }
      assert.equal(
        codePatchBytes(hunks),
        hunks.reduce((total, hunk) => total + Buffer.byteLength(hunk.text), 0),
      );
      current = edited;
      checked++;
    }
  }
  assert.equal(checked, all.length * 12);
});

test('a change past the diff budget is one region, still exact', () => {
  const baseline = `<main>${'a'.repeat(3_000)}</main>`;
  const next = `<main>${'b'.repeat(3_000)}</main>`;
  const hunks = patch(baseline, next);
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0]?.span, { start: 6, end: 3_006 });
  assert.equal(applyCodePatch(baseline, hunks), next);
});

test('a text past the file bound fails with resource-limit, never a truncated patch', () => {
  const huge = 'x'.repeat(LIMITS.sourceBytesMax + 1);
  assert.deepEqual(diffCodePatch('<p/>', huge), {
    ok: false,
    error: 'resource-limit',
  });
  // Multi-byte text is measured in bytes, not characters.
  const wide = 'é'.repeat(Math.floor(LIMITS.sourceBytesMax / 2) + 1);
  assert.ok(wide.length < LIMITS.sourceBytesMax, 'the character count alone fits');
  assert.deepEqual(diffCodePatch('', wide), {
    ok: false,
    error: 'resource-limit',
  });
});

test('applying a patch checks every witness', () => {
  assert.throws(
    () => applyCodePatch('<p>a</p>', [{ span: toByteSpan(3, 4), expected: 'b', text: 'c' }]),
    /Assertion failed: A hunk replaces the text it names/,
  );
  assert.throws(() => applyCodePatch('é', [{ span: toByteSpan(1, 2), expected: '', text: '' }]), /Assertion failed: A hunk starts and ends on code points/);
});

test('mergeTyping merges disjoint changes and refuses touching ones', () => {
  const base = '<h1>Title</h1>\n<p>Body</p>\n<footer>End</footer>\n';
  const ours = base.replace('Title', 'Heading');
  const theirs = base.replace('End', 'Fin');
  assert.deepEqual(mergeTyping(base, ours, theirs), {
    ok: true,
    value: '<h1>Heading</h1>\n<p>Body</p>\n<footer>Fin</footer>\n',
  });
  assert.deepEqual(mergeTyping(base, base, theirs), {
    ok: true,
    value: theirs,
  });
  assert.deepEqual(mergeTyping(base, ours, base), { ok: true, value: ours });
  assert.deepEqual(mergeTyping(base, ours, ours), { ok: true, value: ours });
  const overlap = base.replace('Title', 'Name');
  assert.deepEqual(mergeTyping(base, ours, overlap), {
    ok: false,
    error: 'merge-conflict',
  });
  // Two insertions at one place cannot be ordered.
  const left = base.replace('<p>', '<p>X');
  const right = base.replace('<p>', '<p>Y');
  assert.deepEqual(mergeTyping(base, left, right), {
    ok: false,
    error: 'merge-conflict',
  });
  // A malformed intermediate merges like any text.
  const broken = base.replace('<p>Body</p>', '<p>Body');
  assert.deepEqual(mergeTyping(base, broken, theirs), {
    ok: true,
    value: '<h1>Title</h1>\n<p>Body\n<footer>Fin</footer>\n',
  });
});

test('a code hunk rebases through commits that do not touch it, and only those', () => {
  const splice = (start: number, end: number, replacement: string) => ({
    range: toByteSpan(start, end),
    expectedBytes: encodeUtf8('x'.repeat(end - start)),
    replacementBytes: encodeUtf8(replacement),
  });
  const hunk = toByteSpan(10, 14);
  // Wholly before: shifted by the size change. Wholly after: unchanged.
  assert.deepEqual(shiftUntouched(hunk, [splice(2, 4, 'abcd')]), toByteSpan(12, 16));
  assert.deepEqual(shiftUntouched(hunk, [splice(20, 22, '')]), hunk);
  // Inside, overlapping, or at either edge: the bytes it names changed, or the
  // order is a guess — `rebaseSpan` would let the span hold the change.
  for (const touching of [splice(11, 12, 'y'), splice(8, 11, ''), splice(14, 14, 'z'), splice(9, 10, '')]) {
    assert.equal(shiftUntouched(hunk, [touching]), undefined, JSON.stringify(touching.range));
  }
});
