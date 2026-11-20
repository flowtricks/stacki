// Goal: the long-wait message names the handshake step that is missing, and refuses impossible counts.
// Method: one case per step, then the negative space (more loaded frames than exist, fractions).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handshakeWait, HANDSHAKE_LIMITS, parsePreviewError, PREVIEW_ERROR_BEACON, PREVIEW_ERROR_LIMITS } from '../src/features/preview/previewHandshake';

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
