// Goal: disconnecting the preview must not send on a closed Vite transport.
// Method: drive its real variant controller through disconnect, offline selection,
// and reconnection with a transport that rejects every send while disconnected.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVariantPreview } from '../src/features/preview/variantClient';

test('variant cleanup stays local while the preview connection is unavailable', () => {
  const listeners = new Map<string, ((data: unknown) => void)[]>();
  const sent: string[] = [];
  let connected = true;
  const preview = createVariantPreview({
    on: (event, callback) => {
      const callbacks = listeners.get(event) ?? [];
      callbacks.push(callback);
      listeners.set(event, callbacks);
    },
    send: (event) => {
      assert.ok(connected, 'Cannot send to a disconnected preview');
      sent.push(event);
    },
  });
  preview.receive({ action: 'reset' });
  assert.deepEqual(sent, ['studio:variants-cancel']);
  connected = false;
  for (const listener of listeners.get('vite:ws:disconnect') ?? []) {
    listener(undefined);
  }
  preview.receive({ action: 'reset' });
  preview.receive({ action: 'prepare', prop: 'variant', values: ['a', 'b'] });
  assert.equal(sent.length, 1, 'Offline selection does not enqueue obsolete variant work');
  connected = true;
  for (const listener of listeners.get('vite:ws:connect') ?? []) {
    listener(undefined);
  }
  preview.receive({ action: 'reset' });
  assert.equal(sent.length, 2, 'Variant requests resume on the recovered connection');
});
