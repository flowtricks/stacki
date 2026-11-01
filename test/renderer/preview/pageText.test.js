// Read real head markup and validate the metadata reply boundary. Exercise missing,
// empty, malformed and oversized values so placeholders never trust iframe data.
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule.js');
const { renderedPageText } = loadRenderer('electron/preload/framePageText.ts');
const { parsePageText } = loadRenderer('shared/properties/pageText.ts');
const { BOUNDARY_LIMITS } = loadRenderer('shared/core/boundary.ts');
const { parseCanvasReply } = loadRenderer('src/editor/canvasReply.ts');
const dom = new JSDOM('<!doctype html><head></head>');
const document = dom.window.document;
assert.deepEqual(renderedPageText(document), {});
document.head.innerHTML = `
  <title>Temporary tab message</title>
  <meta property="og:title" content="The Church International">
  <meta name="description" content="Find hope &amp; purpose.">
  <meta property="og:description" content="Social description">
`;
const expected = { title: 'The Church International', description: 'Find hope & purpose.' };
assert.deepEqual(renderedPageText(document), expected);
const reply = parseCanvasReply({ id: 1, found: true, pageText: expected });
assert.equal(reply.ok, true);
assert.deepEqual(reply.value.pageText, expected);
document.querySelector('[property="og:title"]').remove();
document.querySelector('[name="description"]').remove();
assert.deepEqual(renderedPageText(document), {
  title: 'Temporary tab message',
  description: 'Social description',
});
document.querySelector('title').textContent = '';
document.querySelector('[property="og:description"]').setAttribute('content', '');
assert.deepEqual(renderedPageText(document), { title: '', description: '' });
const atLimit = 'a'.repeat(BOUNDARY_LIMITS.textLengthMax);
assert.equal(parsePageText({ title: atLimit }).title, atLimit);
const oversized = atLimit + 'a';
document.querySelector('title').textContent = oversized;
document.querySelector('[property="og:description"]').setAttribute('content', oversized);
assert.deepEqual(renderedPageText(document), {});
for (const invalid of [42, [], JSON.parse('null'), { title: 42 }, { description: {} }, { title: oversized }, { description: oversized }]) {
  assert.throws(() => parsePageText(invalid));
  assert.equal(parseCanvasReply({ id: 1, found: true, pageText: invalid }).ok, false);
}
dom.window.close();
console.log('page-text: rendered metadata and bounded reply validation passed');
