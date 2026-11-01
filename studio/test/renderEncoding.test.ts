// Goal: compression stays lossless and does not monopolize the collaboration loop.
// Method: round-trip Unicode markup and reject invalid or oversized wire payloads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { encodeRenderedHTML } from '../src/features/preview/renderEncoding';
import { decodeRenderedHTML } from '../src/features/preview/renderDecoding';

test('full page render compression preserves Unicode and complete markup', async () => {
  const html = '<main>' + '<section><h2>Hello 🌍</h2><p>Content &amp; text</p></section>'.repeat(3000) + '</main>';
  const encoded = await encodeRenderedHTML(html);
  assert.ok('htmlGzip' in encoded);
  assert.ok(encoded.htmlGzip.length < html.length / 10);
  assert.equal(await decodeRenderedHTML(encoded), html);
  assert.deepEqual(await encodeRenderedHTML('<h1>Small</h1>'), { html: '<h1>Small</h1>' });
  assert.equal(await decodeRenderedHTML({ html: 'Old server' }), 'Old server');
});
test('invalid compressed messages and expanded HTML above the limit are rejected', async () => {
  assert.equal(await decodeRenderedHTML({ htmlGzip: 'not!base64' }), undefined);
  await assert.rejects(decodeRenderedHTML({ htmlGzip: 'YWJj' }));
  await assert.rejects(decodeRenderedHTML({ htmlGzip: gzipSync('x'.repeat(4_000_001)).toString('base64') }), /size limit/);
});
