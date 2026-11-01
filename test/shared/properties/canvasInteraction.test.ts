// Goal: frame modes and navigation remain bounded, validated messages.
// Method: accept both modes and local paths; reject foreign types and unsafe path shapes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCanvasInteraction, parseCanvasNavigation } from '#dist/shared/properties/canvasInteraction.js';

test('canvas modes reject malformed messages', () => {
  for (const mode of ['select', 'interact']) {
    assert.equal(parseCanvasInteraction({ type: 'avb:interaction', mode }), mode);
  }
  for (const value of [
    undefined,
    true,
    {},
    { type: 'avb:interaction', mode: true },
    { type: 'other', mode: 'select' },
    { type: 'avb:interaction', mode: 'preview' },
  ]) {
    assert.equal(parseCanvasInteraction(value), undefined);
  }
});

test('navigation allows local routes and rejects malformed or oversized paths', () => {
  for (const path of ['/', '/campuses', '/about/?query=value#heading']) {
    assert.equal(parseCanvasNavigation({ type: 'avb:navigated', path }), path);
  }
  for (const path of [undefined, 3, '', 'https://evil.test', '//evil.test', '/\\evil.test', '/with space', '/\nunsafe', '/' + 'a'.repeat(4000)]) {
    assert.equal(parseCanvasNavigation({ type: 'avb:navigated', path }), undefined);
  }
});
