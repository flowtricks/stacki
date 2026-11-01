// Goal: shared/engine/mapSpan.ts resolves a span only where every minimum edit script
// agrees, and says `gone` or `ambiguous` everywhere else — never a guess, never
// "the third matching node" (plan §4). Wrong-site mapping is the target, so the
// pinned cases assert the exact resolved byte range, not just the outcome
// (plan §3.4).
// Method: (1) agreement with the brute-force reference (referenceDiff.ts),
// which checks every column of the span against every target byte, over every
// span of seeded random inputs on tiny alphabets — the fast mapper decides from
// two columns, so this is the proof that two suffice; all three outcomes must
// occur or the generator is too tame. (2) Pinned shapes, each with byte offsets
// derived by hand and re-checked by the reference: identical attribute bytes on
// different elements (hero and footer `title="Old"`), identical siblings,
// moved and duplicated blocks, text inserted and deleted around and inside the
// span, a deep restructure. (3) Budget exhaustion is `too-costly`, and a
// precondition breach asserts with a pinned message.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffBytes, DIFF_BUDGET } from '#dist/shared/engine/diff.js';
import { mapSpan, mapSpanThroughDiff, type SpanMapping } from '#dist/shared/engine/mapSpan.js';
import { encodeUtf8, toByteSpan, toByteString, type ByteSpan, type ByteString } from '#dist/shared/core/span.js';
import { Prng } from './prng.ts';
import { referenceMapSpan, referenceTables } from './referenceDiff.ts';

const SEEDS = 2_000;

/** Map with the fast mapper and the reference; they must agree exactly. */
function mapBoth(source: string, target: string, start: number, end: number): SpanMapping {
  const sourceBytes = encodeUtf8(source);
  const targetBytes = encodeUtf8(target);
  const span = toByteSpan(start, end);
  const fast = mapSpan(sourceBytes, targetBytes, span, DIFF_BUDGET);
  const slow = referenceMapSpan(referenceTables(sourceBytes, targetBytes), span);
  assert.deepEqual(fast, slow, `fast and reference agree on [${start}, ${end})`);
  return fast;
}

const resolved = (start: number, end: number): SpanMapping => ({
  tag: 'resolved',
  span: toByteSpan(start, end),
});

function randomBytes(prng: Prng, lengthMax: number, alphabet: number): ByteString {
  const length = prng.below(lengthMax + 1);
  return toByteString(Uint8Array.from({ length }, () => 0x61 + prng.below(alphabet)));
}

test('the two-column mapper agrees with the every-column reference on every span', () => {
  const seen = new Map<SpanMapping['tag'], number>();
  for (let seed = 0; seed < SEEDS; seed++) {
    const prng = new Prng(seed);
    const alphabet = 1 + prng.below(3);
    const source = randomBytes(prng, 14, alphabet);
    const target = randomBytes(prng, 14, alphabet);
    const outcome = diffBytes(source, target, DIFF_BUDGET);
    assert.equal(outcome.tag, 'computed');
    if (outcome.tag !== 'computed') {
      return;
    }
    const tables = referenceTables(source, target);
    for (let start = 0; start < source.length; start++) {
      for (let end = start + 1; end <= source.length; end++) {
        const span = toByteSpan(start, end);
        const fast = mapSpanThroughDiff(outcome.diff, span);
        assert.deepEqual(fast, referenceMapSpan(tables, span), `seed ${seed}, [${start}, ${end})`);
        seen.set(fast.tag, (seen.get(fast.tag) ?? 0) + 1);
      }
    }
  }
  for (const tag of ['resolved', 'ambiguous', 'gone'] as const) {
    assert.ok((seen.get(tag) ?? 0) > 1_000, `the generator reaches ${tag} often`);
  }
});

// The pinned element spans are identity regions, as the planner maps them: the
// tag name through the last attribute, without the `<` every tag shares (see
// the `<div>` case below for why).
// `Hero title="Old"` is [1, 17), its value `Old` [13, 16); `Footer title="Old"`
// is [22, 40).
const HERO_FOOTER = '<Hero title="Old" />\n<Footer title="Old" />\n';

test('hero and footer share `title="Old"`: each maps to its own element, never the other', () => {
  // `<Nav />\n` inserted above shifts both by 8 bytes.
  const shifted = `<Nav />\n${HERO_FOOTER}`;
  assert.deepEqual(mapBoth(HERO_FOOTER, shifted, 1, 17), resolved(9, 25));
  assert.deepEqual(mapBoth(HERO_FOOTER, shifted, 22, 40), resolved(30, 48));
  assert.deepEqual(mapBoth(HERO_FOOTER, shifted, 13, 16), resolved(21, 24));
  // The hero deleted: the footer moves to the file start; the hero is gone —
  // it does not jump to the footer's identical `title="Old"`.
  const footerOnly = '<Footer title="Old" />\n';
  assert.deepEqual(mapBoth(HERO_FOOTER, footerOnly, 1, 17), { tag: 'gone' });
  assert.deepEqual(mapBoth(HERO_FOOTER, footerOnly, 22, 40), resolved(1, 19));
  // The footer's title edited: the footer's region is gone, the hero untouched.
  const retitled = '<Hero title="Old" />\n<Footer title="New" />\n';
  assert.deepEqual(mapBoth(HERO_FOOTER, retitled, 22, 40), { tag: 'gone' });
  assert.deepEqual(mapBoth(HERO_FOOTER, retitled, 1, 17), resolved(1, 17));
});

// Two identical cards: `Card title="Old"` is [1, 17) and [22, 38).
const TWO_CARDS = '<Card title="Old" />\n<Card title="Old" />\n';

test('identical siblings: an unrelated edit maps each to itself; deleting one is ambiguous', () => {
  const appended = `${TWO_CARDS}<p>More</p>\n`;
  assert.deepEqual(mapBoth(TWO_CARDS, appended, 1, 17), resolved(1, 17));
  assert.deepEqual(mapBoth(TWO_CARDS, appended, 22, 38), resolved(22, 38));
  // `<h1>Title</h1>\n` is 15 bytes above both.
  const prepended = `<h1>Title</h1>\n${TWO_CARDS}`;
  assert.deepEqual(mapBoth(TWO_CARDS, prepended, 1, 17), resolved(16, 32));
  assert.deepEqual(mapBoth(TWO_CARDS, prepended, 22, 38), resolved(37, 53));
  // A heading that spells `Card…` offers the first card's name a second home
  // at equal cost: refused, while the second card, fenced by the first, maps.
  const spelled = `<h1>Cards</h1>\n${TWO_CARDS}`;
  assert.deepEqual(mapBoth(TWO_CARDS, spelled, 1, 17), { tag: 'ambiguous' });
  assert.deepEqual(mapBoth(TWO_CARDS, spelled, 22, 38), resolved(37, 53));
  // One card left: was the first deleted or the second? The bytes cannot say.
  const one = '<Card title="Old" />\n';
  assert.deepEqual(mapBoth(TWO_CARDS, one, 1, 17), { tag: 'ambiguous' });
  assert.deepEqual(mapBoth(TWO_CARDS, one, 22, 38), { tag: 'ambiguous' });
  // A third card: which two are the originals is just as open.
  const three = `${TWO_CARDS}<Card title="Old" />\n`;
  assert.deepEqual(mapBoth(TWO_CARDS, three, 1, 17), { tag: 'ambiguous' });
  assert.deepEqual(mapBoth(TWO_CARDS, three, 22, 38), { tag: 'ambiguous' });
});

// `<p id="a">A</p>\n` is [0, 16), its region `p id="a"` [1, 9); the list's
// region `ul class="list"` is [17, 32).
const SMALL = '<p id="a">A</p>\n';
const LARGE = '<ul class="list">\n  <li>one</li>\n  <li>two</li>\n  <li>three</li>\n</ul>\n';

test('moved blocks: the block every minimum script keeps follows; the moved one is gone', () => {
  const moved = `${LARGE}${SMALL}`;
  // Every minimum script keeps the large block and moves the small one around
  // it, so the list follows to the file start:
  assert.deepEqual(mapBoth(`${SMALL}${LARGE}`, moved, 17, 32), resolved(1, 16));
  // …and the paragraph, deleted and re-inserted by every minimum script, is
  // gone: moves are step 6's gesture, and a mapping never pretends to see one.
  assert.deepEqual(mapBoth(`${SMALL}${LARGE}`, moved, 1, 9), { tag: 'gone' });
});

test('duplicated blocks: the original and its copy are indistinguishable', () => {
  // `h2 class="t"` is [13, 25); the section is 44 bytes.
  const section = '<section>\n  <h2 class="t">A</h2>\n</section>\n';
  assert.deepEqual(mapBoth(section, `${section}${section}`, 13, 25), { tag: 'ambiguous' });
  // A near-copy above — other text, or another class — is no better: the
  // mapper sees bytes, not structure, and a pure insertion of similar bytes
  // gives the region an equally cheap scattered home. Refused, never guessed;
  // how often this costs a legitimate edit is the simulator's to measure
  // (plan §14).
  const otherText = section.replace('>A<', '>B<');
  assert.deepEqual(mapBoth(section, `${otherText}${section}`, 13, 25), { tag: 'ambiguous' });
  const otherClass = section.replace('"t"', '"u"');
  assert.deepEqual(mapBoth(section, `${otherClass}${section}`, 13, 25), { tag: 'ambiguous' });
  // The same section after an unrelated block maps plainly: 15 bytes down.
  assert.deepEqual(mapBoth(section, `<h1>Title</h1>\n${section}`, 13, 25), resolved(28, 40));
});

test('text inserted and deleted around the span shifts it; inside the span it is gone', () => {
  // `title="Old"` is [6, 17) in `<Hero title="Old" />`.
  const hero = '<Hero title="Old" />';
  assert.deepEqual(mapBoth(hero, `${hero}\n<p>after</p>`, 6, 17), resolved(6, 17));
  assert.deepEqual(mapBoth(`<p>before</p>\n${hero}`, hero, 20, 31), resolved(6, 17));
  assert.deepEqual(mapBoth(hero, `{/* x */}${hero}`, 6, 17), resolved(15, 26));
  // Touching the span on either side, with bytes the span does not contain.
  assert.deepEqual(mapBoth(hero, hero.replace(' title', '\n  title'), 6, 17), resolved(8, 19));
  assert.deepEqual(mapBoth(hero, hero.replace('" />', '" data-x />'), 6, 17), resolved(6, 17));
  // Inside the span: a changed, inserted or deleted byte leaves nothing to keep.
  assert.deepEqual(mapBoth(hero, hero.replace('Old', 'Odd'), 6, 17), { tag: 'gone' });
  assert.deepEqual(mapBoth(hero, hero.replace('Old', 'Olds'), 6, 17), { tag: 'gone' });
  assert.deepEqual(mapBoth(hero, hero.replace('Old', 'Od'), 6, 17), { tag: 'gone' });
  // A byte equal to the span's edge inserted against it: the span may start
  // on either copy, so no single place keeps it — ambiguous, not a guess.
  assert.deepEqual(mapBoth(hero, hero.replace(' title', ' ttitle'), 6, 17), { tag: 'ambiguous' });
  // The same slide on the whole tag: `<div>` inserted before `<Hero` offers its
  // own `<`. The planner maps the name and attributes for exactly this reason.
  assert.deepEqual(mapBoth(hero, `<div>\n${hero}`, 0, 20), { tag: 'ambiguous' });
  assert.deepEqual(mapBoth(hero, `<div>\n${hero}`, 1, 17), resolved(7, 23));
});

test('a deep restructure: wrapped, re-indented, with a sibling between', () => {
  // `Hero title="Old"` is [1, 17), `Footer title="Old"` is [22, 40).
  const restructured = '<main>\n  <div>\n    <Hero title="Old" />\n  </div>\n  <Footer title="Old" />\n</main>\n';
  // Hand-counted: `<main>\n` 7 + `  <div>\n` 8 + 4 spaces → `<Hero` at 19, name at 20.
  assert.deepEqual(mapBoth(HERO_FOOTER, restructured, 1, 17), resolved(20, 36));
  // `  </div>\n` closes at 49; 2 spaces; `<Footer` at 51, name at 52.
  assert.deepEqual(mapBoth(HERO_FOOTER, restructured, 22, 40), resolved(52, 70));
  // Multi-line attributes re-indented inside the tag: the region itself changed.
  const card = '<Card\n  title="Old"\n  size="l" />';
  const reindented = '<Card\n    title="Old"\n    size="l" />';
  assert.deepEqual(mapBoth(card, reindented, 1, 26), { tag: 'gone' });
  assert.deepEqual(mapBoth(card, reindented, 8, 19), resolved(10, 21));
});

test('identical bytes map to themselves without a diff search', () => {
  const bytes = encodeUtf8(TWO_CARDS);
  const outcome = diffBytes(bytes, bytes, DIFF_BUDGET);
  assert.equal(outcome.tag, 'computed');
  if (outcome.tag === 'computed') {
    assert.equal(outcome.diff.distance, 0);
    // Even the second of two identical cards: with no edit, every script is
    // the main diagonal.
    assert.deepEqual(mapSpanThroughDiff(outcome.diff, toByteSpan(21, 41)), resolved(21, 41));
  }
});

test('exhausted budgets are too-costly; empty and out-of-file spans assert', () => {
  const source = encodeUtf8(HERO_FOOTER);
  const target = encodeUtf8(`<Nav />\n${HERO_FOOTER}`);
  const span: ByteSpan = toByteSpan(1, 17);
  const budget = (workMax: number, distanceMax: number) => ({ workMax, distanceMax });
  const workMax = DIFF_BUDGET.workMax;
  assert.deepEqual(mapSpan(source, target, span, budget(workMax, 7)), { tag: 'too-costly' });
  assert.deepEqual(mapSpan(source, target, span, budget(10, 8)), { tag: 'too-costly' });
  assert.deepEqual(mapSpan(source, target, span, budget(workMax, 8)), resolved(9, 25));
  assert.throws(() => mapSpan(source, target, toByteSpan(3, 3), DIFF_BUDGET), /Assertion failed: Only non-empty spans are mapped/);
  assert.throws(
    () => mapSpan(source, target, toByteSpan(40, source.length + 1), DIFF_BUDGET),
    /Assertion failed: The mapped span lies inside the authored bytes/,
  );
});
