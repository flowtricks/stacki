// Goal: Content edits must survive saving without replacing the focused DOM or caret.
// Method: mount RichContent with Desktop's real content-edit hook, then echo each gesture
// through the Astro serializer/parser. Simulate the DOM edit made by Backspace before input;
// unlike fill(), this preserves the text node and exposes a save that resets the selection.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const { parsePage, serializePage } = require('#dist/electron/parse/astroParser.js');
const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'content-caret.cjs');
buildSync({
  stdin: {
    contents: `export { default as RichContent } from './src/features/props/RichContent';
      export { useContentEdits } from './src/app/state/appPropertyEdits';`,
    resolveDir: path.dirname(repoPath('package.json')),
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent',
});
const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { RichContent, useContentEdits } = require(output);
const root = createRoot(document.getElementById('root'));
let saved;
let reload;

function Editor({ source }) {
  const [page, setPage] = React.useState(() => parsePage(source));
  const pageStateRef = React.useRef({ pageState: page });
  pageStateRef.current = { pageState: page };
  reload = (source) => setPage(parsePage(source));
  const { setNodeInline } = useContentEdits(
    { pageStateRef },
    {
      commitEdit(gesture) {
        const model = gesture.apply(page.model);
        saved = serializePage(model);
        setPage({ ...page, model });
        return true;
      },
    },
  );
  const node = page.model.nodes[0];
  return React.createElement(RichContent, {
    nodes: node.children,
    onChange: (children) => setNodeInline(node.id, children),
  });
}

function caret(node, offset) {
  const selection = window.getSelection();
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

async function backspace(field) {
  const selection = window.getSelection();
  const text = selection.anchorNode;
  const offset = selection.anchorOffset;
  assert.equal(text.nodeType, 3, 'Backspace still targets the original text node');
  assert.ok(offset > 0, 'Backspace has not jumped to the beginning');
  await act(async () => {
    text.deleteData(offset - 1, 1);
    caret(text, offset - 1);
    field.dispatchEvent(
      new dom.window.InputEvent('input', {
        bubbles: true,
        inputType: 'deleteContentBackward',
      }),
    );
  });
  await act(async () => reload(saved));
  assert.ok(selection.anchorNode === text, 'the save echo preserves the live text node');
  assert.equal(selection.anchorOffset, offset - 1, 'the caret stays at the deletion');
}

async function run() {
  const words = "Find hope. Live with purpose. Let's change the world together!";
  const source = `<TypographyHeading>\n${words}\n</TypographyHeading>`;
  await act(async () => root.render(React.createElement(Editor, { source })));
  const field = document.querySelector('.rich-content');
  field.focus();
  assert.equal(field.textContent, ` ${words} `);
  caret(field.firstChild, field.firstChild.length);
  await backspace(field);
  assert.equal(field.textContent, ` ${words}`, 'the deleted trailing space stays deleted');
  for (let index = 0; index < 4; index++) {
    await backspace(field);
  }
  assert.equal(field.textContent, ` ${words.slice(0, -4)}`);
  assert.ok(saved.includes(words.slice(0, -4)), 'the changed words reach the file');

  // A whitespace-only edit inside a sentence must not restore the old spelling either.
  await act(async () => reload('<h1>\nHello world\n</h1>'));
  caret(field.firstChild, ' Hello '.length);
  await backspace(field);
  assert.equal(field.textContent, ' Helloworld ');

  await act(async () => reload('<h1>\nHello <strong>world &amp; friends</strong>\n</h1>'));
  const strong = field.querySelector('strong');
  caret(field.firstChild, field.firstChild.length);
  await backspace(field);
  assert.equal(field.textContent, ' Helloworld & friends');
  assert.ok(field.querySelector('strong') === strong, 'inline formatting survives the save');
  assert.match(saved, /Hello<strong>world &amp; friends<\/strong>/);

  await act(async () => reload('<h1>x</h1>'));
  caret(field.firstChild, 1);
  await backspace(field);
  assert.equal(field.textContent, '', 'deleting the last character empties the field');
  assert.match(saved, /<h1><\/h1>/);

  // External reload/undo still updates a focused field; do not fix this by ignoring sync.
  await act(async () => reload('<h1>Restored externally</h1>'));
  assert.equal(field.textContent, 'Restored externally');
  await act(async () => root.unmount());
  dom.window.close();
  console.log('content-caret: repeated deletion, whitespace saves and external reload passed');
}
run().catch((error) => {
  console.error(error);
  process.exit(1);
});
