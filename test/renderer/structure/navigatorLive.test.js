// Goal: while content is typed and not yet in the file, the Navigator's tree is what is typed (a new paragraph, a
// break, a removed block, a new tag, new words), rows that are still the same node keep their id, the row of the
// caret's block is named, and clearing the typed content gives the file's own tree back untouched.
// Method: the pure projection (features/structure/navigatorLive.ts) over a small page tree, with JSDOM to parse the
// editor's HTML. The live value's own rules (one owner clears only what it set) are checked beside it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule');

const { navigatorLiveTree, isLiveRowId } = loadRenderer('src/features/structure/navigatorLive.ts');
const { liveContent, setLiveContent, clearLiveContent } = loadRenderer('src/ui/liveContent.ts');
const { window } = new JSDOM('<!doctype html><body></body>');

const text = (id, value) => ({ kind: 'text', id, value });
const element = (id, name, children, props = {}) => ({ kind: 'element', id, name, props, children });
const page = [
  element('body', 'body', [
    {
      kind: 'component',
      id: 'rich',
      name: 'RichText',
      props: {},
      children: [element('p1', 'p', [text('t1', 'First')], { class: { type: 'string', value: 'lead' } })],
    },
    element('after', 'p', [text('t2', 'After')]),
  ]),
];
const typed = (html, caret) => navigatorLiveTree(page, { content: { owner: 's', nodeID: 'rich', html, caret }, draft: undefined }, window.document);
const rich = (tree) => tree.nodes[0].children[0];

test('a new paragraph is a row at once, the first keeps its id and class, and the caret’s block is named', () => {
  const tree = typed('<p class="lead">First</p>\n<p></p>', [1]);
  const [first, second] = rich(tree).children;
  assert.equal(rich(tree).children.length, 2);
  assert.equal(first.id, 'p1');
  assert.deepEqual(first.props, { class: { type: 'string', value: 'lead' } });
  assert.equal(first.children[0].id, 't1');
  assert.equal(second.name, 'p');
  assert.equal(isLiveRowId(second.id), true);
  assert.equal(tree.caretId, second.id);
  assert.equal(tree.nodes[0].children[1], page[0].children[1], 'nodes outside what is typed are the file’s own');
});

test('words, tags, breaks and list items follow the editor', () => {
  assert.equal(rich(typed('<p>Firstly typed</p>')).children[0].children[0].value, 'Firstly typed');
  assert.equal(rich(typed('<h2>First</h2>')).children[0].name, 'h2');
  assert.deepEqual(
    rich(typed('<p>One<br>Two</p>')).children[0].children.map((node) => node.name ?? node.value),
    ['One', 'br', 'Two'],
  );
  const list = typed('<ul>\n  <li>a</li>\n  <li>b</li>\n</ul>', [0, 1]);
  assert.equal(rich(list).children[0].children.length, 2);
  assert.equal(list.caretId, rich(list).children[0].children[1].id);
  assert.deepEqual(rich(typed('')).children, [], 'every block removed');
  assert.equal(typed('<p>x</p>', []).caretId, 'rich', 'an empty position is the node itself');
});

test('a typed plain text is its row’s words, and nothing typed is the file’s tree itself', () => {
  const draft = { kind: 'text', session: 's', projectPath: '/p', file: 'f', nodeID: 't2', sourceValue: 'After', value: 'After words' };
  const tree = navigatorLiveTree(page, { content: undefined, draft }, window.document);
  assert.equal(tree.nodes[0].children[1].children[0].value, 'After words');
  assert.equal(navigatorLiveTree(page, { content: undefined, draft: undefined }, window.document).nodes, page);
  const gone = navigatorLiveTree(page, { content: { owner: 's', nodeID: 'missing', html: '<p>x</p>' }, draft: undefined }, window.document);
  assert.equal(gone.nodes, page);
});

test('only the owner clears what it typed', () => {
  setLiveContent({ owner: 'canvas', nodeID: 'rich', html: '<p>a</p>' });
  clearLiveContent('another');
  assert.equal(liveContent.get()?.owner, 'canvas');
  const held = liveContent.get();
  setLiveContent({ owner: 'canvas', nodeID: 'rich', html: '<p>a</p>' });
  assert.equal(liveContent.get(), held, 'the same content notifies no one');
  clearLiveContent('canvas');
  assert.equal(liveContent.get(), undefined);
});
