// Goal: the shipping planner's Markdown rules (plan §11 step 10), pinned where
// the end-to-end suite (test/electron/documents/markdownEdit.test.ts) does not reach.
// A Markdown block is no tag: every tag operation refuses it. A list shares its
// first byte with its first item, and each still resolves to itself, fresh and
// after an outside edit above it. A block's inline text is never removed,
// moved or stood beside. Blocks are never left touching: a block put into, or
// a removal closing, a gap of one line break rewrites it as a blank line on
// each side. Items move only among items with their marker; lines whose
// container is not written out (a quote's lazy line) are never moved.
// Method: snapshots through the real Markdown parser and projection
// (project.ts); intents authored as the client authors them (oracleIntent.ts
// anchors); plans applied to the bytes and compared with hand-written output.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toFilePath, toIntentId } from '#dist/shared/core/brand.js';
import { toIntent, type Operation } from '#dist/shared/engine/intent.js';
import { planIntent } from '#dist/shared/engine/planner.js';
import type { AnchorRef } from '#dist/shared/page/ref.js';
import type { Snapshot } from '#dist/shared/page/snapshot.js';
import { decodeUtf8, encodeUtf8 } from '#dist/shared/core/span.js';
import { applySplices } from '#dist/shared/engine/splice.js';
import { anchorAt } from './oracleIntent.ts';
import { snapshotOf } from './project.ts';

const PAGE = toFilePath('/project/page.md');
const snapshot = (text: string): Snapshot => snapshotOf(PAGE, encodeUtf8(text));

/** Plan `operation` at `path` of `authored` against the same text unchanged. */
function planned(authored: string, path: readonly number[], operation: (at: (path: readonly number[]) => AnchorRef) => Operation): string {
  return plannedAgainst(authored, authored, path, operation);
}

/** Plan `operation` at `path` of `authored` against `current`; the new text,
 * or the rejection. */
function plannedAgainst(
  authored: string,
  current: string,
  path: readonly number[],
  operation: (at: (path: readonly number[]) => AnchorRef) => Operation,
): string {
  const before = snapshot(authored);
  const now = snapshot(current);
  const intent = toIntent({
    id: toIntentId('markdown-planner'),
    file: PAGE,
    authoredChecksum: before.checksum,
    anchor: anchorAt(before, path),
    operation: operation((at) => anchorAt(before, at)),
  });
  const plan = planIntent({ authored: before, current: now }, intent);
  if (!plan.ok) {
    return `rejected: ${plan.error}`;
  }
  const text = decodeUtf8(applySplices(now.bytes, plan.value.splices));
  assert.ok(text.ok);
  return text.value;
}

const REFUSED = 'rejected: unsupported-operation';

test('a Markdown block is no tag: every tag operation refuses it', () => {
  const page = '# Title\n\nText.\n';
  const string = { type: 'string' as const, value: 'x' };
  const set: Operation = { tag: 'set-attribute', name: 'class', value: string };
  assert.equal(
    planned(page, [1], () => set),
    REFUSED,
  );
  assert.equal(
    planned(page, [1], () => ({ tag: 'remove-attribute', name: 'class' })),
    REFUSED,
  );
  const style: Operation = {
    tag: 'set-inline-style',
    property: 'color',
    declaration: { tag: 'remove' },
  };
  assert.equal(
    planned(page, [1], () => style),
    REFUSED,
  );
  assert.equal(
    planned(page, [0], () => ({ tag: 'rename-tag', from: 'h1', to: 'h2' })),
    REFUSED,
  );
  const wrap = (at: (path: readonly number[]) => AnchorRef): Operation => ({
    tag: 'wrap-nodes',
    last: at([1]),
    open: '<div>\n',
    close: '\n</div>',
  });
  assert.equal(planned(page, [0], wrap), REFUSED);
});

test('a list and its first item start on one byte and each resolves to itself', () => {
  const page = '- a\n- b\n';
  const remove = (): Operation => ({ tag: 'remove-node' });
  assert.equal(planned(page, [0, 0], remove), '- b\n');
  assert.equal(planned(page, [0], remove), '\n');
  const above = `Intro.\n\n${page}`;
  assert.equal(plannedAgainst(page, above, [0, 0], remove), 'Intro.\n\n- b\n', 'the item, mapped');
  assert.equal(plannedAgainst(page, above, [0], remove), 'Intro.\n', 'the list, mapped');
});

test("a block's inline text is never removed, moved or stood beside", () => {
  const page = '# T\n\nText.\n';
  assert.equal(
    planned(page, [1, 0], () => ({ tag: 'remove-node' })),
    REFUSED,
  );
  const beside: Operation = { tag: 'insert-node', placement: 'before', source: 'x' };
  assert.equal(
    planned(page, [1, 0], () => beside),
    REFUSED,
  );
  const move = (at: (path: readonly number[]) => AnchorRef): Operation => ({
    tag: 'move-node',
    destination: at([0, 0]),
    placement: 'after',
  });
  assert.equal(planned(page, [1, 0], move), REFUSED);
});

test('blocks one line break apart get a blank line on each side of a change', () => {
  const tight = '# H\nText.\n';
  const insert: Operation = { tag: 'insert-node', placement: 'after', source: 'New.' };
  assert.equal(
    planned(tight, [0], () => insert),
    '# H\n\nNew.\n\nText.\n',
  );
  const fenced = 'Para.\n```\ncode\n```\nMore.\n';
  assert.equal(
    planned(fenced, [1], () => ({ tag: 'remove-node' })),
    'Para.\n\nMore.\n',
  );
  const quoted = '> # H\n> Text.\n';
  assert.equal(
    planned(quoted, [0, 0], () => insert),
    '> # H\n>\n> New.\n>\n> Text.\n',
  );
});

test('items move among items with their marker; blocks never among items', () => {
  const lists = '- a\n- b\n\n* c\n\nText.\n';
  type Anchors = (to: readonly number[]) => AnchorRef;
  const before =
    (path: readonly number[]) =>
    (at: Anchors): Operation => ({ tag: 'move-node', destination: at(path), placement: 'before' });
  assert.equal(planned(lists, [1, 0], before([0, 0])), REFUSED, 'a `*` item among `-` items');
  assert.equal(planned(lists, [2], before([0, 1])), REFUSED, 'a paragraph among items');
  assert.equal(planned(lists, [0, 1], before([0, 0])), '- b\n- a\n\n* c\n\nText.\n');
});

test('a moved block takes its new container prefix; a lazy line never moves', () => {
  const page = 'Text.\nMore.\n\n> q\n';
  const into = (at: (path: readonly number[]) => AnchorRef): Operation => ({
    tag: 'move-node',
    destination: at([1]),
    placement: 'last-child',
  });
  assert.equal(planned(page, [0], into), '> q\n>\n> Text.\n> More.\n');
  const lazy = '> a\nlazy\n\nText.\n';
  const out = (at: (path: readonly number[]) => AnchorRef): Operation => ({
    tag: 'move-node',
    destination: at([1]),
    placement: 'after',
  });
  assert.equal(planned(lazy, [0, 0], out), REFUSED);
});
