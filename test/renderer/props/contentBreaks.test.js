// Goal: the Content field never writes a break with nothing after it, however the words after it went, and a break
// typed at the end of inline markup (the last word bold) starts a plain line after the markup.
// Method: the pure trailing-break rule over node shapes (deleted last line, blank text after a break, breaks inside
// the closing markup, blank lines in the middle kept); then the field's own Enter in JSDOM over real markup, the caret
// placed where a person's would be, reading the DOM and the caret after.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test/content-breaks');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'content-breaks.cjs');
buildSync({
  stdin: {
    contents:
      "export { richLineBreak } from './src/features/props/RichContent';\nexport { withoutTrailingBreaks } from './src/features/props/richContentModel';",
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});
const dom = new JSDOM('<!doctype html><div id="host" contenteditable="true"></div>');
global.window = dom.window;
global.document = dom.window.document;
global.Node = dom.window.Node;
const modules = require(output);

const text = (value) => ({ kind: 'text', value });
const br = { kind: 'element', name: 'br', props: {}, children: undefined };
const strong = (...children) => ({ kind: 'element', name: 'strong', props: {}, children });

test('a break with nothing after it is not written, however the last line went', () => {
  const shapes = [
    ['the last line deleted', [text('Lorem'), br, text('Another'), br], [text('Lorem'), br, text('Another')]],
    ['blank text left after the break', [text('Lorem'), br, text('  ')], [text('Lorem')]],
    ['two breaks at the end', [text('Lorem'), br, br], [text('Lorem')]],
    ['inside the closing markup', [text('Plain '), strong(text('words'), br)], [text('Plain '), strong(text('words'))]],
    ['markup left empty', [text('Plain'), br, strong(br)], [text('Plain')]],
  ];
  for (const [what, nodes, expected] of shapes) {
    assert.deepEqual(modules.withoutTrailingBreaks(nodes), expected, what);
  }
});

test('breaks between words are kept, a blank line in the middle included', () => {
  const nodes = [text('One'), br, br, text('Three'), br, strong(text('bold')), text(' end')];
  assert.deepEqual(modules.withoutTrailingBreaks(nodes), nodes);
  assert.deepEqual(modules.withoutTrailingBreaks([]), []);
  assert.deepEqual(modules.withoutTrailingBreaks([text('Only')]), [text('Only')]);
});

test('Enter at the end of a bold last word starts a plain line after the bold', () => {
  const host = document.getElementById('host');
  host.innerHTML = 'Plain <strong>words</strong>';
  const words = host.querySelector('strong').firstChild;
  window.getSelection().collapse(words, words.length);
  modules.richLineBreak(host);
  assert.equal(host.innerHTML, 'Plain <strong>words</strong><br><br data-rich-caret="">');
  const caret = window.getSelection().getRangeAt(0);
  assert.equal(caret.startContainer, host, 'the caret is in the field, not in the bold');
  assert.equal(host.childNodes[caret.startOffset].hasAttribute('data-rich-caret'), true, 'right after the new break');
});

test('Enter at the end of plain words is unchanged', () => {
  const host = document.getElementById('host');
  host.innerHTML = 'Plain words';
  window.getSelection().collapse(host.firstChild, 'Plain words'.length);
  modules.richLineBreak(host);
  assert.equal(host.innerHTML, 'Plain words<br><br data-rich-caret="">');
});
