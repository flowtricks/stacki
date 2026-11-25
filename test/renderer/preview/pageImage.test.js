// Read real head markup in JSDOM and validate the cross-frame image contract.
// CMS URLs stay remote; canonical-origin images resolve to project assets, and
// malformed or unbounded metadata never becomes a thumbnail source.
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule.js');
const { renderedPageImage, renderedPageType } = loadRenderer('electron/preload/framePageMetadata.ts');
const { parsePageImage, parsePageType } = loadRenderer('shared/properties/pageMetadata.ts');
const { parseCanvasReply } = loadRenderer('src/editor/canvasReply.ts');
const dom = new JSDOM('<!doctype html><head></head>', { url: 'http://localhost:4321/about' });
const document = dom.window.document;
const canonical = document.createElement('link');
canonical.rel = 'canonical';
canonical.href = 'https://example.com/about';
document.head.append(canonical);
const image = document.createElement('meta');
image.setAttribute('property', 'og:image');
document.head.append(image);
for (const [source, expected] of [
  ['https://example.com/src/assets/social-share.jpg', '/src/assets/social-share.jpg'],
  ['/og-image.jpg', '/og-image.jpg'],
  ['./social.jpg', '/social.jpg'],
  ['http://localhost:4321/src/assets/share.jpg?v=2', '/src/assets/share.jpg?v=2'],
  ['https://cdn.example.com/image.jpg?w=1200', 'https://cdn.example.com/image.jpg?w=1200'],
  ['//cdn.example.com/image.jpg', 'http://cdn.example.com/image.jpg'],
  ['', undefined],
  ['javascript:alert(1)', undefined],
  ['file:///private/image.jpg', undefined],
  ['https://user:secret@example.com/image.jpg', undefined],
  ['/' + 'a'.repeat(32769), undefined],
]) {
  image.content = source;
  assert.equal(renderedPageImage(document), expected, source.slice(0, 100));
}
image.remove();
image.setAttribute('name', 'twitter:image');
image.removeAttribute('property');
image.content = '/twitter.jpg';
document.head.append(image);
assert.equal(renderedPageImage(document), '/twitter.jpg');
image.remove();
assert.equal(renderedPageImage(document), undefined);
for (const invalid of [
  undefined,
  42,
  {},
  JSON.parse('null'),
  '',
  '/bad\0image.jpg',
  '/\\example.com/image.jpg',
  'javascript:alert(1)',
  'file:///private/image.jpg',
  'https://user:secret@example.com/image.jpg',
  '/' + 'a'.repeat(32769),
]) {
  assert.throws(() => parsePageImage(invalid));
  if (invalid !== undefined) {
    assert.equal(parseCanvasReply({ id: 1, found: true, pageImage: invalid }).ok, false);
  }
}
for (const valid of ['/og-image.jpg', 'https://cdn.example.com/image.jpg']) {
  assert.equal(parsePageImage(valid), valid);
  const reply = parseCanvasReply({ id: 1, found: true, pageImage: valid });
  assert.equal(reply.ok, true);
  assert.equal(reply.value.pageImage, valid);
}
dom.window.close();
const typePage = new JSDOM('<meta property="og:type" content="website">');
assert.equal(renderedPageType(typePage.window.document), 'website');
assert.equal(parsePageType('article'), 'article');
for (const invalid of [42, '', 'not a type', 'a'.repeat(129), JSON.parse('null')]) {
  assert.throws(() => parsePageType(invalid));
  assert.equal(parseCanvasReply({ id: 1, found: true, pageType: invalid }).ok, false);
}
typePage.window.close();
console.log('page-image: rendered metadata and cross-frame validation passed');
