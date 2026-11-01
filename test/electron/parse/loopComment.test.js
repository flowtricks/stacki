// A comment is not a statement.
//
//   node test/electron/parse/loopComment.test.js
//
// A loop that declares something before it renders is written with a statement
// body:
//
//   | {items.map((item) => {
//   |   /* Not everything listed has somewhere of its own to lead. */
//   |   const Element = item.href ? "a" : "div";
//   |   return ( <li>…</li> );
//   | })}
//
// That form is read as a loop — the declarations kept aside, the returned
// markup becoming the loop's children. But the block was split into statements
// and every one of them had to be a declaration or the return, and the first
// thing in this block is neither. It is somebody telling the next reader why
// the loop is shaped this way. For that sentence, thirty cards' worth of
// markup — the whole leadership page — went back to being a wall of code with
// nothing in it to select.
//
// So a comment rides on the statement it introduces (including the return),
// and is written back where it was. Two smaller rules come with it: prose is
// allowed a semicolon and an apostrophe in it, since the splitter now skips a
// comment whole rather than reading it as code.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

const { parsePage, serializePage, locateSelection } = require('#dist/electron/parse/astroParser.js');
const { LIMITS } = require('#dist/shared/core/limits.js');
const assert = require('node:assert/strict');

const os = require('os');
const { repoPath } = require('../../helpers/sources.js');

const page = (body) => `---\nconst items = [];\n---\n<ul>\n${body}\n</ul>\n`;

// locateSelection answers about a file on disk, so a case that asks where a
// node is has to be one.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-comment-'));
let written = 0;
function onDisk(body) {
  const file = path.join(scratch, `case-${written++}.astro`);
  fs.writeFileSync(file, page(body));
  return file;
}

// The first loop node anywhere in a tree, and every node under it.
const find = (nodes, kind, depth = 0) => {
  assert.ok(depth <= LIMITS.treeDepthMax, 'find: depth limit');
  for (const node of nodes || []) {
    if (node.kind === kind) {
      return node;
    }
    const deeper = find(node.children, kind, depth + 1);
    if (deeper) {
      return deeper;
    }
  }
  return undefined;
};
const count = (nodes, depth = 0) => {
  assert.ok(depth <= LIMITS.treeDepthMax, 'count: depth limit');
  return (nodes || []).reduce((total, node) => total + 1 + count(node.children, depth + 1), 0);
};

// Reads as a loop, keeps its bytes.
function loopIn(body, what) {
  const source = page(body);
  const parsed = parsePage(source);
  const loop = parsed.editable ? find(parsed.model.nodes, 'map') : undefined;
  check(`${what} — opens as a loop`, !!loop, parsed.editable ? 'read as code, not a loop' : parsed.reason);
  if (parsed.editable) {
    check(`${what} — and is written back as it was`, serializePage(parsed.model) === source, 'the file changed');
  }
  return loop;
}

{
  const source = page('  {items.map((item) => <li>{item}</li>)}').replace(/\n/g, '\r\n');
  const parsed = parsePage(source);
  check('a CRLF page remains editable', parsed.editable, parsed.reason);
  if (parsed.editable) {
    check('and keeps its Windows line endings byte for byte', serializePage(parsed.model) === source, 'the line endings changed');
  }
}

// --- the page this came from -------------------------------------------------
{
  const loop = loopIn(
    `  {items.map((item) => {
    /* Not everything listed has somewhere of its own to lead. */
    const Element = item.href ? "a" : "div";
    return (
      <li class="filter_content_item">
        <Element href={item.href}>{item.title}</Element>
      </li>
    );
  })}`,
    'a loop that says why it exists',
  );
  check('the markup under it is the tree, not a string', count(loop?.children) === 3, `${count(loop?.children)} nodes`);
  check('and the sentence is still in the block', (loop?.body || []).join('\n').includes('somewhere of its own to lead'), JSON.stringify(loop?.body));
  check(
    'the declaration keeps its semicolon',
    (loop?.body || []).some((line) => /const Element = item\.href \? "a" : "div";$/.test(line)),
    JSON.stringify(loop?.body),
  );
}

// --- where else a comment lands ----------------------------------------------
loopIn(
  `  {items.map((item) => {
    const label = item.title; // what the row says
    return <li>{label}</li>;
  })}`,
  'a comment after a declaration',
);

loopIn(
  `  {items.map((item) => {
    const label = item.title;
    // Whatever it is, it goes in a row.
    return <li>{label}</li>;
  })}`,
  'a comment above the return',
);

{
  // A comment that shares the return's line is part of the same statement —
  // the only place the return itself carries one.
  const loop = loopIn(
    `  {items.map((item) => {
    const label = item.title; /* and then the row */ return <li>{label}</li>;
  })}`,
    "a comment on the return's own line",
  );
  check(
    'it is kept beside the return',
    (loop?.body || []).some((line) => line.includes('and then the row')),
    JSON.stringify(loop?.body),
  );
  // And the markup after it still points at itself. A comment can be as long as
  // it needs to be, so counting past it is counting past its lines too.
  const body = `  {items.map((item) => {
    const label = item.title; /* the row, which is
    the whole of what this loop is for */ return <li>{label}</li>;
  })}`;
  const at = locateSelection(onDisk(body), '0.0.0');
  check('the markup after it points at its own line', at?.startLine === 7, `line ${at?.startLine}, not 7`);
}

loopIn(
  `  {items.map((item) => {
    // First: the one thing every row has.
    const label = item.title;
    /* Then: the row. */
    return <li>{label}</li>;
  })}`,
  'a comment above each of them',
);

// --- prose is prose ----------------------------------------------------------
{
  const loop = loopIn(
    `  {items.map((item) => {
    /* Two things happen here; this is the first. */
    const label = item.title;
    return <li>{label}</li>;
  })}`,
    'a semicolon in the prose',
  );
  check(
    'a semicolon inside a comment did not end a statement',
    (loop?.body || []).some((line) => line.includes('this is the first.')),
    JSON.stringify(loop?.body),
  );
}
{
  const loop = loopIn(
    `  {items.map((item) => {
    // Use the title when there isn't a heading.
    const label = item.heading || item.title;
    return <li>{label}</li>;
  })}`,
    'an apostrophe in the prose',
  );
  check(
    'an apostrophe inside a comment is an apostrophe',
    (loop?.body || []).some((line) => line.includes("isn't a heading")),
    JSON.stringify(loop?.body),
  );
}

// --- what is still not a statement -------------------------------------------
const stillCode = (body, what) => {
  const parsed = parsePage(page(body));
  const loop = parsed.editable ? find(parsed.model.nodes, 'map') : undefined;
  check(what, !loop, 'opened as a loop — its body would be rewritten from a shape this file cannot hold');
};

loopIn(
  `  {items.map((item) => {
    if (!item.title) return null;
    return <li>{item.title}</li>;
  })}`,
  'a loop with early returns preserves its decisions',
);
stillCode(
  `  {items.map((item) => {
    /* an opening with no close
    const label = item.title;
    return <li>{label}</li>;
  })}`,
  'a comment nobody closed stays code',
);
loopIn(
  `  {items.map((item) => {
    const label = item.title;
    return <li>{label}</li>;
    /* and then some. */
  })}`,
  'comments after the return remain in the callback',
);

// --- the corpus holds the real one -------------------------------------------
{
  const name = 'why-a-loop-exists.astro';
  const file = path.join(repoPath('test/corpus'), name);
  check('the page this came from is in the corpus', fs.existsSync(file), file);
  if (fs.existsSync(file)) {
    const source = fs.readFileSync(file, 'utf8');
    const parsed = parsePage(source);
    const loop = parsed.editable ? find(parsed.model.nodes, 'map') : undefined;
    check('and it opens as a loop', !!loop, parsed.reason || 'read as code');
    check('with all thirty cards worth of markup under it', count(loop?.children) > 15, `${count(loop?.children)} nodes`);
    check('and comes back byte for byte', serializePage(parsed.model) === source, 'the file changed');

    // A tree of the file: clicking a card on the canvas has to land on the
    // lines that card is written on. The block form used to parse its markup
    // with no idea where in the file it sat, so every node under the loop —
    // every card on the page — knew nothing about its own lines.
    const lines = source.split('\n');
    const lineOf = (text) => lines.findIndex((line) => line.includes(text)) + 1;
    const at = locateSelection(file, '0.0.0');
    check('the card under the loop knows its lines', typeof at?.startLine === 'number', JSON.stringify(at));
    check('and they are the lines it is written on', at?.startLine === lineOf('<li'), `${at?.startLine}, not ${lineOf('<li')}`);
    const inner = locateSelection(file, '0.0.0.0.0');
    check('so does the one inside it', inner?.startLine === lineOf('<Element'), `${inner?.startLine}, not ${lineOf('<Element')}`);
  }
}

if (failures.length) {
  console.error(`\nloop-comment: ${failures.length} failed, ${checked - failures.length} passed\n`);
  console.error(failures.join('\n') + '\n');
  process.exit(1);
}
console.log(`loop-comment: ${checked} passed  [a comment is not a statement]`);
