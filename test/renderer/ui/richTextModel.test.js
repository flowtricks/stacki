// Goal: the rich text editor's rules hold without a live editor — the Markdown
// typed at a line's start or around a word, the keys that run its actions, what
// a paste keeps, the addresses a typed link accepts, and the HTML view's layout.
// Method: the pure model and the key map are bundled and called directly over
// known-good and known-bad input; paste cleaning and formatting run in a JSDOM
// document. Text that only looks like a shortcut must stay text.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/rich-text-model.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
buildSync({
  stdin: {
    contents: `export * from './src/ui/richTextModel';
      export { shortcutAction } from './src/ui/richTextCommands';`,
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
});
const rich = require(output);
const { document } = new JSDOM('<!doctype html>').window;

test('a line prefix and a space become a block; other text stays text', () => {
  assert.deepEqual(rich.blockShortcut('# '), { kind: 'block', block: 'h1' });
  assert.deepEqual(rich.blockShortcut('### '), { kind: 'block', block: 'h3' });
  assert.deepEqual(rich.blockShortcut('###### '), { kind: 'block', block: 'h6' });
  assert.deepEqual(rich.blockShortcut('> '), { kind: 'block', block: 'blockquote' });
  assert.deepEqual(rich.blockShortcut('``` '), { kind: 'block', block: 'pre' });
  assert.deepEqual(rich.blockShortcut('- '), { kind: 'list', list: 'ul' });
  assert.deepEqual(rich.blockShortcut('1. '), { kind: 'list', list: 'ol' });
  assert.deepEqual(rich.blockShortcut('---'), { kind: 'rule' });
  for (const text of ['#', '####### ', 'Hello ', '2. ', 'a - ', '--', '- -', 'toString ']) {
    assert.equal(rich.blockShortcut(text), undefined, text);
  }
});

test('a closed inline run becomes its element, measured from the caret', () => {
  assert.deepEqual(rich.inlineShortcut('say **hi**'), { tag: 'strong', length: 6, text: 'hi' });
  assert.deepEqual(rich.inlineShortcut('say *hi*'), { tag: 'em', length: 4, text: 'hi' });
  assert.deepEqual(rich.inlineShortcut('_hi there_'), { tag: 'em', length: 10, text: 'hi there' });
  assert.deepEqual(rich.inlineShortcut('use `npm i`'), { tag: 'code', length: 7, text: 'npm i' });
  assert.deepEqual(rich.inlineShortcut('~~old~~'), { tag: 's', length: 7, text: 'old' });
  // Spaces inside the markers, a lone marker, or a word joined to it: not a run.
  for (const text of ['** hi**', '* hi *', 'a*b', '2 * 3 *', 'snake_case_', '****']) {
    assert.equal(rich.inlineShortcut(text), undefined, text);
  }
});

test('the keys the browser does not handle map to actions', () => {
  const press = (key, code, extra = {}) => ({
    key,
    code,
    mod: true,
    shift: false,
    alt: false,
    ...extra,
  });
  assert.deepEqual(rich.shortcutAction(press('k', 'KeyK')), { kind: 'link' });
  assert.deepEqual(rich.shortcutAction(press('e', 'KeyE')), { kind: 'mark', mark: 'code' });
  assert.deepEqual(rich.shortcutAction(press('x', 'KeyX', { shift: true })), {
    kind: 'mark',
    mark: 'strike',
  });
  assert.deepEqual(rich.shortcutAction(press('&', 'Digit7', { shift: true })), {
    kind: 'list',
    list: 'ol',
  });
  assert.deepEqual(rich.shortcutAction(press('º', 'Digit0', { alt: true })), {
    kind: 'block',
    block: 'p',
  });
  assert.deepEqual(rich.shortcutAction(press('™', 'Digit6', { alt: true })), {
    kind: 'block',
    block: 'h6',
  });
  assert.equal(rich.shortcutAction(press('b', 'KeyB')), undefined, 'bold is the browser’s');
  assert.equal(rich.shortcutAction(press('ª', 'Digit9', { alt: true })), undefined);
  assert.equal(rich.shortcutAction({ ...press('k', 'KeyK'), mod: false }), undefined);
});

test('a paste keeps structure and safe links, and nothing that styles or acts', () => {
  const pasted = [
    '<meta charset="utf-8"><style>p{color:red}</style>',
    '<h1 style="color:red">Title</h1><div class="x"><b>Bold</b> and <i>it</i></div>',
    '<ul><li><span style="font-weight:700">One</span></li></ul>',
    '<a href="https://example.com" onclick="x()">site</a><a href="javascript:alert(1)">bad</a>',
    '<script>alert(1)</script><p></p><h6>Small</h6>',
  ].join('');
  assert.equal(
    rich.cleanPastedHTML(pasted, document),
    '<h1>Title</h1><p><strong>Bold</strong> and <em>it</em></p><ul><li>One</li></ul>' + '<a href="https://example.com">site</a>bad<h6>Small</h6>',
  );
  assert.throws(() => rich.cleanPastedHTML('x'.repeat(10_000_001), document), /paste limit exceeded/);
});

test('a typed link is a safe address, an email, or a bare domain', () => {
  assert.equal(rich.linkAddress(' https://a.com/x '), 'https://a.com/x');
  assert.equal(rich.linkAddress('/about'), '/about');
  assert.equal(rich.linkAddress('example.com/about?x=1'), 'https://example.com/about?x=1');
  assert.equal(rich.linkAddress('hello@example.com'), 'mailto:hello@example.com');
  for (const text of ['', 'javascript:alert(1)', 'hello world', 'example', 'a.b']) {
    assert.equal(rich.linkAddress(text), undefined, text);
  }
});

test('the HTML view puts blocks on their own lines and indents nested ones', () => {
  const html =
    '<p>One <strong>two</strong></p><ul><li>A<ul><li>B</li></ul></li><li>C</li></ul>' + '<pre>keep\n  this</pre>\n\n<blockquote><p>Q</p></blockquote>';
  assert.equal(
    rich.formatHTML(html, document),
    [
      '<p>One <strong>two</strong></p>',
      '<ul>',
      '  <li>',
      '    A',
      '    <ul>',
      '      <li>B</li>',
      '    </ul>',
      '  </li>',
      '  <li>C</li>',
      '</ul>',
      '<pre>keep\n  this</pre>',
      '<blockquote>',
      '  <p>Q</p>',
      '</blockquote>',
    ].join('\n'),
  );
  // Laid out again, it is unchanged.
  const once = rich.formatHTML(html, document);
  assert.equal(rich.formatHTML(once, document), once);
});

test('counts read words and characters, ignoring spacing', () => {
  assert.deepEqual(rich.textCounts('  '), { words: 0, characters: 0 });
  assert.deepEqual(rich.textCounts('Hello  big\nworld'), { words: 3, characters: 13 });
});
