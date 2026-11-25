import assert from 'node:assert/strict';
import test from 'node:test';
import { withRenderBaseline } from '../src/features/preview/previewMiddleware';

test('preview embeds the exact server baseline without allowing script breakout', async () => {
  const html = '<html><body><h1>Before</h1><script>window.example = "</script>";</script></body></html>';
  const response = await withRenderBaseline(new Response(html, { headers: { 'content-type': 'text/html', 'content-length': '20' } }));
  const output = await response.text();
  assert.ok(output.startsWith(html));
  const encoded = output.slice(html.length).match(/type="application\/json">(.*)<\/script>/)?.[1];
  assert.ok(encoded);
  assert.equal(encoded.includes('<'), false);
  assert.equal(JSON.parse(encoded), html);
  assert.equal(response.headers.get('content-length'), null);
});

test('preview bounds initial rendering memory', async () => {
  const response = await withRenderBaseline(new Response('x'.repeat(4_000_001)));
  assert.equal(response.status, 413);
});
