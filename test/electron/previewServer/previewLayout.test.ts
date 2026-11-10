// Goal: the preview route has an explicit layout mode that defaults to the popup's.
// Methodology: pin the mode parser on the exact word, an unknown word and non-strings, then read the
// generated page to see that the mode reaches the head, that the page layout branch exists, and
// that the popup fit is still in it untouched.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { componentPreviewLayout, renderComponentPreviewPage } from '#dist/electron/previewServer/componentPreview.js';

test('only the exact word page selects the page layout', () => {
  assert.equal(componentPreviewLayout('page'), 'page');
  for (const value of ['popup', '', 'PAGE', 'page ', 'full', undefined, 7, {}, []]) {
    assert.equal(componentPreviewLayout(value), 'popup');
  }
  const jsonNull: unknown = JSON.parse('null');
  assert.equal(componentPreviewLayout(jsonNull), 'popup');
});

test('the generated page reads the mode, marks the head, and keeps the popup fit', () => {
  const page = renderComponentPreviewPage();
  assert.ok(page.includes("Astro.url.searchParams.get('layout')"));
  assert.ok(page.includes('function componentPreviewLayout'), 'the parser is emitted into the page');
  assert.ok(page.includes('<meta name="avb-layout" content={layout} />'));
  assert.ok(page.includes("=== 'page'"));
  assert.ok(page.includes('Math.min(1, aw / box.w, ah / box.h)'), 'the popup fit is unchanged');
  assert.ok(page.includes('width: 1200px'), 'the popup stage keeps its width');
  assert.ok(page.includes('unfix();') && page.includes("reportStatus('empty', ") && page.includes("reportStatus('ready')"));
});
