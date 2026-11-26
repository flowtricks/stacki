// Goal: rich text shown as code carries none of the indent the page nests it at, and viewing or editing it never
// dedents or reflows the file: an unedited view writes the same bytes, an edit keeps every other line's, and the
// whitespace inside <pre> and <textarea> is exact in both directions.
// Method: the block code view (codeIndentView.ts) with the Astro line roles (codeLineRoles.ts), on content indented as
// a Lumos page nests it; and the dialog's HTML view (richTextModel.formatHTML) in JSDOM.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule');

const { openCodeView, editCodeView } = loadRenderer('src/ui/codeIndentView.ts');
const { codeLineClassifier } = loadRenderer('src/ui/codeLineRoles.ts');
const open = (source) => openCodeView(source, { extent: 'block', classify: codeLineClassifier('astro') });

const NESTED = '\n        <p>One</p>\n        <ul>\n          <li>Two</li>\n        </ul>\n        <pre>a\n   b\n</pre>\n      ';

test('the view starts at column 0, keeps nesting and <pre> whitespace, and writes the same bytes back', () => {
  const view = open(NESTED);
  assert.equal(view.text, '<p>One</p>\n<ul>\n\t<li>Two</li>\n</ul>\n<pre>a\n   b\n</pre>');
  assert.equal(editCodeView(view, view.text).source, NESTED);
});

test('an edit and a new line take the indent of the file; the other lines keep their bytes', () => {
  const view = open(NESTED);
  const next = editCodeView(view, view.text.replace('<p>One</p>', '<p>One more</p>\n<p>New</p>'));
  assert.equal(next.source, NESTED.replace('<p>One</p>', '<p>One more</p>\n        <p>New</p>'));
});

test('content that starts on the opening tag’s line is dedented by the lines after it', () => {
  const source = '<p>One</p>\n        <p>Two</p>\n      ';
  const view = open(source);
  assert.equal(view.text, '<p>One</p>\n<p>Two</p>');
  assert.equal(editCodeView(view, view.text).source, source);
});

test('the dialog’s HTML view hangs a paragraph’s further lines under it, and leaves <pre> alone', () => {
  const { window } = new JSDOM('');
  const { formatHTML } = loadRenderer('src/ui/richTextModel.ts');
  const text = formatHTML('<p>\n          Words\n        </p>\n        <pre>a\n   b</pre>', window.document);
  assert.equal(text, '<p>\n\tWords\n</p>\n<pre>a\n   b</pre>');
});

test('what the dialog writes carries none of the HTML view’s layout whitespace', () => {
  const { window } = new JSDOM('');
  const { richTextNodes, withoutLayoutSpace } = loadRenderer('src/features/props/richTextContent.ts');
  const write = (html) => JSON.stringify(withoutLayoutSpace(richTextNodes(html, window.document)));
  const plain = JSON.stringify(richTextNodes('<p>More <b>a</b> <i>b</i> text</p><ul><li>One</li></ul><pre>a\n   b</pre>', window.document));
  assert.equal(write('<p>\n\tMore <b>a</b>\n\t<i>b</i> text\n</p>\n<ul>\n\t<li>One</li>\n</ul>\n<pre>a\n   b</pre>'), plain);
});

test('an expression of several lines loses the indent its later lines are nested at, and keeps its bytes', () => {
  const source = 'Math.min(\n          40,\n          60,\n        )';
  const view = openCodeView(source, { extent: 'block', classify: codeLineClassifier('typescript') });
  assert.equal(view.text, 'Math.min(\n\t40,\n\t60,\n)');
  assert.equal(editCodeView(view, view.text).source, source);
  assert.equal(editCodeView(view, view.text.replace('60', '70')).source, source.replace('60', '70'));
});
