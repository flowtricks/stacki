// Goal: a node added on the canvas or from the insert search reaches the `.astro`
// file indented as the code around it is. It lines up with its siblings, or sits
// one level inside its parent in the style of that parent's line (tabs, spaces or
// the file's step) when it has none; a multi-line node's closing tag lines up with
// its opening tag; the parent's closing tag keeps its own line and indentation;
// and every byte outside the inserted text is the file's own.
// Method: each case writes a realistic page into a temporary project, reads it
// through the real main-process handlers in the windowless harness, and sends the
// `insert-node` request the renderer's insert gesture sends (insertGestures.ts),
// with the node parsed from a second file as a paste or a palette recipe carries
// it. The bytes on disk are then compared exactly, and every case also checks
// that removing the inserted text gives back the original page byte for byte.
// Cases cover the placements, empty parents, one-line parents, words and comments
// beside the new node, components and slots, 2-space, 4-space, tab and mixed
// files, CRLF, the end of a document, a closing tag sharing its last child's
// line, and several nodes inserted one after another.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mainHarness } from '../../helpers/mainHarness.ts';
import type { NodeRef } from '#dist/shared/engine/editRequest.js';
import { parsePageDiskRead, parsePageEditResult, type PageDiskRead } from '#dist/shared/ipc/pageSave.js';
import type { PageNode } from '#dist/shared/page/pageNode.js';
import { indentUnitBelow } from '#dist/shared/core/indent.js';

type Placement = 'before' | 'after' | 'first-child' | 'last-child';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-insert-indent-'));
  fs.mkdirSync(path.join(root, 'src/pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/components'), { recursive: true });
  fs.mkdirSync(path.join(root, 'user'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"astro":"*"}}');
  const harness = mainHarness(path.join(root, 'user'));
  return {
    root,
    ...harness,
    dispose: () => {
      harness.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

type Harness = ReturnType<typeof fixture>;

// One harness for the whole file: each case writes its own page.
const harness = fixture();
test.after(() => harness.dispose());

let pageCount = 0;

/** The node at `at` in the renderer's parse. */
function nodeAt(read: PageDiskRead, at: readonly number[]): PageNode {
  assert.ok(read.editable, 'the page parses');
  let list: readonly PageNode[] = read.model.nodes;
  let node: PageNode | undefined;
  for (const step of at) {
    node = list[step];
    assert.ok(node !== undefined, `a node at ${at.join('/')}`);
    list = 'children' in node && Array.isArray(node.children) ? node.children : [];
  }
  assert.ok(node !== undefined, 'the path names a node');
  return node;
}

/** The reference the renderer sends for the node at `at` in its parse. */
function refAt(read: PageDiskRead, at: readonly number[]): NodeRef {
  const node = nodeAt(read, at);
  assert.ok(node.start !== undefined, 'the parse carries a start');
  assert.ok(node.end !== undefined, 'the parse carries an end');
  return { path: at, kind: node.kind, span: { start: node.start, end: node.end } };
}

async function read(context: Harness, file: string): Promise<PageDiskRead> {
  return parsePageDiskRead(await context.invoke('page:read', file));
}

/** A node as the renderer holds it after a paste: parsed from source of its own. */
async function nodeFrom(source: string): Promise<PageNode> {
  pageCount += 1;
  const file = path.join(harness.root, `src/pages/source${pageCount}.astro`);
  fs.writeFileSync(file, source);
  return nodeAt(await read(harness, file), [0]);
}

/** Writes `text` as a page and returns its path. */
function page(text: string): string {
  pageCount += 1;
  const file = path.join(harness.root, `src/pages/page${pageCount}.astro`);
  fs.writeFileSync(file, text);
  return file;
}

/** Inserts `node` at `placement` of the node at `at` in the page on disk, and
 * returns the bytes written. */
async function insertInto(file: string, at: readonly number[], placement: Placement, node: PageNode): Promise<string> {
  const before = await read(harness, file);
  assert.ok(before.editable, 'the page parses');
  const result = parsePageEditResult(
    await harness.invoke('page:edit', {
      pagePath: file,
      authoredChecksum: before.checksum,
      edit: { tag: 'insert-node', target: refAt(before, at), placement, content: { tag: 'nodes', nodes: [node] } },
    }),
  );
  assert.ok(result.ok, `the insertion applies: ${JSON.stringify(result)}`);
  return fs.readFileSync(file, 'utf8');
}

/** Inserts into a fresh page and pins the exact bytes. Every byte of the page
 * survives in order: the result minus one inserted run is the page itself. */
async function expectInsert(text: string, at: readonly number[], placement: Placement, source: string, expected: string): Promise<void> {
  const written = await insertInto(page(text), at, placement, await nodeFrom(source));
  assert.equal(written, expected);
  assert.ok(isOneInsertion(text, written), 'only inserted text is new; every original byte stays');
}

/** As expectInsert, into a self-closing parent: its ` />` is the one authored run
 * that must change, since the parent gains a closing tag. Every byte before it
 * and after it stays. */
async function expectPairedInsert(text: string, at: readonly number[], source: string, expected: string): Promise<void> {
  const written = await insertInto(page(text), at, 'last-child', await nodeFrom(source));
  assert.equal(written, expected);
  const tail = text.indexOf(' />');
  assert.ok(tail > 0, 'the parent closes itself');
  assert.ok(isOneInsertion(text.slice(0, tail) + text.slice(tail + ' />'.length), written), 'only the self-closing tail is replaced');
}

// Whether `written` is `text` with one run of bytes added at one place.
function isOneInsertion(text: string, written: string): boolean {
  let start = 0;
  while (start < text.length && text[start] === written[start]) {
    start++;
  }
  let end = 0;
  while (end < text.length - start && text[text.length - 1 - end] === written[written.length - 1 - end]) {
    end++;
  }
  return start + end === text.length;
}

const lines = (...rows: readonly string[]): string => rows.join('\n');

const PARAGRAPH = '<p>New</p>';
const CARD = '<div class="card">\n\t<h3>Title</h3>\n\t<p>Body</p>\n</div>';
const COMPONENT = '---\nimport Card from "../components/Card.astro";\n---\n<Card title="Hi" size={2} />';
const LIST = lines('<main>', '  <h1>A</h1>', '  <p>B</p>', '</main>', '');

// --- Placements ----------------------------------------------------------------

test('first child, last child and between siblings line up with the siblings', async () => {
  await expectInsert(LIST, [0], 'first-child', PARAGRAPH, lines('<main>', '  <p>New</p>', '  <h1>A</h1>', '  <p>B</p>', '</main>', ''));
  await expectInsert(LIST, [0], 'last-child', PARAGRAPH, lines('<main>', '  <h1>A</h1>', '  <p>B</p>', '  <p>New</p>', '</main>', ''));
  await expectInsert(LIST, [0, 0], 'after', PARAGRAPH, lines('<main>', '  <h1>A</h1>', '  <p>New</p>', '  <p>B</p>', '</main>', ''));
  await expectInsert(LIST, [0, 1], 'before', PARAGRAPH, lines('<main>', '  <h1>A</h1>', '  <p>New</p>', '  <p>B</p>', '</main>', ''));
});

// --- Empty and one-line parents -------------------------------------------------

test('an empty parent takes its child a level in, its closing tag on a line of its own', async () => {
  const expected = lines('<main>', '  <div>', '    <p>New</p>', '  </div>', '</main>', '');
  await expectInsert(lines('<main>', '  <div></div>', '</main>', ''), [0, 0], 'last-child', PARAGRAPH, expected);
  await expectInsert(lines('<main>', '  <div>', '  </div>', '</main>', ''), [0, 0], 'last-child', PARAGRAPH, expected);
  // The author's closing tag sits at the margin: it keeps that line, untouched.
  await expectInsert(
    lines('<main>', '  <div>', '</div>', '</main>', ''),
    [0, 0],
    'last-child',
    PARAGRAPH,
    lines('<main>', '  <div>', '    <p>New</p>', '</div>', '</main>', ''),
  );
});

test('a parent with its children on one line gives the new block a line of its own', async () => {
  const text = lines('<main>', '  <div><h1>A</h1><p>B</p></div>', '</main>', '');
  await expectInsert(text, [0, 0], 'last-child', PARAGRAPH, lines('<main>', '  <div><h1>A</h1><p>B</p>', '    <p>New</p>', '  </div>', '</main>', ''));
  await expectInsert(text, [0, 0], 'first-child', PARAGRAPH, lines('<main>', '  <div>', '    <p>New</p>', '    <h1>A</h1><p>B</p></div>', '</main>', ''));
  await expectInsert(text, [0, 0, 0], 'after', PARAGRAPH, lines('<main>', '  <div><h1>A</h1>', '    <p>New</p>', '    <p>B</p></div>', '</main>', ''));
});

// --- Beside words and comments ----------------------------------------------------

test('a node beside words stands on its own line at the words’ indentation', async () => {
  // Was: `  Hello\n<p>New</p></main>`, at the margin and welded to the closing tag.
  const words = lines('<main>', '  <h1>A</h1>', '  Hello', '</main>', '');
  const after = lines('<main>', '  <h1>A</h1>', '  Hello', '  <p>New</p>', '</main>', '');
  await expectInsert(words, [0, 1], 'after', PARAGRAPH, after);
  await expectInsert(words, [0], 'last-child', PARAGRAPH, after);
  await expectInsert(words, [0], 'last-child', COMPONENT, lines('<main>', '  <h1>A</h1>', '  Hello', '  <Card title="Hi" size={2} />', '</main>', ''));
  // Was: `<main><p>New</p>\n  Hello`.
  const first = lines('<main>', '  Hello', '  <h1>A</h1>', '</main>', '');
  const before = lines('<main>', '  <p>New</p>', '  Hello', '  <h1>A</h1>', '</main>', '');
  await expectInsert(first, [0], 'first-child', PARAGRAPH, before);
  await expectInsert(first, [0, 0], 'before', PARAGRAPH, before);
  // Was: `  <p>New</p><p>B</p>`.
  await expectInsert(
    lines('<main>', '  <h1>A</h1>', '  Hello', '  <p>B</p>', '</main>', ''),
    [0, 1],
    'after',
    PARAGRAPH,
    lines('<main>', '  <h1>A</h1>', '  Hello', '  <p>New</p>', '  <p>B</p>', '</main>', ''),
  );
  // Was: `  <p>New</p></div>` at the closing tag's depth.
  await expectInsert(
    lines('<main>', '  <div>', '    Hello', '  </div>', '</main>', ''),
    [0, 0],
    'last-child',
    PARAGRAPH,
    lines('<main>', '  <div>', '    Hello', '    <p>New</p>', '  </div>', '</main>', ''),
  );
  await expectInsert(
    lines('<main>', '  <div>', '    Hello', '  </div>', '</main>', ''),
    [0, 0],
    'first-child',
    PARAGRAPH,
    lines('<main>', '  <div>', '    <p>New</p>', '    Hello', '  </div>', '</main>', ''),
  );
});

test('words that touch their neighbours stay touching: inline runs are never broken', async () => {
  await expectInsert(
    lines('<main>', '  <p>Hello</p>', '</main>', ''),
    [0, 0],
    'last-child',
    '<span>s</span>',
    lines('<main>', '  <p>Hello<span>s</span></p>', '</main>', ''),
  );
  await expectInsert(
    lines('<main>', '  <pre>x</pre>', '</main>', ''),
    [0, 0],
    'last-child',
    '<span>s</span>',
    lines('<main>', '  <pre>x<span>s</span></pre>', '</main>', ''),
  );
});

test('a node beside a comment lines up with it', async () => {
  const note = lines('<main>', '  <h1>A</h1>', '  <!-- note -->', '</main>', '');
  const after = lines('<main>', '  <h1>A</h1>', '  <!-- note -->', '  <p>New</p>', '</main>', '');
  await expectInsert(note, [0, 1], 'after', PARAGRAPH, after);
  await expectInsert(note, [0], 'last-child', PARAGRAPH, after);
  await expectInsert(
    lines('<main>', '  <!-- note -->', '  <h1>A</h1>', '</main>', ''),
    [0],
    'first-child',
    PARAGRAPH,
    lines('<main>', '  <p>New</p>', '  <!-- note -->', '  <h1>A</h1>', '</main>', ''),
  );
});

// --- Multi-line nodes, components and slots ---------------------------------------

test('a multi-line node indents its children and closes at its opening tag’s depth', async () => {
  const card = ['  <div class="card">', '    <h3>Title</h3>', '    <p>Body</p>', '  </div>'];
  await expectInsert(lines('<main>', '  <h1>A</h1>', '</main>', ''), [0, 0], 'after', CARD, lines('<main>', '  <h1>A</h1>', ...card, '</main>', ''));
  await expectInsert(lines('<main>', '  <h1>A</h1>', '</main>', ''), [0], 'first-child', CARD, lines('<main>', ...card, '  <h1>A</h1>', '</main>', ''));
  await expectInsert(
    lines('<main>', '  <section></section>', '</main>', ''),
    [0, 0],
    'last-child',
    CARD,
    lines('<main>', '  <section>', ...card.map((row) => `  ${row}`), '  </section>', '</main>', ''),
  );
});

test('a component with props lands as one line beside its siblings and in an empty parent', async () => {
  await expectInsert(
    lines('<main>', '  <h1>A</h1>', '</main>', ''),
    [0, 0],
    'after',
    COMPONENT,
    lines('<main>', '  <h1>A</h1>', '  <Card title="Hi" size={2} />', '</main>', ''),
  );
  await expectInsert(
    lines('<main>', '  <div></div>', '</main>', ''),
    [0, 0],
    'last-child',
    COMPONENT,
    lines('<main>', '  <div>', '    <Card title="Hi" size={2} />', '  </div>', '</main>', ''),
  );
});

test("a component's root, its children and its slot take the same rule", async () => {
  const root = lines('---', 'const x = 1;', '---', '<section class="hero">', '  <h1>A</h1>', '</section>', '');
  await expectInsert(
    root,
    [0],
    'last-child',
    PARAGRAPH,
    lines('---', 'const x = 1;', '---', '<section class="hero">', '  <h1>A</h1>', '  <p>New</p>', '</section>', ''),
  );
  await expectInsert(
    root,
    [0],
    'after',
    PARAGRAPH,
    lines('---', 'const x = 1;', '---', '<section class="hero">', '  <h1>A</h1>', '</section>', '<p>New</p>', ''),
  );
  const slot = lines('<section>', '  <div class="inner">', '    <slot />', '  </div>', '</section>', '');
  await expectPairedInsert(
    slot,
    [0, 0, 0],
    PARAGRAPH,
    lines('<section>', '  <div class="inner">', '    <slot>', '      <p>New</p>', '    </slot>', '  </div>', '</section>', ''),
  );
  await expectInsert(
    slot,
    [0, 0, 0],
    'before',
    PARAGRAPH,
    lines('<section>', '  <div class="inner">', '    <p>New</p>', '    <slot />', '  </div>', '</section>', ''),
  );
  await expectInsert(
    lines('<main>', '  <Card>', '    <p>a</p>', '  </Card>', '</main>', ''),
    [0, 0],
    'last-child',
    PARAGRAPH,
    lines('<main>', '  <Card>', '    <p>a</p>', '    <p>New</p>', '  </Card>', '</main>', ''),
  );
  await expectPairedInsert(
    lines('<main>', '  <Card />', '</main>', ''),
    [0, 0],
    CARD,
    lines('<main>', '  <Card>', '    <div class="card">', '      <h3>Title</h3>', '      <p>Body</p>', '    </div>', '  </Card>', '</main>', ''),
  );
});

// --- Indent styles and line endings -----------------------------------------------

test('4-space and tab files nest in their own unit', async () => {
  await expectInsert(
    lines('<main>', '    <h1>A</h1>', '    <div></div>', '</main>', ''),
    [0, 1],
    'last-child',
    CARD,
    lines(
      '<main>',
      '    <h1>A</h1>',
      '    <div>',
      '        <div class="card">',
      '            <h3>Title</h3>',
      '            <p>Body</p>',
      '        </div>',
      '    </div>',
      '</main>',
      '',
    ),
  );
  await expectInsert(
    lines('<main>', '\t<h1>A</h1>', '\t<div></div>', '</main>', ''),
    [0, 1],
    'last-child',
    CARD,
    lines('<main>', '\t<h1>A</h1>', '\t<div>', '\t\t<div class="card">', '\t\t\t<h3>Title</h3>', '\t\t\t<p>Body</p>', '\t\t</div>', '\t</div>', '</main>', ''),
  );
});

test('a file mixing tabs and spaces nests each new line in the style of its own region', async () => {
  // Was: `        <div class="card">` followed by `        \t<h3>`: spaces then a tab.
  const mixed = ['<main>', '\t<div>', '\t\t<h1>A</h1>', '\t</div>'];
  await expectInsert(
    lines(...mixed, '    <section>', '        <p>x</p>', '    </section>', '</main>', ''),
    [0, 1],
    'last-child',
    CARD,
    lines(
      ...mixed,
      '    <section>',
      '        <p>x</p>',
      '        <div class="card">',
      '            <h3>Title</h3>',
      '            <p>Body</p>',
      '        </div>',
      '    </section>',
      '</main>',
      '',
    ),
  );
  // Was: `    \t<div class="card">`.
  await expectInsert(
    lines(...mixed, '    <section></section>', '</main>', ''),
    [0, 1],
    'last-child',
    CARD,
    lines(
      ...mixed,
      '    <section>',
      '        <div class="card">',
      '            <h3>Title</h3>',
      '            <p>Body</p>',
      '        </div>',
      '    </section>',
      '</main>',
      '',
    ),
  );
  await expectInsert(
    lines(...mixed, '    <section></section>', '</main>', ''),
    [0, 0],
    'last-child',
    CARD,
    lines(
      '<main>',
      '\t<div>',
      '\t\t<h1>A</h1>',
      '\t\t<div class="card">',
      '\t\t\t<h3>Title</h3>',
      '\t\t\t<p>Body</p>',
      '\t\t</div>',
      '\t</div>',
      '    <section></section>',
      '</main>',
      '',
    ),
  );
});

test('a CRLF file gets CRLF on every new line', async () => {
  const crlf = (...rows: readonly string[]): string => rows.join('\r\n');
  await expectInsert(
    crlf('<main>', '  <h1>A</h1>', '  <div></div>', '</main>', ''),
    [0, 1],
    'last-child',
    CARD,
    crlf('<main>', '  <h1>A</h1>', '  <div>', '    <div class="card">', '      <h3>Title</h3>', '      <p>Body</p>', '    </div>', '  </div>', '</main>', ''),
  );
  await expectInsert(
    crlf('<main>', '  <h1>A</h1>', '  Hello', '</main>', ''),
    [0],
    'last-child',
    PARAGRAPH,
    crlf('<main>', '  <h1>A</h1>', '  Hello', '  <p>New</p>', '</main>', ''),
  );
});

// --- The end of a document --------------------------------------------------------

test('at the end of the body and the document the closing tags keep their lines', async () => {
  const document = lines('<html>', '  <body>', '    <main>', '      <p>x</p>', '    </main>', '  </body>', '</html>', '');
  await expectInsert(
    document,
    [0, 0],
    'last-child',
    PARAGRAPH,
    lines('<html>', '  <body>', '    <main>', '      <p>x</p>', '    </main>', '    <p>New</p>', '  </body>', '</html>', ''),
  );
  await expectInsert(
    document,
    [0],
    'last-child',
    PARAGRAPH,
    lines('<html>', '  <body>', '    <main>', '      <p>x</p>', '    </main>', '  </body>', '  <p>New</p>', '</html>', ''),
  );
  await expectInsert(
    lines('<html>', '  <body></body>', '</html>', ''),
    [0, 0],
    'last-child',
    CARD,
    lines('<html>', '  <body>', '    <div class="card">', '      <h3>Title</h3>', '      <p>Body</p>', '    </div>', '  </body>', '</html>', ''),
  );
});

// --- A closing tag on its last child's line -----------------------------------------

test('a closing tag that shares its last child’s line gets its own line back', async () => {
  const shared = lines('<main>', '  <div>', '    <p>a</p></div>', '</main>', '');
  // Was: `    <p>New</p></div>`.
  await expectInsert(shared, [0, 0], 'last-child', PARAGRAPH, lines('<main>', '  <div>', '    <p>a</p>', '    <p>New</p>', '  </div>', '</main>', ''));
  await expectInsert(shared, [0, 0, 0], 'after', PARAGRAPH, lines('<main>', '  <div>', '    <p>a</p>', '    <p>New</p>', '  </div>', '</main>', ''));
  // Was: `    </div></div>`.
  await expectInsert(
    shared,
    [0, 0],
    'last-child',
    CARD,
    lines('<main>', '  <div>', '    <p>a</p>', '    <div class="card">', '      <h3>Title</h3>', '      <p>Body</p>', '    </div>', '  </div>', '</main>', ''),
  );
  await expectInsert(
    lines('<main>', '\t<ul>', '\t\t<li>a</li></ul>', '</main>', ''),
    [0, 0],
    'last-child',
    '<li>b</li>',
    lines('<main>', '\t<ul>', '\t\t<li>a</li>', '\t\t<li>b</li>', '\t</ul>', '</main>', ''),
  );
  // In a phrasing parent the line break would be a visible space: left alone.
  await expectInsert(
    lines('<main>', '  <p>', '    one <b>a</b></p>', '</main>', ''),
    [0, 0],
    'last-child',
    '<span>s</span>',
    lines('<main>', '  <p>', '    one <b>a</b><span>s</span></p>', '</main>', ''),
  );
  // An opening tag on its first child's line: the new first child takes a line.
  await expectInsert(
    lines('<main>', '  <div><p>a</p>', '    <p>b</p>', '  </div>', '</main>', ''),
    [0, 0],
    'first-child',
    PARAGRAPH,
    lines('<main>', '  <div>', '    <p>New</p>', '    <p>a</p>', '    <p>b</p>', '  </div>', '</main>', ''),
  );
});

// --- Several nodes in a row -------------------------------------------------------

test('nodes inserted one after another, as a paste or a recipe does, each line up', async () => {
  const file = page(lines('<main>', '  <section class="hero"></section>', '</main>', ''));
  await insertInto(file, [0, 0], 'last-child', await nodeFrom('<h1>Title</h1>'));
  await insertInto(file, [0, 0, 0], 'after', await nodeFrom(CARD));
  await insertInto(file, [0, 0, 1], 'after', await nodeFrom(COMPONENT));
  const written = await insertInto(file, [0, 0], 'last-child', await nodeFrom('<p>Last</p>'));
  assert.equal(
    written,
    lines(
      '<main>',
      '  <section class="hero">',
      '    <h1>Title</h1>',
      '    <div class="card">',
      '      <h3>Title</h3>',
      '      <p>Body</p>',
      '    </div>',
      '    <Card title="Hi" size={2} />',
      '    <p>Last</p>',
      '  </section>',
      '</main>',
      '',
    ),
  );
  // After words and into a one-line parent, the same sequence stays aligned.
  const words = page(lines('<main>', '  <div>', '    Intro', '  </div>', '</main>', ''));
  await insertInto(words, [0, 0], 'last-child', await nodeFrom(PARAGRAPH));
  const twice = await insertInto(words, [0, 0], 'last-child', await nodeFrom(PARAGRAPH));
  assert.equal(twice, lines('<main>', '  <div>', '    Intro', '    <p>New</p>', '    <p>New</p>', '  </div>', '</main>', ''));
});

test('isOneInsertion tells an insertion from a rewrite', () => {
  assert.ok(isOneInsertion('ab', 'aXb'));
  assert.ok(isOneInsertion('ab', 'abX'));
  assert.equal(isOneInsertion('a b', 'aX\nb'), false);
});

test('indentUnitBelow nests in the style of the base line, else the file’s unit', () => {
  const mixed = lines('<main>', '\t<div>', '\t\t<h1>A</h1>', '\t</div>', '    <section>', '        <p>x</p>', '    </section>', '</main>');
  assert.equal(indentUnitBelow(mixed, '\t'), '\t');
  assert.equal(indentUnitBelow(mixed, '    '), '    ');
  assert.equal(indentUnitBelow(mixed, ''), '\t', 'a tie between tabs and spaces is a tab');
  assert.equal(indentUnitBelow(mixed, '\t  '), '\t', 'a mixed base takes the file’s unit');
  assert.equal(indentUnitBelow(lines('<main>', '  <p>x</p>', '</main>'), '\t'), '\t');
  assert.equal(indentUnitBelow('<p>x</p>', '  '), '  ', 'a file with no step nests by the default width');
  assert.throws(() => indentUnitBelow(mixed, 'x'), /indentUnitBelow: a base indent is only whitespace/);
  assert.throws(() => indentUnitBelow(mixed, '\n'), /indentUnitBelow: a base indent is one line/);
});
