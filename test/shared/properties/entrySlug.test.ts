// Goal: an Astro entry's slug follows one rule on both sides of the wire — typed text is
// normalised to lower case letters, digits and single hyphens; an empty, over-long or taken
// slug is refused, each with its own message; a rename's slug is checked again at the IPC
// boundary; and a document's Slug field is parsed within its bounds.
// Method: checkEntrySlug is fed valid slugs, text with invalid characters, duplicates, empty
// and over-long text; the boundary parsers get one known-good value, then each known-bad one.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ENTRY_SLUG_LIMITS,
  checkEntrySlug,
  parseEntrySlug,
  parseEntrySlugText,
  slugNote,
  slugProblem,
  slugify,
  slugWords,
  splitEntryId,
} from '#dist/shared/properties/entrySlug.js';
import { parseAstroRemoteEdit } from '#dist/shared/properties/astroContent.js';

const free = { taken: ['untitled', 'untitled-2'] };

test('a valid slug passes as typed, with nothing to say', () => {
  const check = checkEntrySlug('uptime-2024', free);
  assert.deepEqual(check, { kind: 'ok', slug: 'uptime-2024', normalised: false });
  assert.equal(slugProblem(check), undefined);
  assert.equal(slugNote(check), undefined);
});

test('invalid characters are normalised, and the field says what will be saved', () => {
  assert.equal(slugWords('61.4%'), '61-4');
  assert.equal(slugWords('  Héllo & World!! '), 'hello-and-world');
  assert.equal(slugWords('--a__b--'), 'a-b');
  const check = checkEntrySlug('61.4%', free);
  assert.deepEqual(check, { kind: 'ok', slug: '61-4', normalised: true });
  assert.equal(slugNote(check), 'Saved as “61-4”');
});

test('a slug another entry holds is refused, before and after normalising', () => {
  const exact = checkEntrySlug('untitled-2', free);
  assert.equal(exact.kind, 'taken');
  assert.equal(slugProblem(exact), 'Another item already uses this slug');
  assert.equal(checkEntrySlug('Untitled 2', free).kind, 'taken', 'what it would be saved as is what is compared');
  assert.equal(checkEntrySlug('untitled-3', free).kind, 'ok');
});

test('an empty slug, or one of only symbols, is refused', () => {
  for (const typed of ['', '   ', '%%%', '---']) {
    const check = checkEntrySlug(typed, free);
    assert.equal(check.kind, 'empty', JSON.stringify(typed));
    assert.equal(slugProblem(check), 'A slug needs at least one letter or number');
  }
});

test('a slug past the bound is refused; a name is cut to it at a word', () => {
  const max = ENTRY_SLUG_LIMITS.charsMax;
  assert.equal(checkEntrySlug('a'.repeat(max), free).kind, 'ok');
  const long = checkEntrySlug('a'.repeat(max + 1), free);
  assert.equal(long.kind, 'tooLong');
  assert.equal(slugProblem(long), `At most ${max} characters`);
  const cut = slugify(`${'word '.repeat(30)}`);
  assert.ok(cut.length <= max);
  assert.ok(cut.endsWith('word'), 'cut at a whole word');
});

test('an id splits into the folder it keeps and the slug it edits', () => {
  assert.deepEqual(splitEntryId('untitled'), { folder: '', value: 'untitled' });
  assert.deepEqual(splitEntryId('blog/2024/first'), { folder: 'blog/2024/', value: 'first' });
});

test('a rename’s slug is checked again at the boundary', () => {
  assert.deepEqual(parseAstroRemoteEdit({ operation: 'rename', id: 'stats.abc', slug: '61-4' }), { operation: 'rename', id: 'stats.abc', slug: '61-4' });
  for (const slug of ['', 'Has Caps', '61.4', '-lead', 'trail-', 'a/b', 'a'.repeat(ENTRY_SLUG_LIMITS.charsMax + 1), 4]) {
    assert.throws(() => parseEntrySlugText(slug), Error, JSON.stringify(slug));
    assert.throws(() => parseAstroRemoteEdit({ operation: 'rename', id: 'stats.abc', slug }));
  }
});

test('a document’s Slug field parses within its bounds', () => {
  const good = { folder: 'blog/', value: 'first', taken: ['second'], rename: { kind: 'editable' } };
  assert.deepEqual(parseEntrySlug(good), good);
  const locked = { ...good, rename: { kind: 'locked', reason: 'Built by code.' } };
  assert.deepEqual(parseEntrySlug(locked), locked);
  const bad = [
    { ...good, folder: 'blog' },
    { ...good, value: 'a/b' },
    { ...good, taken: 'second' },
    { ...good, taken: Array.from({ length: ENTRY_SLUG_LIMITS.takenMax + 1 }, (_, index) => `s${index}`) },
    { ...good, rename: { kind: 'locked', reason: '' } },
    { ...good, rename: { kind: 'maybe' } },
  ];
  for (const each of bad) {
    assert.throws(() => parseEntrySlug(each), Error, JSON.stringify(each).slice(0, 80));
  }
});
