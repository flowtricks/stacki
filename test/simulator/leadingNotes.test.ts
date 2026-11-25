// Goal: a node and the comment that labels it in the Navigator ("Section / Hero")
// stay together through every tree operation the planner places. A move used to
// relocate the node alone: its label stayed behind as an orphan row and attached
// itself to whichever node came to follow it, so reordering one section swapped
// its neighbours' labels. A removal left the label to re-attach the same way.
// Method: small pages written the way the marketing site writes its sections (a
// `{/* ---- Label */}` banner above each, blank lines between them), planned
// through the shipping planner on both of its paths, with the exact bytes pinned.
// Every written file is reparsed and its labels read back with the Navigator's
// own rule (shared/page/leadingNote.ts), and each plan's inverse must restore the
// input byte for byte. The negative space: a comment that labels nothing (above
// text, above another comment, or last in its list) is never carried or removed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toFilePath, toIntentId } from '#dist/shared/core/brand.js';
import { toIntent, type Operation } from '#dist/shared/engine/intent.js';
import { planIntent, planIntentThroughDiff } from '#dist/shared/engine/planner.js';
import { labelledSpan } from '#dist/shared/engine/planTree.js';
import { labelsNode } from '#dist/shared/page/leadingNote.js';
import { toAnchorRef } from '#dist/shared/page/ref.js';
import type { Snapshot } from '#dist/shared/page/snapshot.js';
import { decodeUtf8, toByteSpan, toByteString } from '#dist/shared/core/span.js';
import { applySplices, inverseEdits } from '#dist/shared/engine/splice.js';
import { anchorAt } from './oracleIntent.ts';
import { snapshotOf } from './project.ts';
import { encodeUtf8 } from '#dist/shared/core/span.js';

const PAGE = toFilePath('/project/page.astro');

const snapshotText = (text: string): Snapshot => snapshotOf(PAGE, encodeUtf8(text));

function decoded(bytes: Uint8Array): string {
  const text = decodeUtf8(toByteString(bytes));
  assert.ok(text.ok, 'written bytes are UTF-8');
  return text.value;
}

// One operation planned on `text` at the node at `at`: both planner paths agree,
// the written file parses, and undo gives the exact input back.
function planned(text: string, at: readonly number[], operation: (page: Snapshot) => Operation): string {
  const authored = snapshotText(text);
  const base = { authored, current: authored };
  const intent = toIntent({
    id: toIntentId('leading-notes'),
    file: authored.path,
    authoredChecksum: authored.checksum,
    anchor: anchorAt(authored, at),
    operation: operation(authored),
  });
  const plan = planIntent(base, intent);
  assert.deepEqual(planIntentThroughDiff(base, intent), plan, 'fast path and diff path agree');
  assert.ok(plan.ok, `the operation plans: ${JSON.stringify(plan)}`);
  const written = snapshotOf(PAGE, applySplices(authored.bytes, plan.value.splices));
  const relocation = plan.value.relocation;
  if (intent.operation.tag === 'move-node') {
    // The node's handles, and the selection Desktop keeps by them, follow its bytes.
    assert.ok(relocation !== undefined, 'a move states where the node landed');
    const moved = decoded(authored.bytes.subarray(intent.anchor.span.start, intent.anchor.span.end));
    assert.equal(decoded(written.bytes.subarray(relocation.target.start, relocation.target.end)), moved, 'the relocation names the node itself');
    assert.equal(
      written.projection.tag === 'valid' &&
        written.projection.nodes.some((node) => node.span.start === relocation.target.start && node.kind === intent.anchor.expectedKind),
      true,
      'a node of its kind starts there',
    );
  }
  assert.equal(written.projection.tag, 'valid', 'the written file parses');
  const undone = planIntent(
    { authored: written, current: written },
    toIntent({
      id: toIntentId('leading-notes-undo'),
      file: written.path,
      authoredChecksum: written.checksum,
      anchor: toAnchorRef({ span: toByteSpan(0, written.bytes.length), path: [], expectedKind: 'document' }),
      operation: { tag: 'revert-splices', hunks: inverseEdits(plan.value.splices) },
    }),
  );
  assert.ok(undone.ok, 'the undo plans');
  assert.equal(decoded(applySplices(written.bytes, undone.value.splices)), text, 'undo restores the exact bytes');
  return decoded(written.bytes);
}

const move =
  (to: readonly number[], placement: 'before' | 'after') =>
  (page: Snapshot): Operation => ({ tag: 'move-node', destination: anchorAt(page, to), placement });

const remove = (): Operation => ({ tag: 'remove-node' });

// What the Navigator shows for a page's top-level list: each row's label, or
// `#comment` for a comment it leaves as a row of its own.
function rows(text: string, parent: readonly number[]): readonly string[] {
  const page = snapshotText(text);
  assert.equal(page.projection.tag, 'valid');
  if (page.projection.tag !== 'valid') {
    return [];
  }
  const siblings = page.projection.nodes.filter((node) => node.path.length === parent.length + 1 && parent.every((step, index) => node.path[index] === step));
  const shown: string[] = [];
  for (const [index, node] of siblings.entries()) {
    const next = siblings[index + 1];
    if (next !== undefined && labelsNode(node.kind, next.kind)) {
      continue; // Folded into the row beneath it.
    }
    const previous = siblings[index - 1];
    const label = previous !== undefined && labelsNode(previous.kind, node.kind) ? decoded(page.bytes.subarray(previous.span.start, previous.span.end)) : '';
    const source = decoded(page.bytes.subarray(node.span.start, node.span.end)).trim();
    const name = node.kind === 'text' ? source : (source.split(/[\s>]/)[0] ?? '');
    shown.push(label === '' ? (node.kind === 'comment' ? '#comment' : name) : `${name} / ${label.replace(/[{}/*\s<!>-]/g, '')}`);
  }
  return shown;
}

const SECTIONS = [
  '<main>',
  '  {/* ------------------------- Hero */}',
  '  <Section class="hero">',
  '    <h1>Hi</h1>',
  '  </Section>',
  '',
  '  {/* ------------------------- Features */}',
  '  <Section class="features" />',
  '',
  '  {/* ------------------------- CTA */}',
  '  <Section class="cta" />',
  '</main>',
  '',
].join('\n');

test('the fixture reads as three labelled sections', () => {
  assert.deepEqual(rows(SECTIONS, [0]), ['<Section / Hero', '<Section / Features', '<Section / CTA']);
});

test('moving a labelled node carries its label and leaves no orphan comment', () => {
  // The Navigator's gap above "Features" is the gap above its label: [0, 2].
  const written = planned(SECTIONS, [0, 5], move([0, 2], 'before'));
  assert.equal(
    written,
    [
      '<main>',
      '  {/* ------------------------- Hero */}',
      '  <Section class="hero">',
      '    <h1>Hi</h1>',
      '  </Section>',
      '',
      '  {/* ------------------------- CTA */}',
      '  <Section class="cta" />',
      '',
      '  {/* ------------------------- Features */}',
      '  <Section class="features" />',
      '</main>',
      '',
    ].join('\n'),
  );
  assert.deepEqual(rows(written, [0]), ['<Section / Hero', '<Section / CTA', '<Section / Features']);
});

test('a move placed before a labelled node lands above that node’s label, so no label is swapped', () => {
  // Anchored on the Features node itself rather than its label.
  const written = planned(SECTIONS, [0, 5], move([0, 3], 'before'));
  assert.deepEqual(rows(written, [0]), ['<Section / Hero', '<Section / CTA', '<Section / Features']);
  const down = planned(SECTIONS, [0, 1], move([0, 5], 'after'));
  assert.deepEqual(rows(down, [0]), ['<Section / Features', '<Section / CTA', '<Section / Hero']);
  assert.ok(
    down.endsWith('  <Section class="cta" />\n\n  {/* ------------------------- Hero */}\n  <Section class="hero">\n    <h1>Hi</h1>\n  </Section>\n</main>\n'),
  );
  const up = planned(SECTIONS, [0, 3], move([0, 1], 'before'));
  assert.deepEqual(rows(up, [0]), ['<Section / Features', '<Section / Hero', '<Section / CTA']);
});

test('moving into another parent carries the label too', () => {
  const page = '<main>\n  <div>\n    <p>a</p>\n  </div>\n  <!-- Card -->\n  <article></article>\n</main>\n';
  const written = planned(page, [0, 2], move([0, 0, 0], 'after'));
  assert.equal(written, '<main>\n  <div>\n    <p>a</p>\n    <!-- Card -->\n    <article></article>\n  </div>\n</main>\n');
  assert.deepEqual(rows(written, [0, 0]), ['<p', '<article / Card']);
});

test('deleting a labelled node removes its label', () => {
  const written = planned(SECTIONS, [0, 3], remove);
  assert.equal(written.includes('Features'), false, 'the label went with its node');
  assert.deepEqual(rows(written, [0]), ['<Section / Hero', '<Section / CTA']);
  const last = planned(SECTIONS, [0, 5], remove);
  assert.ok(last.endsWith('  </Section>\n\n  {/* ------------------------- Features */}\n  <Section class="features" />\n</main>\n'));
});

test('duplicating copies the label: the copy source is the labelled span', () => {
  const page = snapshotText(SECTIONS);
  assert.equal(page.projection.tag, 'valid');
  if (page.projection.tag !== 'valid') {
    return;
  }
  const features = page.projection.nodes.find((node) => node.path.join() === '0,3');
  assert.ok(features !== undefined);
  const span = labelledSpan(page.bytes, page.projection, features);
  const copied = decoded(page.bytes.subarray(span.start, span.end));
  assert.equal(copied, '{/* ------------------------- Features */}\n  <Section class="features" />');
  const written = planned(SECTIONS, [0, 3], () => ({ tag: 'insert-node', placement: 'after', source: copied }));
  assert.deepEqual(rows(written, [0]), ['<Section / Hero', '<Section / Features', '<Section / Features', '<Section / CTA']);
  assert.ok(written.includes('  <Section class="features" />\n\n  {/* ------------------------- Features */}\n  <Section class="features" />\n\n  {/* -'));
});

test('a comment that labels nothing stays where it is', () => {
  // Above text, above another comment, and last in its list: none is a label.
  const page =
    '<main>\n  <!-- note -->\n  Words\n  <!-- standalone -->\n  <!-- Card -->\n  <article></article>\n  <aside></aside>\n  <!-- trailing -->\n</main>\n';
  assert.deepEqual(rows(page, [0]), ['#comment', 'Words', '#comment', '<article / Card', '<aside', '#comment']);
  const moved = planned(page, [0, 4], move([0, 5], 'after'));
  assert.equal(
    moved,
    '<main>\n  <!-- note -->\n  Words\n  <!-- standalone -->\n  <aside></aside>\n  <!-- Card -->\n  <article></article>\n  <!-- trailing -->\n</main>\n',
  );
  const removed = planned(page, [0, 5], remove);
  assert.equal(removed, '<main>\n  <!-- note -->\n  Words\n  <!-- standalone -->\n  <!-- Card -->\n  <article></article>\n  <!-- trailing -->\n</main>\n');
  const text = planned(page, [0, 1], remove);
  assert.equal(text.includes('<!-- note -->'), true, 'removing text leaves the comment above it');
  assert.equal(labelsNode('comment', 'text'), false);
  assert.equal(labelsNode('comment', 'comment'), false);
  assert.equal(labelsNode('text', 'element'), false);
  assert.equal(labelsNode('comment', 'component'), true);
  assert.throws(() => labelsNode('', 'element'), /Assertion failed: labelsNode: a note has a kind/);
});
