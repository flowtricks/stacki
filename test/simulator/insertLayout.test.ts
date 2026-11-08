// Goal: nodes Stacki adds stand on lines of their own wherever that cannot change
// what the page renders, and never anywhere else. A child added to an empty block
// parent used to stay on the parent's line, and every later insert copied that,
// which is how a section built on the canvas came out as one long line.
// Method: each case plans `insert-node` or `move-node` on a small fixture through
// the shipping planner, on both of its paths, and pins the exact bytes. Every
// written file is then reparsed: the anchor's path still names its node, no blank
// text row appeared, and the plan's inverse restores the input byte for byte. The
// negative space comes first in spirit: inline runs, whitespace-preserving parents
// and deliberate one-line parents must come back untouched, with the line break
// left out rather than added.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toFilePath, toIntentId } from '#dist/shared/core/brand.js';
import { toIntent, type Operation } from '#dist/shared/engine/intent.js';
import { planIntent, planIntentThroughDiff } from '#dist/shared/engine/planner.js';
import { insertedIndent } from '#dist/shared/engine/planTree.js';
import { indentedFragment } from '#dist/shared/engine/planSupport.js';
import { toAnchorRef, type AnchorRef } from '#dist/shared/page/ref.js';
import type { Snapshot } from '#dist/shared/page/snapshot.js';
import { decodeUtf8, encodeUtf8, toByteSpan } from '#dist/shared/core/span.js';
import { applySplices, inverseEdits } from '#dist/shared/engine/splice.js';
import { anchorAt } from './oracleIntent.ts';
import { snapshotOf } from './project.ts';

const PAGE = toFilePath('/project/page.astro');

type Placement = 'before' | 'after' | 'first-child' | 'last-child';

const snapshotText = (text: string): Snapshot => snapshotOf(PAGE, encodeUtf8(text));

function intentOn(authored: Snapshot, anchor: AnchorRef, operation: Operation) {
  return toIntent({ id: toIntentId('insert-layout'), file: authored.path, authoredChecksum: authored.checksum, anchor, operation });
}

function decoded(bytes: Uint8Array): string {
  const text = decodeUtf8(encodeUtf8(Buffer.from(bytes).toString('utf8')));
  assert.ok(text.ok, 'written bytes are UTF-8');
  return text.value;
}

// One operation, planned and judged: both planner paths agree, the file parses,
// no whitespace-only text row appears that the input did not have, and undo gives
// the exact input back.
function planned(text: string, operation: Operation, at: readonly number[]): string {
  const authored = snapshotText(text);
  const base = { authored, current: authored };
  const intent = intentOn(authored, anchorAt(authored, at), operation);
  const plan = planIntent(base, intent);
  assert.deepEqual(planIntentThroughDiff(base, intent), plan, 'fast path and diff path agree');
  assert.ok(plan.ok, `the insertion plans: ${JSON.stringify(plan)}`);
  const written = snapshotOf(PAGE, applySplices(authored.bytes, plan.value.splices));
  assert.equal(written.projection.tag, 'valid', 'the written file parses');
  // A run the author spaced out already reads its spaces as text, and one more is
  // the copied separator; everywhere else a blank row is a space Stacki invented.
  if (blankRows(authored) === 0) {
    assert.equal(blankRows(written), 0, 'no whitespace-only row appears');
  }
  for (const expected of plan.value.postKinds) {
    assert.equal(kindAt(written, expected.path), expected.kind, 'the anchor still resolves');
  }
  const hunks = inverseEdits(plan.value.splices);
  const undone = planIntent(
    { authored: written, current: written },
    toIntent({
      id: toIntentId('insert-layout-undo'),
      file: written.path,
      authoredChecksum: written.checksum,
      anchor: toAnchorRef({ span: toByteSpan(0, written.bytes.length), path: [], expectedKind: 'document' }),
      operation: { tag: 'revert-splices', hunks },
    }),
  );
  assert.ok(undone.ok, 'the undo plans');
  assert.equal(decoded(applySplices(written.bytes, undone.value.splices)), text, 'undo restores the exact bytes');
  return decoded(written.bytes);
}

function kindAt(snapshot: Snapshot, path: readonly number[]): string | undefined {
  assert.equal(snapshot.projection.tag, 'valid');
  if (snapshot.projection.tag !== 'valid') {
    return undefined;
  }
  return snapshot.projection.nodes.find((node) => node.path.length === path.length && node.path.every((step, index) => step === path[index]))?.kind;
}

function blankRows(snapshot: Snapshot): number {
  assert.equal(snapshot.projection.tag, 'valid');
  if (snapshot.projection.tag !== 'valid') {
    return 0;
  }
  return snapshot.projection.nodes.filter((node) => node.kind === 'text' && decoded(snapshot.bytes.subarray(node.span.start, node.span.end)).trim() === '')
    .length;
}

const insert = (text: string, source: string, placement: Placement, at: readonly number[]): string =>
  planned(text, { tag: 'insert-node', placement, source }, at);

test('a child of an empty block parent stands on its own line, the closing tag on the next', () => {
  assert.equal(
    insert('<section class="dev"></section>\n', '<div class="container"></div>', 'last-child', [0]),
    '<section class="dev">\n\t<div class="container"></div>\n</section>\n',
  );
  assert.equal(insert('<aside></aside>\n', '<p>x</p>', 'first-child', [0]), '<aside>\n\t<p>x</p>\n</aside>\n');
});

test('whitespace alone between the tags is replaced, not kept beside the new line', () => {
  assert.equal(insert('<aside>  </aside>\n', '<p>x</p>', 'last-child', [0]), '<aside>\n\t<p>x</p>\n</aside>\n');
});

test('the closing tag lands at the indent of the line its parent opens on', () => {
  const page = '<main>\n\t<section></section>\n</main>\n';
  assert.equal(insert(page, '<div></div>', 'last-child', [0, 0]), '<main>\n\t<section>\n\t\t<div></div>\n\t</section>\n</main>\n');
  const split = '<main>\n\t<section\n\t\tclass="a"\n\t></section>\n</main>\n';
  assert.equal(insert(split, '<div></div>', 'last-child', [0, 0]), '<main>\n\t<section\n\t\tclass="a"\n\t>\n\t\t<div></div>\n\t</section>\n</main>\n');
});

test('the indent unit is the file’s: spaces when it clearly uses them, otherwise a tab', () => {
  const spaced = '<main>\n  <header>\n    <h1>a</h1>\n  </header>\n  <section></section>\n</main>\n';
  assert.equal(
    insert(spaced, '<div></div>', 'last-child', [0, 1]),
    '<main>\n  <header>\n    <h1>a</h1>\n  </header>\n  <section>\n    <div></div>\n  </section>\n</main>\n',
  );
  const four = '<main>\n    <header>\n        <h1>a</h1>\n    </header>\n    <section></section>\n</main>\n';
  assert.equal(
    insert(four, '<div></div>', 'last-child', [0, 1]),
    '<main>\n    <header>\n        <h1>a</h1>\n    </header>\n    <section>\n        <div></div>\n    </section>\n</main>\n',
  );
  const tabbed = '<main>\n\t<header>\n\t\t<h1>a</h1>\n\t</header>\n\t<section></section>\n</main>\n';
  assert.equal(
    insert(tabbed, '<div></div>', 'last-child', [0, 1]),
    '<main>\n\t<header>\n\t\t<h1>a</h1>\n\t</header>\n\t<section>\n\t\t<div></div>\n\t</section>\n</main>\n',
  );
});

test('a file with CRLF line breaks gets CRLF on the new lines', () => {
  assert.equal(
    insert('<main>\r\n\t<aside></aside>\r\n</main>\r\n', '<p>x</p>', 'last-child', [0, 0]),
    '<main>\r\n\t<aside>\r\n\t\t<p>x</p>\r\n\t</aside>\r\n</main>\r\n',
  );
});

test('repeated inserts build a nested structure, one element per line', () => {
  let page = '<body>\n\t<section class="dev"></section>\n</body>\n';
  page = insert(page, '<div class="container"></div>', 'last-child', [0, 0]);
  page = insert(page, '<div class="layout"></div>', 'last-child', [0, 0, 0]);
  page = insert(page, '<div class="content"></div>', 'last-child', [0, 0, 0, 0]);
  page = insert(page, '<h2>Built for developers</h2>', 'last-child', [0, 0, 0, 0, 0]);
  page = insert(page, '<p>Typed.</p>', 'last-child', [0, 0, 0, 0, 0]);
  page = insert(page, '<div class="button-wrapper"></div>', 'after', [0, 0, 0, 0, 0, 1]);
  page = insert(page, '<a href="#">Go</a>', 'last-child', [0, 0, 0, 0, 0, 2]);
  page = insert(page, '<pre class="code"></pre>', 'after', [0, 0, 0, 0, 0]);
  assert.equal(
    page,
    [
      '<body>',
      '\t<section class="dev">',
      '\t\t<div class="container">',
      '\t\t\t<div class="layout">',
      '\t\t\t\t<div class="content">',
      '\t\t\t\t\t<h2>Built for developers</h2>',
      '\t\t\t\t\t<p>Typed.</p>',
      '\t\t\t\t\t<div class="button-wrapper">',
      '\t\t\t\t\t\t<a href="#">Go</a>',
      '\t\t\t\t\t</div>',
      '\t\t\t\t</div>',
      '\t\t\t\t<pre class="code"></pre>',
      '\t\t\t</div>',
      '\t\t</div>',
      '\t</section>',
      '</body>',
      '',
    ].join('\n'),
  );
});

test('a new block beside block siblings written on one line takes a line of its own', () => {
  assert.equal(insert('<div><h2>a</h2></div>\n', '<p>b</p>', 'last-child', [0]), '<div><h2>a</h2>\n\t<p>b</p>\n</div>\n');
  assert.equal(insert('<div><h2>a</h2></div>\n', '<p>b</p>', 'first-child', [0]), '<div>\n\t<p>b</p>\n\t<h2>a</h2></div>\n');
  assert.equal(insert('<div><h2>a</h2><h3>c</h3></div>\n', '<p>b</p>', 'after', [0, 0]), '<div><h2>a</h2>\n\t<p>b</p>\n\t<h3>c</h3></div>\n');
  assert.equal(insert('<div><h2>a</h2>\n</div>\n', '<p>b</p>', 'after', [0, 0]), '<div><h2>a</h2>\n\t<p>b</p>\n</div>\n');
});

test('an inline element in a block parent: on its own line at the edge, where a browser drops the space', () => {
  assert.equal(
    insert('<div class="button-wrapper"></div>\n', '<a href="#">Go</a>', 'last-child', [0]),
    '<div class="button-wrapper">\n\t<a href="#">Go</a>\n</div>\n',
  );
  assert.equal(insert('<li></li>\n', '<span>x</span>', 'last-child', [0]), '<li>\n\t<span>x</span>\n</li>\n');
});

test('a second inline element never copies the parent’s edge whitespace into a rendered space', () => {
  const page = '<div>\n\t<a>one</a>\n</div>\n';
  assert.equal(insert(page, '<a>two</a>', 'after', [0, 0]), '<div>\n\t<a>one</a><a>two</a>\n</div>\n');
  assert.equal(insert(page, '<a>two</a>', 'last-child', [0]), '<div>\n\t<a>one</a><a>two</a>\n</div>\n');
  assert.equal(insert(page, '<a>two</a>', 'before', [0, 0]), '<div>\n\t<a>two</a><a>one</a>\n</div>\n');
  assert.equal(insert(page, '<a>two</a>', 'first-child', [0]), '<div>\n\t<a>two</a><a>one</a>\n</div>\n');
  const afterBlock = '<div>\n\t<h2>a</h2>\n\t<a>one</a>\n</div>\n';
  assert.equal(insert(afterBlock, '<a>two</a>', 'after', [0, 1]), '<div>\n\t<h2>a</h2>\n\t<a>one</a><a>two</a>\n</div>\n', 'nor whitespace beside a block');
});

test('between inline siblings the author set apart, the separator is copied and paths still resolve', () => {
  const page = '<div>\n\t<a>one</a>\n\t<a>two</a>\n</div>\n';
  assert.equal(insert(page, '<a>new</a>', 'after', [0, 2]), '<div>\n\t<a>one</a>\n\t<a>two</a>\n\t<a>new</a>\n</div>\n');
  assert.equal(insert(page, '<a>new</a>', 'before', [0, 2]), '<div>\n\t<a>one</a>\n\t<a>new</a>\n\t<a>two</a>\n</div>\n');
});

test('text and text-holding parents stay on one line', () => {
  assert.equal(insert('<p></p>\n', '<span>x</span>', 'last-child', [0]), '<p><span>x</span></p>\n');
  assert.equal(insert('<h1></h1>\n', '<em>x</em>', 'last-child', [0]), '<h1><em>x</em></h1>\n');
  assert.equal(insert('<span></span>\n', '<b>x</b>', 'last-child', [0]), '<span><b>x</b></span>\n');
  assert.equal(insert('<a href="#"></a>\n', '<span>x</span>', 'last-child', [0]), '<a href="#"><span>x</span></a>\n');
  assert.equal(insert('<button></button>\n', '<Icon />', 'last-child', [0]), '<button><Icon /></button>\n');
  assert.equal(insert('<div></div>\n', 'Text', 'last-child', [0]), '<div>Text</div>\n');
  assert.equal(insert('<div></div>\n', '{title}', 'last-child', [0]), '<div>{title}</div>\n');
});

test('a user’s one-line inline parent keeps its style', () => {
  assert.equal(insert('<p>a <b>b</b></p>\n', '<i>c</i>', 'last-child', [0]), '<p>a <b>b</b><i>c</i></p>\n');
  assert.equal(insert('<p>a <b>b</b></p>\n', '<i>c</i>', 'after', [0, 1]), '<p>a <b>b</b><i>c</i></p>\n');
  assert.equal(insert('<div>words <b>b</b></div>\n', '<p>c</p>', 'last-child', [0]), '<div>words <b>b</b><p>c</p></div>\n');
  assert.equal(insert('<div><Card /></div>\n', '<Card />', 'after', [0, 0]), '<div><Card /><Card /></div>\n');
});

test('nothing adds a line break where whitespace is content', () => {
  for (const tag of ['pre', 'code', 'textarea']) {
    assert.equal(insert(`<${tag}></${tag}>\n`, '<span>x</span>', 'last-child', [0]), `<${tag}><span>x</span></${tag}>\n`);
    assert.equal(insert(`<${tag}></${tag}>\n`, '<div>x</div>', 'last-child', [0]), `<${tag}><div>x</div></${tag}>\n`);
  }
  assert.equal(
    insert('<pre>\n</pre>\n', '<div>x</div>', 'last-child', [0]),
    '<pre><div>x</div>\n</pre>\n',
    'not even in a parent already holding a line break',
  );
  assert.equal(insert('<pre><div></div></pre>\n', '<p>x</p>', 'last-child', [0, 0]), '<pre><div><p>x</p></div></pre>\n', 'an ancestor counts');
  assert.equal(insert('<pre><div>a</div></pre>\n', '<p>x</p>', 'after', [0, 0]), '<pre><div>a</div><p>x</p></pre>\n');
  assert.equal(insert('<pre />\n', '<p>x</p>', 'last-child', [0]), '<pre><p>x</p></pre>\n');
});

test('a self-closing tag gaining a child opens onto lines of its own', () => {
  assert.equal(insert('<Wrapper />\n', '<p>x</p>', 'last-child', [0]), '<Wrapper>\n\t<p>x</p>\n</Wrapper>\n');
  assert.equal(insert('<Wrapper />\n', '<Card />', 'last-child', [0]), '<Wrapper>\n\t<Card />\n</Wrapper>\n');
  assert.equal(insert('<Wrapper />\n', 'Words', 'last-child', [0]), '<Wrapper>Words</Wrapper>\n', 'a slot’s text is content');
  assert.equal(insert('<Link />\n', '<span>x</span>', 'last-child', [0]), '<Link><span>x</span></Link>\n', 'it may render inline');
  assert.equal(insert('<main />\n', '<p>x</p>', 'last-child', [0]), '<main>\n\t<p>x</p>\n</main>\n');
  const split = '<main>\n\t<Wrapper\n\t\ta="b"\n\t/>\n</main>\n';
  assert.equal(insert(split, '<p>x</p>', 'last-child', [0, 0]), '<main>\n\t<Wrapper\n\t\ta="b"\n\t>\n\t\t<p>x</p>\n\t</Wrapper>\n</main>\n');
});

test('moves place a node on lines of their own in an empty parent, and keep separators beside siblings', () => {
  const move = (text: string, from: readonly number[], to: readonly number[], placement: Placement): string => {
    const destination = anchorAt(snapshotText(text), to);
    return planned(text, { tag: 'move-node', destination, placement }, from);
  };
  assert.equal(
    move('<main>\n\t<p>x</p>\n\t<aside></aside>\n</main>\n', [0, 0], [0, 1], 'last-child'),
    '<main>\n\t<aside>\n\t\t<p>x</p>\n\t</aside>\n</main>\n',
  );
  assert.equal(move('<ul><li>a</li><li>b</li></ul>\n', [0, 1], [0, 0], 'before'), '<ul><li>b</li><li>a</li></ul>\n', 'a reorder is not new structure');
});

test('the indent a printed node is laid out for matches where the planner puts it', () => {
  const at = (text: string, path: readonly number[], placement: Placement): string => {
    const page = snapshotText(text);
    assert.equal(page.projection.tag, 'valid');
    if (page.projection.tag !== 'valid') {
      return '';
    }
    const node = page.projection.nodes.find((candidate) => candidate.path.join() === path.join());
    assert.ok(node !== undefined);
    return insertedIndent(page.bytes, page.projection, node, placement);
  };
  assert.equal(at('<main>\n\t<aside></aside>\n</main>\n', [0, 0], 'last-child'), '\t\t');
  assert.equal(at('<main>\n\t<aside></aside>\n</main>\n', [0, 0], 'after'), '\t');
  assert.equal(at('<div><h2>a</h2></div>\n', [0, 0], 'after'), '\t', 'beside a child on its parent’s line, a level in');
  assert.equal(at('<ul>\n      <li>a</li>\n</ul>\n', [0], 'last-child'), '      ', 'a parent’s own children say where its children go');
});

test('continuation lines take the indent, except inside whitespace-preserving elements', () => {
  assert.equal(indentedFragment('<div>\n\t<p>x</p>\n</div>', '\t\t', '\n'), '<div>\n\t\t\t<p>x</p>\n\t\t</div>');
  assert.equal(indentedFragment('<div>\n\t<p>x</p>\n</div>', '  ', '\r\n'), '<div>\r\n  \t<p>x</p>\r\n  </div>');
  assert.equal(indentedFragment('<div>\n<pre>a\n  b\n</pre>\n</div>', '\t', '\n'), '<div>\n\t<pre>a\n  b\n</pre>\n\t</div>');
  assert.equal(indentedFragment('<code class="c">a\nb</code>', '\t', '\n'), '<code class="c">a\nb</code>');
  assert.equal(indentedFragment('<style>\n.a {}\n</style>', '\t', '\n'), '<style>\n.a {}\n</style>');
  assert.throws(() => indentedFragment('a', 'x', '\n'), /Assertion failed: indentedFragment/);
});
