// Goal: shared/engine/planner.ts plans `set-attribute` at exactly the right bytes when
// the file changed after the intent was authored, and rejects with the right
// reason everywhere it cannot be sure — never re-targeting a sibling with
// identical bytes (plan §3.4, §4, §5.2).
// Method: (1) the oracle scenarios that set an attribute: the planner produces
// the hand-derived splices exactly, through the identity fast path and through
// the diff. (2) The wrong-site fixture (hero, footer, two identical cards; the
// intent retitles the second card) against hand-edited current files: each
// expected output below is written out by hand, and the splice offset is
// counted by hand. (3) Every rejection reason the step can produce, pinned.
// (4) A sweep over every `.astro` fixture: for each editable node with a
// string attribute, the identity fast path agrees with the step-1 reference
// planner and with planning through the diff (plan §10), and after an
// unrelated insertion above the body every plan moves by exactly the inserted
// length, or is refused when its region repeats. (5) The wrong-site
// applications the step-3 spike found, now refused because the resolved bytes
// repeat (plan §4), and the one case no byte rule can decide, pinned as a
// stated limit.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { toFilePath, toIntentId } from '#dist/shared/core/brand.js';
import { toIntent, type Intent, type Operation } from '#dist/shared/engine/intent.js';
import { planIntent, planIntentThroughDiff, type PlanningBase } from '#dist/shared/engine/planner.js';
import type { AnchorRef } from '#dist/shared/page/ref.js';
import type { Snapshot } from '#dist/shared/page/snapshot.js';
import type { ProjectedNode } from '#dist/shared/page/sourceProjection.js';
import { decodeUtf8, encodeUtf8, toByteSpan, type ByteString } from '#dist/shared/core/span.js';
import { anchorAt, oracleIntent, oracleSplices } from './oracleIntent.ts';
import { ORACLE_SCENARIOS } from './oracles.ts';
import { snapshotOf } from './project.ts';
import { referenceMapSpan, referenceTables } from './referenceDiff.ts';
import { planByIdentity } from './referencePlanner.ts';
import { applySplices } from '#dist/shared/engine/splice.js';
import { diffCodePatch } from '#dist/shared/engine/codePatch.js';

const FIXTURES = path.resolve('test/fixtures/editor-core');
const DIRECTORIES = ['test/corpus', 'test/fixtures/round-trip', 'test/fixtures/editor-core'];
const PAGE = toFilePath('/project/page.astro');

const readFixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const snapshotText = (text: string, file = PAGE): Snapshot => snapshotOf(file, encodeUtf8(text));

function setAttribute(name: string, value: string): Operation {
  return { tag: 'set-attribute', name, value: { type: 'string', value } };
}

function intentOn(authored: Snapshot, anchor: AnchorRef, operation: Operation): Intent {
  return toIntent({
    id: toIntentId('planner-test'),
    file: authored.path,
    authoredChecksum: authored.checksum,
    anchor,
    operation,
  });
}

/** Plan through both paths; they must agree; return the result bytes or the reason. */
function planned(base: PlanningBase, intent: Intent): string {
  const fast = planIntent(base, intent);
  assert.deepEqual(planIntentThroughDiff(base, intent), fast, 'fast path and diff path agree');
  if (!fast.ok) {
    return `rejected: ${fast.error}`;
  }
  const bytes = applySplices(base.current.bytes, fast.value.splices);
  const text = decodeUtf8(bytes);
  assert.ok(text.ok);
  return text.value;
}

function spliceStarts(base: PlanningBase, intent: Intent): readonly number[] {
  const result = planIntent(base, intent);
  assert.ok(result.ok, 'the intent plans');
  return result.value.splices.map((splice) => splice.range.start);
}

test('oracle set-attribute scenarios: exact splices, fast path and diff path alike', () => {
  let checked = 0;
  for (const step of ORACLE_SCENARIOS.flatMap((scenario) => scenario.steps)) {
    const input = snapshotOf(toFilePath(`/project/${step.file}`), encodeUtf8(readFixture(step.file)));
    const intent = oracleIntent(step, input, toIntentId(`oracle-${checked}`));
    if (intent.operation.tag !== 'set-attribute') {
      continue;
    }
    checked += 1;
    const base = { authored: input, current: input };
    const fast = planIntent(base, intent);
    assert.ok(fast.ok, `${step.file} plans`);
    assert.deepEqual(fast.value.splices, oracleSplices(step), `${step.file}: exact splices`);
    assert.deepEqual(planIntentThroughDiff(base, intent), fast, `${step.file}: through the diff`);
    assert.deepEqual(planByIdentity(input, intent), fast, `${step.file}: the step-1 reference`);
    assert.equal(planned(base, intent), readFixture(step.expectedFile));
  }
  // Step 10 adds the MDX oracle: a prop of the second of two identical blocks.
  assert.equal(checked, 4, 'the multi-file, wrong-site, encoding and MDX oracles set attributes');
});

// duplicate-siblings.astro, one element per line:
//   [0, 21) `<Hero title="Old" />`   [21, 44) `<Footer title="Old" />`
//   [44, 65) `<Card title="Old" />`  [65, 86) `<Card title="Old" />`
// The intent retitles the second card: its `Old` is [78, 81).
const HERO = '<Hero title="Old" />\n';
const FOOTER = '<Footer title="Old" />\n';
const CARD = '<Card title="Old" />\n';
const SIBLINGS = `${HERO}${FOOTER}${CARD}${CARD}`;

function secondCardIntent(): { readonly authored: Snapshot; readonly intent: Intent } {
  const authored = snapshotText(SIBLINGS);
  assert.equal(readFixture('duplicate-siblings.astro'), SIBLINGS, 'the fixture is the one described');
  return {
    authored,
    intent: intentOn(authored, anchorAt(authored, [3]), setAttribute('title', 'New')),
  };
}

function againstCurrent(current: string): { readonly result: string; readonly base: PlanningBase } {
  const { authored, intent } = secondCardIntent();
  const base = { authored, current: snapshotText(current) };
  return { result: planned(base, intent), base };
}

// The footer's region `Footer title="Old"` occurs once, so an edit elsewhere
// moves the plan by exactly the bytes inserted or deleted above it; its `Old` is
// [36, 39) in SIBLINGS. The two cards' regions are byte-identical, so after any
// edit their remap is refused: a unique minimum script onto one of two identical
// copies is not proof of which one the intent meant (see KNOWN WRONG SITE).
function footerAgainst(current: string): { readonly result: string; readonly base: PlanningBase } {
  const authored = snapshotText(SIBLINGS);
  const intent = intentOn(authored, anchorAt(authored, [1]), setAttribute('title', 'New'));
  const base = { authored, current: snapshotText(current) };
  assert.deepEqual(planIntent(base, intent), planIntentThroughDiff(base, intent));
  return { result: planned(base, intent), base };
}

function footerSplice(current: string): readonly number[] {
  const authored = snapshotText(SIBLINGS);
  const intent = intentOn(authored, anchorAt(authored, [1]), setAttribute('title', 'New'));
  return spliceStarts({ authored, current: snapshotText(current) }, intent);
}

test('stale intent, edit elsewhere: a unique region is retitled at its new offset', () => {
  // A nav line above: 8 bytes down, the splice at 44.
  const nav = `<Nav />\n${SIBLINGS}`;
  assert.equal(footerAgainst(nav).result, `<Nav />\n${HERO}<Footer title="New" />\n${CARD}${CARD}`);
  assert.deepEqual(footerSplice(nav), [44]);
  // The hero deleted: 21 bytes up, the splice at 15.
  const noHero = `${FOOTER}${CARD}${CARD}`;
  assert.equal(footerAgainst(noHero).result, `<Footer title="New" />\n${CARD}${CARD}`);
  assert.deepEqual(footerSplice(noHero), [15]);
  // A sibling inserted below the target: nothing above moved, the splice stays at 36.
  const below = `${HERO}${FOOTER}<hr />\n${CARD}${CARD}`;
  assert.equal(footerAgainst(below).result, `${HERO}<Footer title="New" />\n<hr />\n${CARD}${CARD}`);
  assert.deepEqual(footerSplice(below), [36]);
  // Wrapped and re-indented: `<main>\n` 7 bytes, two spaces, the hero, two spaces: 47.
  const wrapped = `<main>\n  ${HERO}  ${FOOTER}  ${CARD}  ${CARD}</main>\n`;
  assert.equal(footerAgainst(wrapped).result, `<main>\n  ${HERO}  <Footer title="New" />\n  ${CARD}  ${CARD}</main>\n`);
  assert.deepEqual(footerSplice(wrapped), [47]);
});

test('stale intent, edit elsewhere: one of two identical cards is refused, not guessed', () => {
  // The same four edits, aimed at the second card: its bytes repeat in every one.
  assert.equal(againstCurrent(`<Nav />\n${SIBLINGS}`).result, 'rejected: anchor-ambiguous');
  assert.equal(againstCurrent(`${FOOTER}${CARD}${CARD}`).result, 'rejected: anchor-ambiguous');
  assert.equal(againstCurrent(`${HERO}${FOOTER}${CARD}<hr />\n${CARD}`).result, 'rejected: anchor-ambiguous');
  assert.equal(againstCurrent(`<main>\n  ${HERO}  ${FOOTER}  ${CARD}  ${CARD}</main>\n`).result, 'rejected: anchor-ambiguous');
  // The first card retitled outside Stacki: the second card's bytes are now
  // unique in the current file, but they were not in the authored one — the
  // same bytes arise from the second card retitled and the two swapped, and
  // step 10's seed 3005 removed the target beside its twin (below). Refused.
  const mid = againstCurrent(`${HERO}${FOOTER}<Card title="Mid" />\n${CARD}`);
  assert.equal(mid.result, 'rejected: anchor-ambiguous');
  // Nothing changed: the identity path plans the second card; repetition is
  // only refused where a diff had to explain the file.
  assert.equal(againstCurrent(SIBLINGS).result, `${HERO}${FOOTER}${CARD}<Card title="New" />\n`);
});

test('stale intent, the target itself in question: typed rejections, never another card', () => {
  // One card deleted: which one survived is a guess.
  assert.equal(againstCurrent(`${HERO}${FOOTER}${CARD}`).result, 'rejected: anchor-ambiguous');
  // A third identical card: which two are the originals is a guess.
  assert.equal(againstCurrent(`${SIBLINGS}${CARD}`).result, 'rejected: anchor-ambiguous');
  // Its title changed outside Stacki: the tag the edit lives in is gone.
  assert.equal(againstCurrent(`${HERO}${FOOTER}${CARD}<Card title="Ext" />\n`).result, 'rejected: anchor-moved');
  // An attribute added inside its name-to-last-attribute region.
  assert.equal(againstCurrent(`${HERO}${FOOTER}${CARD}<Card data-x="1" title="Old" />\n`).result, 'rejected: anchor-moved');
  // An attribute appended after the title: the closing quote could be either.
  assert.equal(againstCurrent(`${HERO}${FOOTER}${CARD}<Card title="Old" data-x="1" />\n`).result, 'rejected: anchor-ambiguous');
  // Commented out: the bytes survive, the element does not. The commented
  // copy repeats the first card's bytes, so the remap is refused before the
  // parse would find no element there.
  assert.equal(againstCurrent(`${HERO}${FOOTER}${CARD}<!-- <Card title="Old" /> -->\n`).result, 'rejected: anchor-ambiguous');
  // Moved into a loop: one source node, many rendered cards. The loop body
  // repeats the first card's bytes, so the remap is refused as repeated first.
  assert.equal(againstCurrent(`${HERO}${FOOTER}${CARD}{[1, 2].map(() => <Card title="Old" />)}\n`).result, 'rejected: anchor-ambiguous');
  // The footer moved into a loop, its bytes unique: it is now one source node
  // rendered many times, which the user never saw, so the edit is refused —
  // never applied to every copy (step 7).
  const looped = footerAgainst(`${HERO}{[1, 2].map(() => <Footer title="Old" />)}\n${CARD}${CARD}`);
  assert.equal(looped.result, 'rejected: region-externally-modified');
  // The whole file deleted.
  assert.equal(againstCurrent('').result, 'rejected: anchor-moved');
});

// Found by the step-3 spike (seeds 36 and 240 of 400; tracker Step 3). The
// history: the hero is retitled `Old` → `New`, then someone pastes a copy of the
// footer line below it. The authored intent retitles the footer — the original,
// the first footer, whose `Old` is now [36, 39). The true history costs 29 byte
// edits (6 for the retitle, 23 for the paste); inserting the 23 bytes
// `New" />\n<Footer title="` after `<Hero title="` explains the same bytes for
// 23, and that script is the only minimum one — so the mapper, which only
// refuses ties, resolves the footer onto the pasted copy at 59. The minimum
// edit script is not the edit history. The planner refuses it: the resolved
// bytes occur twice in the current file, so they do not prove which footer the
// intent meant. Before the uniqueness rule this planned at 59, the copy.
test('a pasted copy after an edit above: mapped onto the copy, refused by the planner', () => {
  const { authored } = secondCardIntent();
  const footer = intentOn(authored, anchorAt(authored, [1]), setAttribute('title', 'New'));
  const current = snapshotText(`<Hero title="New" />\n${FOOTER}${FOOTER}${CARD}${CARD}`);
  const base = { authored, current };
  // The brute-force reference agrees with the mapper: 23 is the distance, and
  // every minimum script keeps the footer's region `Footer title="Old"` [22, 40)
  // whole at 45 — the copy.
  const tables = referenceTables(authored.bytes, current.bytes);
  assert.equal(tables.distance, 23);
  assert.deepEqual(referenceMapSpan(tables, toByteSpan(22, 40)), {
    tag: 'resolved',
    span: toByteSpan(45, 63),
  });
  assert.equal(planned(base, footer), 'rejected: anchor-ambiguous');
  // With nothing edited above, the paste alone is a tie, and the mapper refuses.
  const pasteOnly = { authored, current: snapshotText(`${HERO}${FOOTER}${FOOTER}${CARD}${CARD}`) };
  assert.equal(planned(pasteOnly, footer), 'rejected: anchor-ambiguous');
  // The copy pasted far away, past both cards: still two occurrences, still refused.
  const far = snapshotText(`<Hero title="New" />\n${FOOTER}${CARD}${CARD}${FOOTER}`);
  assert.equal(planned({ authored, current: far }, footer), 'rejected: anchor-ambiguous');
  // An attribute appended to the original keeps the old region as a prefix of
  // its own: two occurrences again, though only one is a whole region.
  const appended = snapshotText(`<Hero title="New" />\n<Footer title="Old" data-x="1" />\n${FOOTER}${CARD}${CARD}`);
  assert.equal(planned({ authored, current: appended }, footer), 'rejected: anchor-ambiguous');
});

// Found by the step-10 simulator (seed 3005, jsx-blocks.mdx). The authored
// file holds two cards whose regions `<Card title="Old"` are identical; the
// intent retitles the second, the one with a body. Other writers removed the
// import line, typed a line under the heading, and removed the second card.
// The cheapest script matches `and a line` against letters of the first card
// and keeps the second card's region whole: resolved onto the only `<Card
// title="Old"` left, which is the first card. The region is unique in the
// current file only because its twin went; unique in the authored file is
// the other half of the proof, and without it the plan is refused.
test('a twin removed: a region unique now but repeated when authored is refused', () => {
  const file = toFilePath('/project/jsx-blocks.mdx');
  const head = "import Card from '../components/Card.astro';\n\n# Cards\n\n";
  const cards = '<Card title="Old" />\n\n<Card title="Old">\n  Body text.\n</Card>\n';
  const authored = snapshotText(`${head}${cards}`, file);
  const second = anchorAt(authored, [3]);
  assert.equal(second.span.start, 77, 'the anchor is the second card');
  const intent = intentOn(authored, second, setAttribute('title', ''));
  const current = snapshotText('# Cards\nand a line\n\n<Card title="Old" />\n', file);
  const tables = referenceTables(authored.bytes, current.bytes);
  const region = referenceMapSpan(tables, toByteSpan(78, 94));
  assert.deepEqual(region, { tag: 'resolved', span: toByteSpan(21, 37) }, 'onto the first card');
  assert.equal(planned({ authored, current }, intent), 'rejected: anchor-ambiguous');
});

// The limit of any rule that sees only bytes, pinned so it stays a stated
// limit and not a surprise. Two histories give these exact current bytes:
// (a) a footer `Zed` is inserted above the untouched footer — the intent means
// the second footer, at 59; (b) the footer is copied below, then another writer
// retitles the original to `Zed` — the intent means the first, which no longer
// holds the authored value. The region `Footer title="Old"` occurs once, so the
// planner plans at 59: right for (a), wrong for (b), and no function of the two
// byte strings can be right for both. Closing (b) needs history (the actor's own
// splice log for its own writes), not a stricter byte rule; a rule refusing (a)
// too — any second element with the same tag and attribute names — kept 17 %
// fewer correct plans in the simulator and still misses a cut-and-paste.
test('BYTES CANNOT TELL: a unique region planned where only history could object', () => {
  const { authored } = secondCardIntent();
  const footer = intentOn(authored, anchorAt(authored, [1]), setAttribute('title', 'New'));
  const current = snapshotText(`<Hero title="New" />\n<Footer title="Zed" />\n${FOOTER}${CARD}${CARD}`);
  assert.deepEqual(spliceStarts({ authored, current }, footer), [59]);
});

test('stale intent past the diff bound, or into a file that no longer parses', () => {
  // 3 000 bytes appended exceed LIMITS.diffDistanceMax (2 048) by size alone.
  const appended = `${SIBLINGS}<p>${'x'.repeat(2_993)}</p>`;
  assert.equal(againstCurrent(appended).result, 'rejected: resource-limit');
  // Same size, 1 100 bytes rewritten: distance 2 200, found only by searching.
  const authored = snapshotText(`${SIBLINGS}<p>${'a'.repeat(1_100)}</p>\n`);
  const rewritten = snapshotText(`${SIBLINGS}<p>${'b'.repeat(1_100)}</p>\n`);
  const cardIntent = intentOn(authored, anchorAt(authored, [3]), setAttribute('title', 'New'));
  assert.deepEqual(planIntent({ authored, current: rewritten }, cardIntent), {
    ok: false,
    error: 'resource-limit',
  });
  assert.equal(againstCurrent(`${SIBLINGS}<div`).result, 'rejected: source-invalid');
  const { intent } = secondCardIntent();
  const broken = snapshotText('<div');
  const unchanged = { authored: broken, current: broken };
  assert.deepEqual(planIntent(unchanged, { ...intent, authoredChecksum: broken.checksum }), {
    ok: false,
    error: 'source-invalid',
  });
});

test('rejections that need no diff: the anchor, the attribute, the value, the operation', () => {
  const { authored, intent } = secondCardIntent();
  const base = { authored, current: authored };
  const plan = (operation: Operation, anchor: AnchorRef = intent.anchor) => planIntent(base, intentOn(authored, anchor, operation));
  // The anchor must name, in the authored bytes, a node at that path with that span and kind.
  const hero = anchorAt(authored, [0]);
  assert.deepEqual(plan(setAttribute('title', 'x'), { ...intent.anchor, span: hero.span }), {
    ok: false,
    error: 'anchor-moved',
  });
  assert.deepEqual(plan(setAttribute('title', 'x'), { ...intent.anchor, expectedKind: 'element' }), {
    ok: false,
    error: 'anchor-moved',
  });
  // Step 6: what step 2 refused now plans; each result is written out by hand.
  const text = (operation: Operation): string => planned(base, intentOn(authored, intent.anchor, operation));
  const card = (tag: string) => `${HERO}${FOOTER}${CARD}${tag}\n`;
  assert.equal(text(setAttribute('data-missing', 'x')), card('<Card title="Old" data-missing="x" />'));
  assert.equal(text({ tag: 'set-attribute', name: 'title', value: { type: 'expr', value: 'x' } }), card('<Card title={x} />'));
  assert.equal(text({ tag: 'set-attribute', name: 'title', value: { type: 'bare' } }), card('<Card title />'));
  // A double quote closes a double-quoted value: the value is re-quoted.
  assert.equal(text(setAttribute('title', 'say "hi"')), card(`<Card title='say "hi"' />`));
  assert.equal(text(setAttribute('title', "it's")), card(`<Card title="it's" />`));
  assert.equal(text({ tag: 'remove-attribute', name: 'title' }), card('<Card />'));
  assert.equal(
    text({ tag: 'set-inline-style', property: 'color', declaration: { tag: 'set', value: 'red' } }),
    card('<Card title="Old" style="color: red" />'),
  );
  assert.equal(text({ tag: 'insert-node', placement: 'after', source: '<p />' }), `${HERO}${FOOTER}${CARD}<Card title="Old" />\n<p />\n`);
  assert.deepEqual(plan({ tag: 'move-node', destination: hero, placement: 'after' }).ok, true);
});

test('duplicate attributes are refused, loop bodies edit their one source node, and an expression ' + 'attribute is replaced whole', () => {
  const page = snapshotText(readFixture('conditional-template.astro'));
  const projection = page.projection;
  assert.equal(projection.tag, 'valid');
  if (projection.tag !== 'valid') {
    return;
  }
  const base = { authored: page, current: page };
  const nodeWith = (predicate: (node: ProjectedNode) => boolean) => {
    const node = projection.nodes.find(predicate);
    assert.ok(node !== undefined);
    return anchorAt(page, node.path);
  };
  const classCount = (node: ProjectedNode) => node.attributes.filter((attribute) => attribute.name === 'class').length;
  const duplicated = nodeWith((node) => {
    if (node.capability === 'editable') {
      return classCount(node) > 1;
    }
    return false;
  });
  assert.deepEqual(planIntent(base, intentOn(page, duplicated, setAttribute('class', 'c'))), {
    ok: false,
    error: 'anchor-ambiguous',
  });
  // An expression attribute is set as a whole: `data-x={ 1 + 2 }` → `data-x="3"`.
  const expression = nodeWith((node) => node.attributes.some((attribute) => attribute.name === 'data-x'));
  const set = planIntent(base, intentOn(page, expression, setAttribute('data-x', '3')));
  assert.ok(set.ok, 'a type change plans');
  const written = decodeUtf8(applySplices(page.bytes, set.value.splices));
  assert.ok(written.ok);
  assert.match(written.value, /\n  data-x="3"\n/);
  const repeated = nodeWith((node) => {
    if (node.capability === 'repeated-source-node') {
      return node.kind === 'element';
    }
    return false;
  });
  // Step 7: a node a loop repeats is one source node, and an edit of it edits
  // that source — every copy the loop renders — never one runtime instance.
  const edited = planIntent(base, intentOn(page, repeated, setAttribute('data-step', '7')));
  assert.ok(edited.ok, 'an attribute of a repeated node plans against its source node');
  const [splice, ...others] = edited.value.splices;
  assert.equal(others.length, 0, 'one splice: the source node is written once');
  assert.ok(splice !== undefined);
  assert.ok(repeated.span.start <= splice.range.start, 'the splice lands in the source node');
  assert.ok(splice.range.end <= repeated.span.end, 'and stays inside it');
  // Nothing is placed beside it or taken from it: the list it sits in is the
  // loop body's code.
  assert.deepEqual(planIntent(base, intentOn(page, repeated, { tag: 'insert-node', placement: 'after', source: '<p />' })), {
    ok: false,
    error: 'unsupported-operation',
  });
  assert.deepEqual(planIntent(base, intentOn(page, repeated, { tag: 'remove-node' })), {
    ok: false,
    error: 'unsupported-operation',
  });
});

test("preconditions assert: the authored snapshot and the file are the intent's own", () => {
  const { authored, intent } = secondCardIntent();
  const other = snapshotText(`${SIBLINGS}\n`);
  assert.throws(() => planIntent({ authored: other, current: other }, intent), /Assertion failed: The authored snapshot is the one the intent names/);
  const elsewhere = snapshotText(SIBLINGS, toFilePath('/project/other.astro'));
  assert.throws(() => planIntent({ authored, current: elsewhere }, intent), /Assertion failed: The current snapshot is of the intent file/);
});

// --- The corpus sweep --------------------------------------------------------

const INSERTED = '<!-- 0 -->\n';

function corpusFiles(): readonly { readonly name: string; readonly text: string }[] {
  return DIRECTORIES.flatMap((directory) =>
    fs
      .readdirSync(directory)
      .filter((name) => name.endsWith('.astro'))
      .sort()
      .map((name) => ({
        name: `${directory}/${name}`,
        text: fs.readFileSync(path.join(directory, name), 'utf8'),
      })),
  );
}

/** The file with INSERTED at the start of the body: after the frontmatter, or
 * after a leading byte-order mark. Returns the byte offset it went in at. */
function withInsertion(snapshot: Snapshot, text: string): { readonly text: string; readonly at: number } {
  assert.equal(snapshot.projection.tag, 'valid');
  const frontmatter = snapshot.projection.tag === 'valid' ? snapshot.projection.frontmatter : undefined;
  const at = frontmatter === undefined ? (text.startsWith('﻿') ? 3 : 0) : frontmatter.end;
  const bytes: ByteString = snapshot.bytes;
  const joined = Buffer.concat([bytes.subarray(0, at), Buffer.from(INSERTED), bytes.subarray(at)]);
  return { text: joined.toString('utf8'), at };
}

/** Whether the node's identity region — tag name through its last attribute,
 * read from the authored bytes — occurs more than once in the current bytes. */
function regionRepeats(authored: Snapshot, current: Snapshot, node: ProjectedNode): boolean {
  const text = decodeUtf8(current.bytes);
  assert.ok(text.ok);
  const end = Math.max(...node.attributes.map((attribute) => attribute.span.end));
  const region = Buffer.from(authored.bytes.subarray(node.span.start + 1, end)).toString('utf8');
  const first = text.value.indexOf(region);
  assert.ok(first >= 0, 'an insertion above keeps every region whole');
  return text.value.indexOf(region, first + 1) >= 0;
}

const SWEEP_TITLE = 'corpus sweep: fast = reference = diff path; an insertion above shifts every plan';
test(SWEEP_TITLE, (testContext) => {
  let plannedCount = 0;
  let shiftedCount = 0;
  let repeatedCount = 0;
  let fileCount = 0;
  for (const file of corpusFiles()) {
    const authored = snapshotText(file.text, toFilePath(`/project/${path.basename(file.name)}`));
    if (authored.projection.tag !== 'valid') {
      continue;
    }
    fileCount += 1;
    const insertion = withInsertion(authored, file.text);
    const current = snapshotText(insertion.text, authored.path);
    for (const node of authored.projection.nodes) {
      for (const attribute of node.attributes.filter((attribute) => attribute.type === 'string')) {
        if (!['element', 'component', 'raw'].includes(node.kind)) {
          continue;
        }
        const intent = intentOn(authored, anchorAt(authored, node.path), setAttribute(attribute.name, 'x'));
        const same = { authored, current: authored };
        const fast = planIntent(same, intent);
        assert.deepEqual(planByIdentity(authored, intent), fast, `${file.name} ${node.path.join('/')}: reference`);
        assert.deepEqual(planIntentThroughDiff(same, intent), fast, `${file.name}: diff path`);
        const stale = planIntent({ authored, current }, intent);
        if (fast.ok) {
          plannedCount += 1;
          if (regionRepeats(authored, current, node)) {
            // Checked here by a plain string search, apart from the planner's own.
            assert.deepEqual(stale, { ok: false, error: 'anchor-ambiguous' }, `${file.name}`);
            repeatedCount += 1;
            continue;
          }
          assert.ok(stale.ok, `${file.name} ${node.path.join('/')} ${attribute.name}: plans after the insertion`);
          const [before] = fast.value.splices;
          const [after] = stale.value.splices;
          assert.ok(before !== undefined, 'the identity plan has a splice');
          assert.ok(after !== undefined, 'the stale plan has a splice');
          const shift = before.range.start >= insertion.at ? INSERTED.length : 0;
          assert.equal(after.range.start, before.range.start + shift, `${file.name}: exact shifted range`);
          assert.equal(after.range.end, before.range.end + shift);
          assert.deepEqual(after.expectedBytes, before.expectedBytes);
          shiftedCount += shift > 0 ? 1 : 0;
        } else {
          assert.deepEqual(stale, fast, `${file.name} ${node.path.join('/')}: the same rejection`);
        }
      }
    }
  }
  testContext.diagnostic(`${fileCount} files, ${plannedCount} attributes planned, ${shiftedCount} shifted, ` + `${repeatedCount} refused as repeated`);
  assert.ok(repeatedCount > 0, 'the sweep meets repeated regions, so the refusal is exercised');
  assert.ok(plannedCount > 60, `the sweep plans many real attributes (${plannedCount})`);
  assert.ok(shiftedCount > 60, `most of them sit below the insertion (${shiftedCount})`);
});

// Step 10: `rewrite-text`, a program's change to a file's text as hunks of the
// bytes it read, replaced step 5's whole-file `replace-source`. It never maps,
// so the fast path, the diff path and the step-1 reference must agree on every
// fixture: fresh (a splice per hunk, each witnessed by the authored bytes it
// replaces — here a few: nothing outside the hunks is rewritten), stale
// (`region-externally-modified`), and an anchor whose length is not the file's
// (`anchor-moved`).
test('rewrite-text: hunk splices fresh, rejected stale, agreeing with the reference', () => {
  let checked = 0;
  for (const directory of DIRECTORIES) {
    for (const name of fs.readdirSync(directory).sort()) {
      const text = fs.readFileSync(path.join(directory, name), 'utf8');
      const authored = snapshotText(text, toFilePath(`/project/${name}`));
      const replacement = `<!-- first -->\n${text}\n<!-- replaced -->\n`;
      const rewrite = rewriteTextIntent(authored, authored.bytes.length, text, replacement);
      const fresh = { authored, current: authored };
      assert.deepEqual(planByIdentity(authored, rewrite), planIntent(fresh, rewrite), name);
      assert.equal(planned(fresh, rewrite), replacement, `${name}: fresh rewrites the text`);
      // Text added at both ends: the splices rewrite only the few bytes the
      // diff aligns there, never the file the program read and kept.
      for (const splice of spliceList(fresh, rewrite)) {
        assert.ok(splice.expectedBytes.length < REWRITE_WITNESS_BYTES_MAX, name);
      }
      const current = snapshotText(`${text} `, authored.path);
      const stale = { authored, current };
      assert.deepEqual(planByIdentity(current, rewrite), planIntent(stale, rewrite), name);
      assert.equal(planned(stale, rewrite), 'rejected: region-externally-modified', name);
      if (authored.bytes.length > 0) {
        const short = rewriteTextIntent(authored, authored.bytes.length - 1, text, replacement);
        assert.deepEqual(planByIdentity(authored, short), planIntent(fresh, short), name);
        assert.equal(planned(fresh, short), 'rejected: anchor-moved', name);
      }
      checked += 1;
    }
  }
  assert.ok(checked > 50, `every fixture directory is swept (${checked} files)`);
});

// The diff trims common text at each end; what it leaves of the file's own
// bytes around an added line is at most a line's worth, far below any fixture.
const REWRITE_WITNESS_BYTES_MAX = 32;

function rewriteTextIntent(authored: Snapshot, length: number, from: string, to: string): Intent {
  const anchor = { span: toByteSpan(0, length), path: [], expectedKind: 'document' as const };
  const patch = diffCodePatch(from, to);
  assert.ok(patch.ok, 'the rewrite fits the bounds');
  const hunks = patch.value.map((hunk) => ({ span: hunk.span, text: hunk.text }));
  return intentOn(authored, anchor, { tag: 'rewrite-text', hunks });
}

function spliceList(base: PlanningBase, intent: Intent) {
  const result = planIntent(base, intent);
  assert.ok(result.ok, 'the intent plans');
  return result.value.splices;
}
