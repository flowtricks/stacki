// Goal: defaults may morph only a same-origin page. Methodology: exercise entry,
// exit, normal navigation, malformed messages, unsafe origins and URL bounds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePreviewRoute, defaultsPreviewTransition } from '#dist/shared/properties/previewRoute.js';
const page = 'http://localhost:4321/about';
const defaults = 'http://localhost:4321/__avb/preview?defaults=12345678-1234-1234-1234-123456789abc';
test('defaults preview source switches without ordinary navigation', () => {
  const message = { type: 'avb:preview-route', url: defaults };
  assert.equal(defaultsPreviewTransition(page, defaults), true);
  assert.equal(parsePreviewRoute(message, page), new URL(defaults).pathname + new URL(defaults).search + '#avb-design');
  assert.equal(parsePreviewRoute({ ...message, url: page }, defaults), '/about#avb-design');
  assert.equal(parsePreviewRoute({ ...message, url: page + '/next' }, page), undefined);
  assert.equal(parsePreviewRoute({ ...message, url: defaults.replace('localhost', 'example.com') }, page), undefined);
  assert.equal(parsePreviewRoute({ ...message, url: 'javascript:alert(1)' }, defaults), undefined);
  assert.equal(parsePreviewRoute({ ...message, url: 'x'.repeat(4097) }, defaults), undefined);
  for (const value of [undefined, {}, [], { type: 'other', url: defaults }, { ...message, url: 1 }]) {
    assert.equal(parsePreviewRoute(value, page), undefined);
  }
});
