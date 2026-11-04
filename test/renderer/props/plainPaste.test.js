// Goal: pasting into the Content box brings in the text and nothing else: no
// fonts, sizes or markup from where it was copied. Line breaks stay, as the
// <br> the field writes for Enter; anything that looks like markup is text.
// Method: the conversion the paste handler inserts.
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { plainPasteHTML } = load('src/features/props/RichContent.tsx');

const literal = (html) => `<span data-rich-literal="">${html}</span>`;
assert.equal(plainPasteHTML('Built for developers'), literal('Built for developers'));
assert.equal(plainPasteHTML('one\ntwo\r\nthree\rfour'), literal('one<br>two<br>three<br>four'));
assert.equal(plainPasteHTML('<b>bold</b> & <script>x</script>'), literal('&lt;b&gt;bold&lt;/b&gt; &amp; &lt;script&gt;x&lt;/script&gt;'));
assert.equal(plainPasteHTML(''), '');
console.log('plain paste: ok');
