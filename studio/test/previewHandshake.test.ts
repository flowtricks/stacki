// Goal: the long-wait message names the handshake step that is missing, and refuses impossible counts.
// Method: one case per step, then the negative space (more loaded frames than exist, fractions).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  handshakeWait,
  HANDSHAKE_LIMITS,
  pagePath,
  parsePreviewError,
  PREVIEW_ERROR_BEACON,
  PREVIEW_ERROR_LIMITS,
  retryOffered,
} from '../src/features/preview/previewHandshake';

test('no address means the grant has not arrived, whatever the frames say', () => {
  assert.deepEqual(handshakeWait({ url: undefined, frames: 0, framesLoaded: 0 }), { kind: 'address' });
});

test('an address with no loaded frame means the page is still loading', () => {
  assert.deepEqual(handshakeWait({ url: 'https://preview.example/', frames: 1, framesLoaded: 0 }), { kind: 'frame' });
});

test('a loaded frame without a ready message means the editor script has not answered', () => {
  assert.deepEqual(handshakeWait({ url: 'https://preview.example/', frames: 1, framesLoaded: 1 }), { kind: 'script' });
});

test('impossible counts are programmer errors', () => {
  assert.throws(() => handshakeWait({ url: 'u', frames: 1, framesLoaded: 2 }), /Assertion failed: no more frames have loaded than exist/);
  assert.throws(() => handshakeWait({ url: 'u', frames: 1.5, framesLoaded: 0 }), /Assertion failed: frame counts are integers/);
});

test('the wait limit is a positive whole number of milliseconds', () => {
  assert.ok(Number.isSafeInteger(HANDSHAKE_LIMITS.slowAfterMs));
  assert.ok(HANDSHAKE_LIMITS.slowAfterMs > 0);
});

test('a frame error report parses to its message, bounded', () => {
  assert.equal(parsePreviewError({ type: 'studio:preview-error', message: 'boom' }), 'boom');
  assert.equal(parsePreviewError({ type: 'studio:preview-error', message: 'x'.repeat(5000) })?.length, PREVIEW_ERROR_LIMITS.messageCharsMax);
});

test('anything else is not a frame error report', () => {
  for (const input of [
    undefined,
    null,
    'x',
    {},
    { type: 'studio:preview-ready' },
    { type: 'studio:preview-error' },
    { type: 'studio:preview-error', message: '' },
    { type: 'studio:preview-error', message: 4 },
  ]) {
    assert.equal(parsePreviewError(input), undefined);
  }
});

test('the beacon is valid script that reports through postMessage with a bounded count', () => {
  assert.doesNotThrow(() => new Function(PREVIEW_ERROR_BEACON));
  assert.ok(PREVIEW_ERROR_BEACON.includes('studio:preview-error'));
  assert.ok(PREVIEW_ERROR_BEACON.includes('n++<5'));
});

test('Retry is offered a bounded number of times and refuses a corrupt count', () => {
  assert.equal(retryOffered(0), true);
  assert.equal(retryOffered(HANDSHAKE_LIMITS.retriesMax - 1), true);
  assert.equal(retryOffered(HANDSHAKE_LIMITS.retriesMax), false);
  assert.throws(() => retryOffered(-1), /Assertion failed: the retry count is a non-negative integer/);
  assert.throws(() => retryOffered(1.5), /Assertion failed: the retry count is a non-negative integer/);
});

test('a hosted frame opened at the entry address is ready for the page the entry leads to', () => {
  // The frame reports the page it ended on ("/about?x=1"), never the entry address it was opened at.
  assert.equal(pagePath('https://preview.example/__studio-entry?token=t&page=%2Fabout%3Fx%3D1'), '/about?x=1');
  assert.equal(pagePath('https://preview.example/__studio-entry?token=t'), '/');
  assert.equal(pagePath('https://preview.example/__studio-entry?token=t&page=%2Fa&mode=interactive'), '/a');
});

test('an entry address cannot name a page off the host, and an ordinary address is its path and query', () => {
  assert.equal(pagePath('https://preview.example/__studio-entry?page=%2F%2Fevil.example'), '/');
  assert.equal(pagePath('https://preview.example/__studio-entry?page=https%3A%2F%2Fevil.example'), '/');
  assert.equal(pagePath('https://preview.example/team?tab=2#avb-design'), '/team?tab=2');
  assert.equal(pagePath('/relative?x=1', 'https://editor.example/studio'), '/relative?x=1');
});
