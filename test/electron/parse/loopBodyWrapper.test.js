// Goal: whatever is placed in a loop, the file says it as valid Astro, and it
// reads back as the same loop with the same contents. A Text element dropped
// into a new loop was written `items.map((item) => ( Text ))`: in JSX that is
// the identifier of the browser's Text class, so the loop read back as code,
// its Settings fell back to a code field and nothing could be dropped into it.
// Method: build loops with each kind of body (text, an expression, a {/* */} comment,
// text beside an element) through the writer, check the wrapper it adds,
// read the result back, and compile it with both Astro compilers. Then the
// shapes that must not change: one element, elements side by side and HTML comments among them stay
// unwrapped, a `<Fragment>` spelling is kept, a Fragment with attributes stays
// a node, and the page contract accepts the wrapper and refuses any other.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parsePage, serializePage, serializePageMarked } = require('#dist/electron/parse/astroParser.js');
const { parsePageResult } = require('#dist/shared/page/pageNode.js');

const PAGE = (body) => `---\nconst items = [1];\n---\n<div>{items.map((item) => (${body}))}</div>\n`;

function model(source) {
  const result = parsePage(source);
  assert.equal(result.editable, true, result.reason);
  assert.equal(parsePageResult(result).editable, true, 'the page contract accepts the tree');
  return result.model;
}

function loopOf(page) {
  const div = page.nodes.find((node) => node.kind === 'element');
  const loop = div?.children?.find((node) => node.kind === 'map');
  assert.ok(loop, 'the loop reads as a loop, not as code');
  return loop;
}

// A loop with `children`, written by the app's own writer from a tree.
function written(children) {
  const page = model(PAGE('<p>seed</p>'));
  const loop = loopOf(page);
  loop.children = children;
  delete loop.source;
  delete loop.fragment;
  return serializePage(page);
}

const text = (value) => ({ id: 't', kind: 'text', value });
const element = (name, children = []) => ({ id: name, kind: 'element', name, props: {}, children });

test('a body that is not made of elements is written inside <>', () => {
  for (const [what, children] of [
    ['text', [text('Text')]],
    ['an expression', [{ id: 'e', kind: 'expr', value: '{item.title}' }]],
    ['a {/* */} comment', [{ id: 'c', kind: 'comment', value: ' note ', jsx: true }]],
    ['text beside an element', [text('Lead'), element('p', [text('Body')])]],
  ]) {
    const source = written(children);
    assert.match(source, /=> \(\s*<>[\s\S]*<\/>\s*\)\)/, `${what}: wrapped in <>`);
    const loop = loopOf(model(source));
    assert.equal(loop.fragment, '<>', `${what}: the wrapper is remembered`);
    assert.equal(loop.children.length, children.length, `${what}: read back with its contents, not a Fragment`);
    assert.equal(serializePage(model(source)), source, `${what}: a second save changes nothing`);
  }
});

test('the file a Text drop used to write no longer comes out', () => {
  const source = written([text('Text')]);
  assert.doesNotMatch(source, /\(\s*Text\s*\)/, 'no bare Text in the parentheses');
});

test('elements alone are written as before', () => {
  assert.doesNotMatch(written([element('p')]), /<>/, 'one element needs no wrapper');
  assert.doesNotMatch(written([element('p'), element('hr')]), /<>/, 'elements side by side need none either');
  assert.doesNotMatch(written([element('li'), { id: 'c', kind: 'comment', value: ' Note ' }]), /<>/, 'nor an HTML comment beside an element');
});

test('a wrapper is unwrapped on reading, in its own spelling, and kept when it does something', () => {
  const named = loopOf(model(PAGE('<Fragment><p>A</p>Tail</Fragment>')));
  assert.equal(named.fragment, 'Fragment');
  assert.deepEqual(
    named.children.map((node) => node.kind),
    ['element', 'text'],
  );
  assert.match(serializePage(model(PAGE('<Fragment><p>A</p>Tail</Fragment>'))), /<Fragment>[\s\S]*<\/Fragment>/, 'the spelling is kept');
  const active = loopOf(model(PAGE('<Fragment set:html={item} />')));
  assert.equal(active.fragment, undefined, 'a Fragment with attributes is content, not a wrapper');
  assert.equal(active.children[0]?.name, 'Fragment');
});

test('the page contract accepts the two wrappers and refuses any other', () => {
  const result = parsePage(PAGE('<>Text</>'));
  assert.equal(parsePageResult(result).editable, true);
  const loop = loopOf(result.model);
  loop.fragment = 'span';
  assert.throws(() => parsePageResult(result), /fragment: unknown wrapper/);
});

test('every wrapped body compiles with both Astro compilers, in the file and in the preview', async () => {
  const sources = [written([text('Text')]), written([text('Lead'), element('p', [text('Body')])]), written([{ id: 'e', kind: 'expr', value: '{item}' }])];
  for (const compilerName of ['@astrojs/compiler', '@astrojs/compiler-rs']) {
    const { transform } = await import(compilerName);
    for (const source of sources) {
      for (const output of [source, serializePageMarked(model(source))]) {
        const result = await transform(output, { filename: '/loop.astro' });
        const errors = (result.diagnostics || []).filter((diagnostic) => diagnostic.severity === 'error' || diagnostic.severity === 1);
        assert.deepEqual(errors, [], `${compilerName}: ${output}`);
      }
    }
  }
});
