// Goal: every operation step 6 ships (plan §11 step 6), and the renames and
// node rewrites step 9 adds, plans the right bytes,
// fresh and stale, and its inverse restores exactly what it replaced — the
// engine half of Undo.
// Method: (1) every oracle scenario through the shipping planner: the planned
// splices produce the hand-written expected file byte for byte, and are the
// hand-derived splices themselves wherever the oracle's are the minimal ones;
// then the same intents after an unrelated insertion above the body, which
// must produce the expected file with that insertion. (2) Hand-written cases
// for each operation's whitespace and placement rules and each refusal. (3) A
// sweep over every `.astro`, Markdown and MDX fixture: each operation on
// every node it applies to either plans a candidate that parses, whose
// inverse (inverseEdits, planned as `revert-splices` against the result)
// gives the input back byte for byte, or rejects with a pinned reason; stale,
// it plans the same edit shifted by the insertion or is refused as ambiguous —
// never anything else.
// (4) Undo after an outside edit maps or rejects, and never reverts the
// outside edit. (5) The inline-style declaration editor on its own.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { toFilePath, toIntentId } from '#dist/shared/core/brand.js';
import { editInlineStyle, singleDeclarationChange } from '#dist/shared/engine/inlineStyle.js';
import { toIntent, type Intent, type Operation } from '#dist/shared/engine/intent.js';
import { renameSites } from '#dist/shared/engine/loopScope.js';
import { planIntent, planIntentThroughDiff, type Plan } from '#dist/shared/engine/planner.js';
import { labelsNode } from '#dist/shared/page/leadingNote.js';
import { toAnchorRef, type AnchorRef } from '#dist/shared/page/ref.js';
import type { Snapshot } from '#dist/shared/page/snapshot.js';
import type { ProjectedNode } from '#dist/shared/page/sourceProjection.js';
import { decodeUtf8, encodeUtf8, toByteSpan } from '#dist/shared/core/span.js';
import { applySplices, inverseEdits } from '#dist/shared/engine/splice.js';
import { anchorAt, oracleIntent, oracleSplices } from './oracleIntent.ts';
import { ORACLE_SCENARIOS } from './oracles.ts';
import { snapshotOf } from './project.ts';

const FIXTURES = path.resolve('test/fixtures/editor-core');
const DIRECTORIES = ['test/corpus', 'test/fixtures/round-trip', 'test/fixtures/editor-core'];
const PAGE = toFilePath('/project/page.astro');
const INSERTED = '<!-- 0 -->\n';

const snapshotText = (text: string, file = PAGE): Snapshot => snapshotOf(file, encodeUtf8(text));

function intentOn(authored: Snapshot, anchor: AnchorRef, operation: Operation): Intent {
  return toIntent({
    id: toIntentId('operations-test'),
    file: authored.path,
    authoredChecksum: authored.checksum,
    anchor,
    operation,
  });
}

function textOf(bytes: Uint8Array): string {
  const decoded = decodeUtf8(encodeUtf8(Buffer.from(bytes).toString('utf8')));
  assert.ok(decoded.ok, 'written bytes are UTF-8');
  return decoded.value;
}

type Placement = 'before' | 'after' | 'first-child' | 'last-child';

/** Plan fresh through both paths (they must agree) and return the written text. */
function run(authored: Snapshot, operation: Operation, anchor: AnchorRef): string {
  const intent = intentOn(authored, anchor, operation);
  const base = { authored, current: authored };
  const planned = planIntent(base, intent);
  assert.deepEqual(planIntentThroughDiff(base, intent), planned, 'fast path and diff path agree');
  if (!planned.ok) {
    return `rejected: ${planned.error}`;
  }
  return textOf(applySplices(authored.bytes, planned.value.splices));
}

/** The body offset: after the frontmatter block, or a leading byte-order mark. */
function bodyStart(snapshot: Snapshot): number {
  const projection = snapshot.projection;
  assert.equal(projection.tag, 'valid');
  if (projection.tag !== 'valid') {
    return 0;
  }
  if (projection.frontmatter !== undefined) {
    return projection.frontmatter.end;
  }
  return snapshot.bytes[0] === 0xef ? 3 : 0;
}

/** What an unrelated edit above the body inserts: a comment in markup; in
 * Markdown a paragraph and a blank line in the file's own line breaks (a
 * comment there would open an HTML block that runs into the next line). */
function insertedAbove(snapshot: Snapshot): string {
  if (!/\.mdx?$/.test(snapshot.path)) {
    return INSERTED;
  }
  const crlf = Buffer.from(snapshot.bytes).includes('\r\n');
  return crlf ? 'Inserted above.\r\n\r\n' : 'Inserted above.\n\n';
}

function withInsertion(snapshot: Snapshot): {
  readonly bytes: Uint8Array;
  readonly at: number;
  readonly text: string;
} {
  const at = bodyStart(snapshot);
  const text = insertedAbove(snapshot);
  const bytes = Buffer.concat([snapshot.bytes.subarray(0, at), Buffer.from(text), snapshot.bytes.subarray(at)]);
  return { bytes, at, text };
}

/** Whether the outside insertion (a comment above the body's first root) labels
 * `node` in the current bytes: the node is the authored first root, and in the
 * current bytes the inserted comment stands directly before it as its label. */
function labelledByOutside(page: Snapshot, current: Snapshot, node: ProjectedNode): boolean {
  if (page.projection.tag !== 'valid' || current.projection.tag !== 'valid') {
    return false;
  }
  const first = page.projection.nodes.find((candidate) => candidate.path.length === 1);
  if (first !== node) {
    return false;
  }
  const roots = current.projection.nodes.filter((candidate) => candidate.path.length === 1);
  const [inserted, moved] = roots;
  if (inserted === undefined || moved === undefined) {
    return false;
  }
  return inserted.span.start === bodyStart(page) && labelsNode(inserted.kind, moved.kind);
}

/** Undo, planned: the inverse of `plan` as a revert against the bytes it wrote. */
function revert(after: Snapshot, plan: Plan, current: Snapshot = after): ReturnType<typeof planIntent> {
  const hunks = inverseEdits(plan.splices);
  const anchor = toAnchorRef({
    span: toByteSpan(0, after.bytes.length),
    path: [],
    expectedKind: 'document',
  });
  const intent = intentOn(after, anchor, { tag: 'revert-splices', hunks });
  return planIntent({ authored: after, current }, intent);
}

// --- (1) Oracles through the shipping planner ---------------------------------------

test('every oracle scenario plans its expected ' + 'file with the shipping planner, fresh, stale', () => {
  let exact = 0;
  for (const step of ORACLE_SCENARIOS.flatMap((scenario) => scenario.steps)) {
    const input = snapshotOf(toFilePath(`/project/${step.file}`), encodeUtf8(fs.readFileSync(path.join(FIXTURES, step.file), 'utf8')));
    const expected = fs.readFileSync(path.join(FIXTURES, step.expectedFile));
    const intent = oracleIntent(step, input, toIntentId('oracle'));
    const planned = planIntent({ authored: input, current: input }, intent);
    assert.ok(planned.ok, `${step.file}: plans (${planned.ok ? '' : planned.error})`);
    assert.deepEqual(Buffer.from(applySplices(input.bytes, planned.value.splices)), expected, step.file);
    if (step.reference === 'agrees') {
      assert.deepEqual(planned.value.splices, oracleSplices(step), `${step.file}: exact splices`);
      exact += 1;
    }
    const inverse = revert(snapshotOf(input.path, applySplices(input.bytes, planned.value.splices)), planned.value);
    assert.ok(inverse.ok, `${step.file}: the inverse plans`);
    if (step.file.endsWith('.css')) {
      continue; // A stylesheet has no body to insert above.
    }
    // Stale: an unrelated insertion above the body. The same edit, moved.
    const stale = withInsertion(input);
    const current = snapshotOf(input.path, encodeUtf8(Buffer.from(stale.bytes).toString('utf8')));
    const mapped = planIntent({ authored: input, current }, intent);
    if (!mapped.ok) {
      // A moved region whose bytes repeat is refused, never guessed (plan §4).
      assert.equal(mapped.error, 'anchor-ambiguous', `${step.file}: stale`);
      continue;
    }
    const want = Buffer.concat([expected.subarray(0, stale.at), Buffer.from(stale.text), expected.subarray(stale.at)]);
    assert.deepEqual(Buffer.from(applySplices(current.bytes, mapped.value.splices)), want, `${step.file} stale`);
  }
  assert.ok(exact >= 4, 'the minimal oracle splices are matched exactly');
});

test('a loop rename finds exactly the oracle sites: the declaration and its two uses', () => {
  const page = snapshotText(fs.readFileSync(path.join(FIXTURES, 'loop-rename.astro'), 'utf8'));
  assert.equal(page.projection.tag, 'valid');
  if (page.projection.tag !== 'valid') {
    return;
  }
  const loop = page.projection.nodes.find((node) => node.path.join() === '0,0');
  assert.ok(loop !== undefined);
  const sites = renameSites(page.projection, page.bytes, loop, 'item');
  assert.deepEqual(
    sites?.map((site) => site.start),
    [148, 189, 201],
  );
  assert.equal(renameSites(page.projection, page.bytes, loop, 'items'), undefined, 'not a parameter');
});

// --- (2) Hand-written cases --------------------------------------------------------

const LIST = '<ul>\n  <li>a</li>\n  <li>b</li>\n</ul>\n';

test('remove-node takes the node and its line, never a sibling', () => {
  const page = snapshotText(LIST);
  assert.equal(run(page, { tag: 'remove-node' }, anchorAt(page, [0, 0])), '<ul>\n  <li>b</li>\n</ul>\n');
  assert.equal(run(page, { tag: 'remove-node' }, anchorAt(page, [0, 1])), '<ul>\n  <li>a</li>\n</ul>\n');
  assert.equal(run(page, { tag: 'remove-node' }, anchorAt(page, [0])), '');
  const inline = snapshotText('<p>a <b>x</b> c</p>\n');
  assert.equal(run(inline, { tag: 'remove-node' }, anchorAt(inline, [0, 1])), '<p>a  c</p>\n');
  const fenced = snapshotText('---\nconst a = 1;\n---\n<a />\n<b />\n');
  assert.equal(run(fenced, { tag: 'remove-node' }, anchorAt(fenced, [0])), '---\nconst a = 1;\n---\n<b />\n');
});

test('insert-node beside a node copies its separator; inside, it fills an empty tag', () => {
  const page = snapshotText(LIST);
  const insert = (placement: Placement, at: readonly number[]) => run(page, { tag: 'insert-node', placement, source: '<li>n</li>' }, anchorAt(page, at));
  assert.equal(insert('after', [0, 0]), '<ul>\n  <li>a</li>\n  <li>n</li>\n  <li>b</li>\n</ul>\n');
  assert.equal(insert('before', [0, 0]), '<ul>\n  <li>n</li>\n  <li>a</li>\n  <li>b</li>\n</ul>\n');
  assert.equal(insert('first-child', [0]), '<ul>\n  <li>n</li>\n  <li>a</li>\n  <li>b</li>\n</ul>\n');
  assert.equal(insert('last-child', [0]), '<ul>\n  <li>a</li>\n  <li>b</li>\n  <li>n</li>\n</ul>\n');
  const empty = snapshotText('<div>\n</div>\n<aside></aside>\n<hr />\n<Wrapper />\n');
  const into = (at: readonly number[]) => run(empty, { tag: 'insert-node', placement: 'first-child', source: '<p>x</p>' }, anchorAt(empty, at));
  // Nothing in this file is indented, so the new line takes Stacki's own unit: a tab.
  assert.equal(into([0]), '<div>\n\t<p>x</p>\n</div>\n<aside></aside>\n<hr />\n<Wrapper />\n');
  const spaced = snapshotText('<main>\n  <div>\n  </div>\n</main>\n');
  assert.equal(
    run(spaced, { tag: 'insert-node', placement: 'first-child', source: '<p>x</p>' }, anchorAt(spaced, [0, 0])),
    '<main>\n  <div>\n    <p>x</p>\n  </div>\n</main>\n',
    'a file indented with spaces keeps them',
  );
  // A block in an empty block parent stands on its own line: left inline, every
  // later child copied that, and a section built on the canvas became one long line.
  assert.equal(into([1]), '<div>\n</div>\n<aside>\n\t<p>x</p>\n</aside>\n<hr />\n<Wrapper />\n');
  assert.equal(into([2]), 'rejected: unsupported-operation', 'a self-closing tag has no inside');
  assert.equal(
    into([3]),
    '<div>\n</div>\n<aside></aside>\n<hr />\n<Wrapper>\n\t<p>x</p>\n</Wrapper>\n',
    'a self-closing component opens when it gains its first child',
  );
});

test('self-closing non-void HTML tags gain children while inline moves preserve separators', () => {
  const empty = snapshotText('<main />');
  assert.equal(run(empty, { tag: 'insert-node', placement: 'last-child', source: '<p>x</p>' }, anchorAt(empty, [0])), '<main>\n\t<p>x</p>\n</main>');
  const original = '<main>  <b>a</b>  <i>b</i>  <!-- Keep --> </main>';
  let source = original;
  for (let index = 0; index < 40; index++) {
    const page = snapshotText(source);
    source = run(
      page,
      {
        tag: 'move-node',
        destination: anchorAt(page, [0, 0]),
        placement: 'before',
      },
      anchorAt(page, [0, 1]),
    );
  }
  assert.equal(source, original, 'Repeated moves do not create whitespace in the vacated slot');
});

test('insert-node adds children inside loops and conditional branches', () => {
  const loop = snapshotText('{items.map((item) => (\n  <p>{item}</p>\n))}\n');
  assert.equal(
    run(loop, { tag: 'insert-node', placement: 'last-child', source: '<div>new</div>' }, anchorAt(loop, [0])),
    '{items.map((item) => (\n  <p>{item}</p>\n  <div>new</div>\n))}\n',
  );

  const bareLoop = snapshotText('{items.map((item) => <p>{item}</p>)}\n');
  assert.equal(
    run(bareLoop, { tag: 'insert-node', placement: 'last-child', source: '<div>new</div>' }, anchorAt(bareLoop, [0])),
    '{items.map((item) => <p>{item}</p> <div>new</div>)}\n',
  );

  const condition = snapshotText('{ready && (\n  <p>one</p>\n)}\n');
  assert.equal(
    run(condition, { tag: 'insert-node', placement: 'last-child', source: '<div>new</div>' }, anchorAt(condition, [0, 0])),
    '{ready && (\n  <p>one</p>\n  <div>new</div>\n)}\n',
  );

  const nested = snapshotText('{outer ? <em>yes</em> : inner ? <strong>maybe</strong> : <span>no</span>}\n');
  assert.equal(
    run(nested, { tag: 'insert-node', placement: 'first-child', source: '<p>new</p>' }, anchorAt(nested, [0, 1])),
    '{outer ? <em>yes</em> : <p>new</p>{inner ? <strong>maybe</strong> : ' + '<span>no</span>}}\n',
  );

  const value = snapshotText('{outer ? <em>yes</em> : label}\n');
  assert.equal(
    run(value, { tag: 'insert-node', placement: 'first-child', source: '<p>new</p>' }, anchorAt(value, [0, 1])),
    '{outer ? <em>yes</em> : <p>new</p>{label}}\n',
  );
});

test('move-node relocates the original bytes; into itself is refused', () => {
  const page = snapshotText('<ul>\n  <li class="a">a</li>\n  <li>b</li>\n</ul>\n<ol></ol>\n');
  const move = (from: readonly number[], to: readonly number[], placement: Placement) =>
    run(page, { tag: 'move-node', destination: anchorAt(page, to), placement }, anchorAt(page, from));
  assert.equal(move([0, 0], [0, 1], 'after'), '<ul>\n  <li>b</li>\n  <li class="a">a</li>\n</ul>\n<ol></ol>\n');
  assert.equal(move([0, 1], [0, 0], 'before'), '<ul>\n  <li>b</li>\n  <li class="a">a</li>\n</ul>\n<ol></ol>\n');
  assert.equal(move([0, 0], [1], 'first-child'), '<ul>\n  <li>b</li>\n</ul>\n<ol>\n  <li class="a">a</li>\n</ol>\n');
  assert.equal(move([0], [0, 0], 'after'), 'rejected: unsupported-operation');

  const selfClosing = snapshotText('<Button />\n<ButtonWrapper />\n');
  assert.equal(
    run(
      selfClosing,
      {
        tag: 'move-node',
        destination: anchorAt(selfClosing, [1]),
        placement: 'first-child',
      },
      anchorAt(selfClosing, [0]),
    ),
    '<ButtonWrapper>\n\t<Button />\n</ButtonWrapper>\n',
    'a child can move into a self-closing component instance',
  );
});

test('attribute operations keep every byte they do not own', () => {
  const page = snapshotText('<a\n  href="/x"\n  class="c"\n>x</a>\n<b style="color: red; margin: 0">y</b>\n');
  const set = (at: readonly number[], name: string, value: string) =>
    run(page, { tag: 'set-attribute', name, value: { type: 'string', value } }, anchorAt(page, at));
  assert.equal(set([0], 'title', 't'), '<a\n  href="/x"\n  class="c"\n  title="t"\n>x</a>\n<b style="color: red; margin: 0">y</b>\n');
  assert.equal(run(page, { tag: 'remove-attribute', name: 'href' }, anchorAt(page, [0])), '<a\n  class="c"\n>x</a>\n<b style="color: red; margin: 0">y</b>\n');
  const style = (property: string, declaration: { readonly tag: 'set'; readonly value: string } | { readonly tag: 'remove' }) =>
    run(page, { tag: 'set-inline-style', property, declaration }, anchorAt(page, [2]));
  assert.equal(style('margin', { tag: 'set', value: '4px' }), '<a\n  href="/x"\n  class="c"\n>x</a>\n<b style="color: red; margin: 4px">y</b>\n');
  assert.equal(style('color', { tag: 'remove' }), '<a\n  href="/x"\n  class="c"\n>x</a>\n<b style="margin: 0">y</b>\n');
  assert.equal(style('padding', { tag: 'set', value: '1px' }), '<a\n  href="/x"\n  class="c"\n>x</a>\n<b style="color: red; margin: 0; padding: 1px">y</b>\n');
  assert.equal(style('content', { tag: 'set', value: '"x"' }), 'rejected: unsupported-operation');
});

test('frontmatter slots and code patches: stale ones map whole or reject', () => {
  const text = '---\nconst title = "Old";\n---\n<h1>{title}</h1>\n';
  const page = snapshotText(text);
  assert.equal(page.projection.tag, 'valid');
  if (page.projection.tag !== 'valid' || page.projection.frontmatter === undefined) {
    return;
  }
  const anchor = toAnchorRef({
    span: page.projection.frontmatter,
    path: [],
    expectedKind: 'frontmatter',
  });
  const slot = toByteSpan(18, 23);
  const intent = intentOn(page, anchor, { tag: 'edit-frontmatter-slot', slot, text: '"New"' });
  const elsewhere = snapshotText(`${text}<p>more</p>\n`);
  const mapped = planIntent({ authored: page, current: elsewhere }, intent);
  assert.ok(mapped.ok);
  assert.equal(textOf(applySplices(elsewhere.bytes, mapped.value.splices)), '---\nconst title = "New";\n---\n<h1>{title}</h1>\n<p>more</p>\n');
  const inside = snapshotText(text.replace('const', 'let'));
  assert.deepEqual(planIntent({ authored: page, current: inside }, intent), {
    ok: false,
    error: 'region-externally-modified',
  });
});

test('rename-tag renames the opening and closing tag and nothing between them', () => {
  const page = snapshotText('<section class="a">\n  <p>section</p>\n</section>\n<Card />\n<img src="x">\n');
  const rename = (from: string, to: string): Operation => ({ tag: 'rename-tag', from, to });
  assert.equal(run(page, rename('section', 'article'), anchorAt(page, [0])), '<article class="a">\n  <p>section</p>\n</article>\n<Card />\n<img src="x">\n');
  assert.equal(run(page, rename('Card', 'Panel'), anchorAt(page, [1])), '<section class="a">\n  <p>section</p>\n</section>\n<Panel />\n<img src="x">\n');
  assert.equal(run(page, rename('img', 'picture'), anchorAt(page, [2])), 'rejected: unsupported-operation', 'a void tag has no closing tag to rename with it');
  assert.equal(run(page, rename('div', 'article'), anchorAt(page, [0])), 'rejected: anchor-moved', 'the name the client saw is its witness');
  // Stale: someone rewrote the paragraph inside. The rename still lands on the
  // tag's two names, and the outside edit is kept.
  const current = snapshotText('<section class="a">\n  <p>edited outside</p>\n</section>\n<Card />\n<img src="x">\n');
  const intent = intentOn(page, anchorAt(page, [0]), rename('section', 'article'));
  const mapped = planIntent({ authored: page, current }, intent);
  assert.ok(mapped.ok, mapped.ok ? '' : mapped.error);
  assert.equal(
    textOf(applySplices(current.bytes, mapped.value.splices)),
    '<article class="a">\n  <p>edited outside</p>\n</article>\n<Card />\n<img src="x">\n',
  );
});

test('rename-attribute renames in place; a missing name or a clash is refused', () => {
  const page = snapshotText('<a href="/x" title={t} data-a data-b="1">x</a>\n');
  const rename = (from: string, to: string): Operation => ({ tag: 'rename-attribute', from, to });
  const anchor = anchorAt(page, [0]);
  assert.equal(run(page, rename('title', 'aria-label'), anchor), '<a href="/x" aria-label={t} data-a data-b="1">x</a>\n');
  assert.equal(run(page, rename('data-a', 'hidden'), anchor), '<a href="/x" title={t} hidden data-b="1">x</a>\n');
  assert.equal(run(page, rename('alt', 'title'), anchor), 'rejected: anchor-moved');
  assert.equal(run(page, rename('href', 'title'), anchor), 'rejected: unsupported-operation');
  const twice = snapshotText('<a x="1" x="2">x</a>\n');
  assert.equal(run(twice, rename('x', 'y'), anchorAt(twice, [0])), 'rejected: anchor-ambiguous');
});

test('rewrite-node writes its hunks inside the node, and only while the node is unchanged', () => {
  const text = '<!-- old note -->\n<p>kept</p>\n';
  const page = snapshotText(text);
  const start = text.indexOf('old');
  const hunk = { span: toByteSpan(start, start + 3), text: 'new' };
  const rewrite: Operation = { tag: 'rewrite-node', hunks: [hunk] };
  assert.equal(run(page, rewrite, anchorAt(page, [0])), '<!-- new note -->\n<p>kept</p>\n');
  // Stale, the node untouched: the hunk moves with it. (Text above, not a tag:
  // a tag's `<` beside the note's own would tie the diff's scripts, and the
  // mapper refuses ties as ambiguous.)
  const above = snapshotText(`Intro\n${text}`);
  const intent = intentOn(page, anchorAt(page, [0]), rewrite);
  const mapped = planIntent({ authored: page, current: above }, intent);
  assert.ok(mapped.ok, mapped.ok ? '' : mapped.error);
  assert.equal(textOf(applySplices(above.bytes, mapped.value.splices)), 'Intro\n<!-- new note -->\n<p>kept</p>\n');
  // Stale, the node changed inside: the rewrite was computed from other text.
  const element = snapshotText('<p class="a">one <b>two</b></p>\n');
  const inside = snapshotText('<p class="a">one <b>three</b></p>\n');
  const retitle: Operation = {
    tag: 'rewrite-node',
    hunks: [{ span: toByteSpan(13, 16), text: 'uno' }],
  };
  const refused = planIntent({ authored: element, current: inside }, intentOn(element, anchorAt(element, [0]), retitle));
  assert.deepEqual(refused, { ok: false, error: 'region-externally-modified' });
  assert.throws(
    () =>
      intentOn(page, anchorAt(page, [0]), {
        tag: 'rewrite-node',
        hunks: [{ span: toByteSpan(20, 22), text: 'x' }],
      }),
    /site lies outside its anchor/,
    'a hunk outside its node is refused at construction',
  );
});

test('wrap-nodes puts a run of siblings in a new tag and keeps every byte of the run', () => {
  const text = '<header>h</header>\n<main>\n  <p>m</p>\n</main>\n<footer>f</footer>\n';
  const page = snapshotText(text);
  const wrap = (last: readonly number[]): Operation => ({
    tag: 'wrap-nodes',
    last: anchorAt(page, last),
    open: '<Layout>\n',
    close: '\n</Layout>',
  });
  assert.equal(run(page, wrap([2]), anchorAt(page, [0])), '<Layout>\n<header>h</header>\n<main>\n  <p>m</p>\n</main>\n<footer>f</footer>\n</Layout>\n');
  assert.equal(run(page, wrap([1]), anchorAt(page, [1])), '<header>h</header>\n<Layout>\n<main>\n  <p>m</p>\n</main>\n</Layout>\n<footer>f</footer>\n');
  assert.equal(run(page, wrap([1, 0]), anchorAt(page, [0])), 'rejected: unsupported-operation', 'not one run of siblings');
  assert.equal(run(page, wrap([0]), anchorAt(page, [2])), 'rejected: unsupported-operation', 'the run ends after it starts');
});

test('append-body gives an empty body its first node, and only an empty one', () => {
  const documentAnchor = (page: Snapshot) => toAnchorRef({ span: toByteSpan(0, page.bytes.length), path: [], expectedKind: 'document' });
  const append: Operation = { tag: 'append-body', source: '<main></main>' };
  const empty = snapshotText('---\nconst a = 1;\n---\n');
  const appended = '---\nconst a = 1;\n---\n<main></main>\n';
  assert.equal(run(empty, append, documentAnchor(empty)), appended);
  const bare = snapshotText('');
  assert.equal(run(bare, append, documentAnchor(bare)), '<main></main>\n');
  const crlf = snapshotText('---\r\n---');
  assert.equal(run(crlf, append, documentAnchor(crlf)), '---\r\n---\r\n<main></main>\r\n');
  const full = snapshotText('<p>x</p>\n');
  assert.equal(run(full, append, documentAnchor(full)), 'rejected: anchor-moved', 'not empty');
});

// --- (3) The corpus sweep ------------------------------------------------------------

function corpusFiles(): readonly { readonly name: string; readonly text: string }[] {
  return DIRECTORIES.flatMap((directory) =>
    fs
      .readdirSync(directory)
      .filter((name) => /\.(astro|mdx?)$/.test(name) && name !== 'README.md')
      .sort()
      .map((name) => ({
        name: `${directory}/${name}`,
        text: fs.readFileSync(path.join(directory, name), 'utf8'),
      })),
  );
}

type Sweep = (node: ProjectedNode, page: Snapshot) => Operation | undefined;

const TAGS = new Set(['element', 'component', 'raw']);
const MOVABLE = (node: ProjectedNode) => node.kind !== 'branch' && node.kind !== 'chunk-group';

const SWEEPS: Readonly<Record<string, Sweep>> = {
  'remove-node': (node) => (MOVABLE(node) ? { tag: 'remove-node' } : undefined),
  'insert-node': (node) => (MOVABLE(node) ? { tag: 'insert-node', placement: 'after', source: '<hr />' } : undefined),
  duplicate: (node, page) =>
    MOVABLE(node)
      ? {
          tag: 'insert-node',
          placement: 'after',
          source: Buffer.from(page.bytes.subarray(node.span.start, node.span.end)).toString('utf8'),
        }
      : undefined,
  'set-attribute': (node) => (TAGS.has(node.kind) ? { tag: 'set-attribute', name: 'data-step', value: { type: 'string', value: '6' } } : undefined),
  'remove-attribute': (node) => {
    const named = node.attributes.find((attribute) => attribute.type !== 'spread');
    return TAGS.has(node.kind) && named !== undefined ? { tag: 'remove-attribute', name: named.name } : undefined;
  },
  'move-node': (node, page) => {
    const projection = page.projection;
    if (projection.tag !== 'valid' || !MOVABLE(node)) {
      return undefined;
    }
    // After the last root: out of every loop and condition the node sits in.
    const roots = projection.nodes.filter((candidate) => candidate.path.length === 1 && candidate.kind !== 'text');
    const last = roots[roots.length - 1];
    if (last === undefined || node.path[0] === last.path[0]) {
      return undefined;
    }
    return { tag: 'move-node', destination: anchorAt(page, last.path), placement: 'after' };
  },
  'set-inline-style': (node) => (TAGS.has(node.kind) ? { tag: 'set-inline-style', property: 'color', declaration: { tag: 'set', value: 'red' } } : undefined),
  // Step 9: the operations that replaced the whole-model save.
  'rename-tag': (node, page) => {
    const name = tagNameOf(node, page);
    if (node.kind !== 'element' && node.kind !== 'component') {
      return undefined;
    }
    return name === '' ? undefined : { tag: 'rename-tag', from: name, to: `${name}x` };
  },
  'rename-attribute': (node) => {
    const named = node.attributes.find((attribute) => attribute.type !== 'spread');
    return TAGS.has(node.kind) && named !== undefined ? { tag: 'rename-attribute', from: named.name, to: `${named.name}-renamed` } : undefined;
  },
  'rewrite-node': (node, page) => {
    if (node.kind === 'text') {
      return { tag: 'rewrite-node', hunks: [{ span: node.span, text: 'rewritten' }] };
    }
    const name = tagNameOf(node, page);
    if (!TAGS.has(node.kind) || name === '') {
      return undefined;
    }
    const at = node.span.start + 1 + encodeUtf8(name).length;
    return { tag: 'rewrite-node', hunks: [{ span: toByteSpan(at, at), text: ' data-rewritten' }] };
  },
};

// A tag's name as written: from its `<` to the first space, `/` or `>`.
function tagNameOf(node: ProjectedNode, page: Snapshot): string {
  if (!TAGS.has(node.kind)) {
    return '';
  }
  const text = Buffer.from(page.bytes.subarray(node.span.start + 1, node.span.end)).toString();
  return /^[^\s/>]*/.exec(text)?.[0] ?? '';
}

// Every rejection a sweep may meet, per operation; anything else fails.
const ALLOWED: ReadonlySet<string> = new Set(['unsupported-operation', 'anchor-ambiguous', 'source-invalid']);

for (const [label, sweep] of Object.entries(SWEEPS)) {
  const title = `corpus sweep: ${label} plans a parsing candidate whose inverse restores the input`;
  test(title, (testContext) => {
    let planned = 0;
    let shifted = 0;
    const refused = new Map<string, number>();
    const refuse = (reason: string) => refused.set(reason, (refused.get(reason) ?? 0) + 1);
    for (const file of corpusFiles()) {
      const page = snapshotText(file.text, toFilePath(`/project/${path.basename(file.name)}`));
      if (page.projection.tag !== 'valid') {
        continue;
      }
      const stale = withInsertion(page);
      const current = snapshotOf(page.path, encodeUtf8(Buffer.from(stale.bytes).toString('utf8')));
      for (const node of page.projection.nodes) {
        const operation = sweep(node, page);
        if (operation === undefined) {
          continue;
        }
        const where = `${file.name} ${node.path.join('/')} ${label}`;
        const intent = intentOn(page, anchorAt(page, node.path), operation);
        const fresh = planIntent({ authored: page, current: page }, intent);
        if (!fresh.ok) {
          assert.ok(ALLOWED.has(fresh.error), `${where}: ${fresh.error}`);
          refuse(fresh.error);
          continue;
        }
        const written = snapshotOf(page.path, applySplices(page.bytes, fresh.value.splices));
        if (written.projection.tag !== 'valid') {
          // The actor refuses these as source-invalid (must-parse); counted so
          // the sweep shows how rare they are.
          refuse('candidate does not parse');
          continue;
        }
        planned += 1;
        const back = revert(written, fresh.value);
        assert.ok(back.ok, `${where}: the inverse plans`);
        assert.deepEqual(applySplices(written.bytes, back.value.splices), page.bytes, `${where}: undo`);
        const mapped = planIntent({ authored: page, current }, intent);
        if (!mapped.ok) {
          assert.equal(mapped.error, 'anchor-ambiguous', `${where}: stale`);
          continue;
        }
        // The stale plan reads its separators off the current bytes, so beside
        // the outside insertion it may take another whitespace run; what it
        // writes is the fresh result with that insertion kept, up to spacing.
        const staleText = textOf(applySplices(current.bytes, mapped.value.splices));
        const outside = stale.text.trim();
        if (operation.tag === 'remove-node' && labelledByOutside(page, current, node)) {
          // The outside edit is a comment written directly above the first root,
          // so in the current bytes it labels that node (shared/page/leadingNote.ts)
          // and a removal takes it along, as the Navigator shows them as one row.
          assert.equal(staleText.includes(outside), false, `${where}: the label goes with its node`);
          shifted += 1;
          continue;
        }
        assert.ok(staleText.includes(outside), `${where}: the outside edit survives`);
        const spacing = (text: string) => text.replace(outside, '').replace(/\s+/g, ' ').trim();
        assert.equal(spacing(staleText), spacing(textOf(written.bytes)), `${where}: stale`);
        shifted += 1;
      }
    }
    const reasons = [...refused].map(([reason, count]) => `${count} ${reason}`).join(', ');
    testContext.diagnostic(`${planned} planned, ${shifted} mapped stale; refused: ${reasons || 'none'}`);
    assert.ok(planned > 60, `the sweep plans many real edits (${planned})`);
    assert.ok(shifted > 30, `and maps many of them stale (${shifted})`);
  });
}

// --- (4) Undo after an outside edit ----------------------------------------------------

test('undo after an outside edit maps through it, or rejects — never reverts it', () => {
  // The outside edit sits farther from the reverted hunk than the context a
  // hunk is mapped with (planText.ts, HUNK_CONTEXT_BYTES).
  const filler = '<p>Unique paragraph text, long enough to keep the footer out of reach.</p>\n';
  const page = snapshotText(`<Hero title="Old" />\n${filler}<Footer title="Old" />\n`);
  const set = intentOn(page, anchorAt(page, [0]), {
    tag: 'set-attribute',
    name: 'title',
    value: { type: 'string', value: 'Brand new' },
  });
  const applied = planIntent({ authored: page, current: page }, set);
  assert.ok(applied.ok);
  const after = snapshotOf(page.path, applySplices(page.bytes, applied.value.splices));
  // Elsewhere: the footer's title is edited outside Stacki. Undo maps.
  const outside = snapshotText(textOf(after.bytes).replace('<Footer title="Old"', '<Footer title="Theirs"'));
  const undone = revert(after, applied.value, outside);
  assert.ok(undone.ok, 'undo maps through an unrelated outside edit');
  assert.equal(textOf(applySplices(outside.bytes, undone.value.splices)), `<Hero title="Old" />\n${filler}<Footer title="Theirs" />\n`);
  // On top of it: the hero's own title changed outside Stacki. Undo rejects.
  const over = snapshotText(textOf(after.bytes).replace('Brand new', 'Theirs'));
  assert.deepEqual(revert(after, applied.value, over), {
    ok: false,
    error: 'region-externally-modified',
  });
});

// --- (5) The inline-style editor ---------------------------------------------------------

test('editInlineStyle edits one declaration and keeps the rest of the text', () => {
  const set = (text: string, property: string, value: string) => {
    const result = editInlineStyle(text, property, { tag: 'set', value });
    return result.tag === 'edited' ? result.text : result.tag;
  };
  const remove = (text: string, property: string) => {
    const result = editInlineStyle(text, property, { tag: 'remove' });
    return result.tag === 'edited' ? result.text : result.tag;
  };
  assert.equal(set('color: red;  margin:0', 'margin', '4px'), 'color: red;  margin:4px');
  assert.equal(set('color: red;', 'margin', '0'), 'color: red; margin: 0;');
  assert.equal(set('color: red', 'margin', '0'), 'color: red; margin: 0');
  assert.equal(set('', 'margin', '0'), 'margin: 0');
  assert.equal(set('COLOR: red', 'color', 'blue'), 'COLOR: blue', 'property names ignore case');
  assert.equal(set('--Gap: 1px', '--gap', '2px'), '--Gap: 1px; --gap: 2px', 'custom properties do not');
  assert.equal(set('background: url(a;b); color: red', 'color', 'blue'), 'background: url(a;b); color: blue');
  assert.equal(remove('a: 1; b: 2; c: 3', 'b'), 'a: 1; c: 3');
  assert.equal(remove('a: 1; b: 2', 'b'), 'a: 1;');
  assert.equal(remove('a: 1', 'a'), '');
  assert.equal(remove('a: 1', 'z'), 'a: 1');
  assert.equal(set('a: 1; a: 2', 'a', '3'), 'ambiguous');
  assert.equal(set('a: (1', 'a', '3'), 'unreadable');
  assert.equal(set('just words', 'a', '3'), 'unreadable');
});

test('code around markup: an emptied branch, and ' + 'a node beside one in a branch, are refused', () => {
  // `cond && ( )` and `: <p/>other ? …` parse, but no JavaScript engine runs
  // them; the legacy printer rewrites both, so the app saves those whole.
  const page = snapshotText('{show && (\n  <p>Only</p>\n)}\n{show ? <em>a</em> : <b>b</b>}\n');
  assert.equal(run(page, { tag: 'remove-node' }, anchorAt(page, [0, 0, 0])), 'rejected: unsupported-operation');
  const beside = { tag: 'insert-node' as const, placement: 'after' as const, source: '<i />' };
  assert.equal(run(page, beside, anchorAt(page, [1, 1, 0])), 'rejected: unsupported-operation');
  const twice = snapshotText('{show && (\n  <p>One</p>\n  <p>Two</p>\n)}\n');
  assert.equal(run(twice, { tag: 'remove-node' }, anchorAt(twice, [0, 0, 1])), '{show && (\n  <p>One</p>\n)}\n', 'one of several may go');
});

test('singleDeclarationChange finds the one declaration a Style field edit changed', () => {
  assert.deepEqual(singleDeclarationChange('a: 1; b: 2', 'a: 1; b: 3'), {
    property: 'b',
    declaration: { tag: 'set', value: '3' },
  });
  assert.deepEqual(singleDeclarationChange('a: 1; b: 2', 'a: 1;'), {
    property: 'b',
    declaration: { tag: 'remove' },
  });
  assert.deepEqual(singleDeclarationChange('a: 1', 'a: 1; c: 0'), {
    property: 'c',
    declaration: { tag: 'set', value: '0' },
  });
  assert.equal(singleDeclarationChange('a: 1; b: 2', 'a: 2; b: 3'), undefined, 'two changes');
  assert.equal(singleDeclarationChange('a: 1; b: 2', 'b: 2; a: 1'), undefined, 'a reorder');
  assert.equal(singleDeclarationChange('a:1', 'a: 1'), undefined, 'only spacing');
});
