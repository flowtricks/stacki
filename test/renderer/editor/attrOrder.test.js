// The order of a tag's attributes belongs to the file.
//
//   node test/renderer/editor/attrOrder.test.js
//
//   <Input variant="first-name" required />
//   <Input variant="last-name" required />
//
// Editing the first one's variant used to give back
//
//   <Input required variant="given-name" />
//
// — the same tag, saying the same thing, no longer written like the line under
// it. Nobody asked for that, and it shows up in the diff as a change to a line
// that was only read.
//
// The cause is that the order was never recorded anywhere. A JS object
// remembers the order its keys were added, and that is the file's order right
// up until a prop is taken out and put back — which is what clearing a field
// and typing into it again does — and then the key returns at the end.
//
// So the order is written down when the file is read, and the writer follows
// it: what the file had, where the file had it, then anything added since. A
// prop that comes back returns to the slot it left, which is what "put it back"
// should mean.

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

const { parsePage, serializePage, parseTemplate, serializeNodes } = require('#dist/electron/parse/astroParser.js');

// `src/editor/attrOrder.ts` is the renderer's module, so it comes in the way the app
// gets it rather than as a copy of its rules.
const fs = require('fs');
const path = require('path');
const { repoPath } = require('../../helpers/sources.js');
const buildDirectory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(buildDirectory, { recursive: true });
const bundled = path.join(buildDirectory, 'attr-order.cjs');
require('esbuild').buildSync({
  entryPoints: [repoPath('src/editor/attrOrder.ts')],
  outfile: bundled,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  logLevel: 'silent',
});
const { renamedAttr } = require(bundled);
// The rename as the app applies it: a new node, the old one untouched.
const renameAttr = (node, from, to) => {
  const renamed = renamedAttr(node, from, to);
  if (renamed === undefined) {
    return false;
  }
  Object.assign(node, renamed);
  return true;
};

const page = (body) => `---\n---\n${body}\n`;
const stringValue = (value) => ({ type: 'string', value });

// The tag as it comes back out, after `edit` has had the node.
function after(body, edit, pick = (nodes) => nodes[0]) {
  const parsed = parsePage(page(body));
  if (!parsed.editable) {
    return `(code view: ${parsed.reason})`;
  }
  edit(pick(parsed.model.nodes), parsed.model);
  return serializePage(parsed.model).split('\n').slice(2, -1).join('\n');
}

// --- the line from the form ---------------------------------------------------
const INPUT = '<Input variant="first-name" required />';
{
  // Clearing a text field deletes the prop; typing into it writes a new one.
  // Between those two the model has forgotten where it was.
  const out = after(INPUT, (node) => {
    delete node.props.variant;
    node.props.variant = stringValue('given-name');
  });
  check('a prop cleared and retyped stays where it was', out === '<Input variant="given-name" required />', out);
}
{
  const out = after(INPUT, (node) => {
    node.props.variant = stringValue('given-name');
  });
  check('editing one in place is still in place', out === '<Input variant="given-name" required />', out);
}
{
  const out = after(INPUT, (node) => {
    delete node.props.required;
  });
  check('removing one leaves the rest where they were', out === '<Input variant="first-name" />', out);
}
{
  const out = after(INPUT, (node) => {
    node.props.placeholder = stringValue('First name');
  });
  check('a prop the file never had goes at the end', out === '<Input variant="first-name" required placeholder="First name" />', out);
}
{
  // What the props panel does when a union branch forbids a prop and then
  // allows it again: taken out, held, put back.
  const out = after(INPUT, (node) => {
    const held = node.props.variant;
    delete node.props.variant;
    node.props.disabled = { type: 'bare' };
    node.props.variant = held;
  });
  check('one set aside and put back returns to its own slot', out === '<Input variant="first-name" required disabled />', out);
}

// --- the shapes an attribute comes in -----------------------------------------
{
  const source = '<img src="/a.png" alt="" width={w} height={h} loading="lazy" />';
  const out = after(source, (node) => {
    delete node.props.alt;
    node.props.alt = stringValue('A hallway');
  });
  check(
    'strings, expressions and bare names keep one order between them',
    out === '<img src="/a.png" alt="A hallway" width={w} height={h} loading="lazy" />',
    out,
  );
}
{
  const source = '<Card {...rest} title="Hi" class:list={[base]} data-x="1" />';
  const out = after(source, (node) => {
    delete node.props.title;
    node.props.title = stringValue('Hello');
  });
  check('a spread holds its place too', out === '<Card {...rest} title="Hello" class:list={[base]} data-x="1" />', out);
}

// --- a tag written across lines ------------------------------------------------
{
  const source = `<Input
  variant="first-name"
  required
/>`;
  const parsed = parsePage(page(source));
  const node = parsed.model.nodes[0];
  check('a multi-line tag is kept as written', serializePage(parsed.model).includes('\n  variant="first-name"\n'), 'reflowed');
  delete node.props.variant;
  node.props.variant = stringValue('given-name');
  const out = serializePage(parsed.model);
  check('and once edited it reflows in the file’s order', out.includes('<Input variant="given-name" required />'), out.split('\n').slice(2, -1).join('\n'));
}

// --- an element inside a line of prose -----------------------------------------
{
  const nodes = parseTemplate('<p>Call <a href="/x" class="link" target="_blank">us</a> today.</p>').nodes;
  const link = nodes[0].children.find((child) => child.name === 'a');
  delete link.props.href;
  link.props.href = stringValue('/y');
  const out = serializeNodes(nodes, '');
  check('an inline tag keeps its order as well', out.includes('<a href="/y" class="link" target="_blank">'), out);
}

// --- renaming one -------------------------------------------------------------
//
// The only edit that changes a name rather than a value, and the order is kept
// by name. Run through the real module the app calls.
{
  const parsed = parsePage(page('<div data-role="hero" class="wrap" id="one"></div>'));
  const node = parsed.model.nodes[0];
  const moved = renameAttr(node, 'data-role', 'data-kind');
  check('a rename reports that it happened', moved === true, String(moved));
  const out = serializePage(parsed.model).split('\n')[2];
  check('and the renamed prop stays in its slot', out === '<div data-kind="hero" class="wrap" id="one"></div>', out);
}
{
  const parsed = parsePage(page('<div id="one" class="wrap" title="Hi"></div>'));
  const node = parsed.model.nodes[0];
  renameAttr(node, 'title', 'class'); // onto a name the tag already had
  const out = serializePage(parsed.model).split('\n')[2];
  check('renaming onto an existing name takes that slot over', out === '<div id="one" class="Hi"></div>', out);
}
{
  const parsed = parsePage(page('<div id="one"></div>'));
  const node = parsed.model.nodes[0];
  check('renaming what is not there does nothing', renameAttr(node, 'title', 'alt') === false, 'it did something');
  check('and renaming to the same name does nothing', renameAttr(node, 'id', 'id') === false, 'it did something');
}

// The app's rename goes through it — a second copy of the rule elsewhere would
// be a second answer to where a renamed prop lives.
{
  const gestures = fs.readFileSync(repoPath('src/editor/editGestures.ts'), 'utf8');
  check(
    'the app renames props through that module',
    /renamedAttr\(found, names\.from, names\.to\)/.test(gestures),
    'the rename gesture renames props its own way',
  );
}

// --- what has no order to keep -------------------------------------------------
{
  // A tag the app builds itself was never in a file; its props go out in the
  // order they were set.
  const nodes = parseTemplate('<div></div>').nodes;
  nodes[0].props = { class: stringValue('card'), id: stringValue('one') };
  const out = serializeNodes(nodes, '');
  check('a tag with no file behind it writes what it was given', out.includes('<div class="card" id="one">'), out);
}

// --- the canvas still marks what it marks ---------------------------------------
//
// The path attribute is not one of the file's, so the order says nothing about
// where it goes; it keeps the place the canvas writer gives it, which is after
// what the tag already had.
{
  const { serializePageMarked } = require('#dist/electron/parse/astroParser.js');
  const marks = (body) => {
    const parsed = parsePage(page(body));
    return serializePageMarked(parsed.model, 'src/pages/index.astro');
  };
  const marked = marks('<div class="wrap"><p id="x" role="note">Hi</p></div>');
  check(
    'the path attribute is written after the tag’s own props',
    /<p id="x" role="note" data-avb-p=/.test(marked),
    marked.split('\n').find((line) => line.includes('<p ')) || marked,
  );
  // And an edited prop does not push it around either: what the canvas gets
  // for an edited page is what it gets for the same page written that way.
  const edited = (() => {
    const parsed = parsePage(page('<div class="wrap"><p id="x" role="note">Hi</p></div>'));
    const para = parsed.model.nodes[0].children[0];
    delete para.props.id;
    para.props.id = stringValue('y');
    return serializePageMarked(parsed.model, 'src/pages/index.astro');
  })();
  // The one place the marker must NOT go last. An element that spreads its rest
  // props gets a second `data-avb-p` from inside the spread, and an html parser
  // keeps the first one in the tag — so the canvas's own has to be in front of
  // it. (Getting this backwards is what made <Tabs> close itself on a click:
  // its root kept the caller's path.) The file's order must not pull it back.
  const spread = marks('<div class="wrap" {...rest}>Hi</div>');
  check(
    'on a tag that spreads, the marker goes in front of everything',
    /<div data-avb-p=.*class="wrap".*\{\.\.\.rest\}/.test(spread),
    spread.split('\n').find((line) => line.includes('<div ')) || spread,
  );
  check(
    'and an edited prop leaves the marked page as it would have been written',
    edited === marks('<div class="wrap"><p id="y" role="note">Hi</p></div>'),
    edited.split('\n').find((line) => line.includes('<p ')) || edited,
  );
}

if (failures.length) {
  console.error(`\nattr-order: ${failures.length} failed, ${checked - failures.length} passed\n`);
  console.error(failures.join('\n') + '\n');
  process.exit(1);
}
console.log(`attr-order: ${checked} passed  [the order belongs to the file]`);
