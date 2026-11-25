// Goal: the planner refuses to write a structure the placement model forbids, whoever asked:
// an insertion, a move or a wrap that would leave a doctype inside a node, a list item outside
// a list, a block inside a paragraph, or a link inside a link comes back as the typed
// `invalid-placement` rejection with no splice, so the file's bytes cannot change; the same
// edits in a valid place still plan. Method: generated fixture pages (never a real project),
// intents authored with the simulator's anchors, planned through `planIntent`, and every
// accepted plan applied and re-parsed to prove the result is still a page.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toFilePath, toIntentId } from '#dist/shared/core/brand.js';
import { decodeUtf8, encodeUtf8 } from '#dist/shared/core/span.js';
import { toIntent, type Operation } from '#dist/shared/engine/intent.js';
import { planIntent } from '#dist/shared/engine/planner.js';
import { applySplices } from '#dist/shared/engine/splice.js';
import type { Snapshot } from '#dist/shared/page/snapshot.js';
import { snapshotOf } from '../../simulator/project.ts';
import { anchorAt } from '../../simulator/oracleIntent.ts';

const PAGE = `---
---
<!doctype html>
<Layout>
  <main>
    <p>Hello</p>
    <ul><li>one</li></ul>
    <a href="/x">link</a>
  </main>
</Layout>
`;

function pathOf(snapshot: Snapshot, opening: string, occurrence = 0): readonly number[] {
  const text = decodeUtf8(snapshot.bytes);
  assert.ok(text.ok);
  assert.ok(snapshot.projection.tag === 'valid');
  const found = snapshot.projection.nodes.filter((node) => text.value.slice(node.span.start, node.span.end).startsWith(opening));
  const node = found[occurrence];
  assert.ok(node !== undefined, `the fixture has ${opening}`);
  return node.path;
}

function plan(snapshot: Snapshot, anchorPath: readonly number[], operation: Operation) {
  const intent = toIntent({
    id: toIntentId('placement'),
    file: snapshot.path,
    authoredChecksum: snapshot.checksum,
    anchor: anchorAt(snapshot, anchorPath),
    operation,
  });
  return planIntent({ authored: snapshot, current: snapshot }, intent);
}

function insertion(snapshot: Snapshot, opening: string, placement: 'before' | 'after' | 'first-child' | 'last-child', source: string) {
  return plan(snapshot, pathOf(snapshot, opening), { tag: 'insert-node', placement, source });
}

function refused(result: ReturnType<typeof plan>): void {
  assert.equal(result.ok, false, 'the edit is refused');
  if (!result.ok) {
    assert.equal(result.error, 'invalid-placement');
  }
}

function appliedText(snapshot: Snapshot, result: ReturnType<typeof plan>): string {
  assert.ok(result.ok, 'the edit plans');
  const written = decodeUtf8(applySplices(snapshot.bytes, result.value.splices));
  assert.ok(written.ok);
  return written.value;
}

const snapshot = snapshotOf(toFilePath('/project/Page.astro'), encodeUtf8(PAGE));

test('a doctype inserted anywhere but the top of the page is refused', () => {
  refused(insertion(snapshot, '<main', 'last-child', '<!doctype html>'));
  refused(insertion(snapshot, '<main', 'first-child', '<!DOCTYPE html>'));
  refused(insertion(snapshot, '<Layout', 'first-child', '<!doctype html>'));
  refused(insertion(snapshot, '<p>', 'after', '<!doctype html>'));
  refused(insertion(snapshot, '<Layout', 'before', '<!doctype html>')); // A second doctype.
});

test('markup that carries a doctype inside is refused too', () => {
  refused(insertion(snapshot, '<main', 'last-child', '<div><!doctype html></div>'));
});

test('the same edits in valid places still plan and still parse', () => {
  const list = insertion(snapshot, '<ul', 'last-child', '<li>two</li>');
  assert.match(appliedText(snapshot, list), /<li>two<\/li>/);
  const paragraph = insertion(snapshot, '<p>', 'after', '<p>Next</p>');
  assert.match(appliedText(snapshot, paragraph), /<p>Next<\/p>/);
  const bare = snapshotOf(toFilePath('/project/Bare.astro'), encodeUtf8('---\n---\n<main>\n  <p>x</p>\n</main>\n'));
  const doctype = insertion(bare, '<main', 'before', '<!doctype html>');
  assert.match(appliedText(bare, doctype), /<!doctype html>/);
});

test('list items, table cells and blocks in the wrong parent are refused', () => {
  refused(insertion(snapshot, '<main', 'last-child', '<li>stray</li>'));
  refused(insertion(snapshot, '<main', 'last-child', '<td>cell</td>'));
  refused(insertion(snapshot, '<p>', 'first-child', '<div>block</div>'));
  refused(insertion(snapshot, '<ul', 'last-child', '<div>block</div>'));
  refused(insertion(snapshot, '<a ', 'first-child', '<a href="/y">nested</a>'));
  refused(insertion(snapshot, '<a ', 'first-child', '<div><a href="/y">nested</a></div>'));
  refused(insertion(snapshot, '<main', 'last-child', '<html></html>'));
  refused(insertion(snapshot, '<main', 'last-child', '<head></head>'));
});

test('a component parent is not judged by what it may render: it plans', () => {
  const plain = insertion(snapshot, '<Layout', 'last-child', '<li>kept</li>');
  assert.match(appliedText(snapshot, plain), /<li>kept<\/li>/);
});

test('moving the doctype, or a node into a place that forbids it, is refused and moving it validly plans', () => {
  const doctype = pathOf(snapshot, '<!doctype');
  const layout = anchorAt(snapshot, pathOf(snapshot, '<Layout'));
  const main = anchorAt(snapshot, pathOf(snapshot, '<main'));
  refused(plan(snapshot, doctype, { tag: 'move-node', destination: main, placement: 'last-child' }));
  refused(plan(snapshot, doctype, { tag: 'move-node', destination: layout, placement: 'first-child' }));
  const item = pathOf(snapshot, '<li');
  refused(plan(snapshot, item, { tag: 'move-node', destination: main, placement: 'last-child' }));
  const paragraph = pathOf(snapshot, '<p>');
  const list = anchorAt(snapshot, pathOf(snapshot, '<ul'));
  refused(plan(snapshot, paragraph, { tag: 'move-node', destination: list, placement: 'last-child' }));
  const moved = plan(snapshot, paragraph, { tag: 'move-node', destination: main, placement: 'last-child' });
  assert.ok(moved.ok, 'a paragraph moves within its parent');
});

test('wrapping what the wrapper cannot hold, or in a place the wrapper cannot stand, is refused', () => {
  const wrapper = { open: '<div>', close: '</div>' };
  const paragraph = pathOf(snapshot, '<p>');
  const wrapped = plan(snapshot, paragraph, { tag: 'wrap-nodes', last: anchorAt(snapshot, paragraph), ...wrapper });
  assert.match(appliedText(snapshot, wrapped), /<div><p>Hello<\/p><\/div>/);
  const item = pathOf(snapshot, '<li');
  refused(plan(snapshot, item, { tag: 'wrap-nodes', last: anchorAt(snapshot, item), ...wrapper })); // A div in a list.
  const link = pathOf(snapshot, '<a ');
  refused(plan(snapshot, link, { tag: 'wrap-nodes', last: anchorAt(snapshot, link), open: '<a href="/z">', close: '</a>' })); // Not inside a link yet, but the link would hold a link.
  const paragraphInLink = plan(snapshot, paragraph, { tag: 'wrap-nodes', last: anchorAt(snapshot, paragraph), open: '<span>', close: '</span>' });
  refused(paragraphInLink); // A paragraph inside a span: the span is phrasing only.
  const doctype = pathOf(snapshot, '<!doctype');
  refused(plan(snapshot, doctype, { tag: 'wrap-nodes', last: anchorAt(snapshot, doctype), ...wrapper }));
});

test('a refusal writes nothing: the plan carries no splices', () => {
  const result = insertion(snapshot, '<main', 'last-child', '<!doctype html>');
  assert.equal(result.ok, false);
  assert.equal('value' in result, false);
});
