// Goal: Studio's page frame sends the device keys 1 to 9 to the editor from select mode, interact
// mode and the preview mode alike, as Desktop's frame does (frameDesign.ts), once per press; a
// digit typed into a field of the site, a modified digit and a non-device key stay in the page;
// and the editor replays a device key from the preview mode on its window, where the canvas's
// device listener (usePreviewSizing) reads it, while any other key from that frame is refused.
// Method: forwardPreviewKeys and receivePreviewDeviceKey (src/features/preview/previewKeys.ts)
// over plain EventTargets standing in for the frame's window and document, with an Element class
// for the field check. Each press is a keydown Event carrying the KeyboardEvent fields the
// listeners read; the posted messages and the replayed keys are recorded and compared.
import assert from 'node:assert/strict';
import { test } from 'node:test';

class FakeElement extends EventTarget {
  constructor(private readonly field: boolean) {
    super();
  }
  closest(selector: string): FakeElement | null {
    // Only the field selector matters here: the live-cursor layer never exists in this test.
    return this.field && selector.includes('input') ? this : null;
  }
}

interface Press {
  readonly key: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly target?: FakeElement;
}

const frameWindow = new EventTarget();
const frameDocument = new EventTarget();
const replayed: string[] = [];
class FakeKeyboardEvent extends Event {
  readonly key: string;
  constructor(type: string, init: { readonly key: string }) {
    super(type, { cancelable: true });
    this.key = init.key;
  }
}
Object.assign(globalThis, { window: frameWindow, document: frameDocument, Element: FakeElement, KeyboardEvent: FakeKeyboardEvent });

function isKeyMessage(message: unknown): message is { readonly key: string } {
  return typeof message === 'object' && message !== null && 'key' in message && typeof message.key === 'string';
}

function press(press: Press): void {
  const event = new Event('keydown', { cancelable: true, bubbles: true });
  const target = press.target ?? new FakeElement(false);
  Object.defineProperties(event, {
    key: { value: press.key },
    code: { value: '' },
    metaKey: { value: press.metaKey === true },
    ctrlKey: { value: press.ctrlKey === true },
    altKey: { value: press.altKey === true },
    shiftKey: { value: false },
    isComposing: { value: false },
    target: { value: target },
  });
  frameWindow.dispatchEvent(event);
  frameDocument.dispatchEvent(event);
}

test('the frame sends each device key once, in every mode, and keeps fields and modified digits', async () => {
  const { forwardPreviewKeys } = await import('../src/features/preview/previewKeys');
  const posted: unknown[] = [];
  let interactive = true;
  forwardPreviewKeys(
    (message) => posted.push(message),
    () => interactive,
  );
  const deviceKeys = (): readonly string[] => posted.flatMap((message) => (isKeyMessage(message) ? [message.key] : []));
  posted.filter((message) => typeof message === 'object' && message !== null && 'key' in message).map((message) => (message as { key: string }).key);
  for (const key of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) {
    press({ key });
  }
  assert.deepEqual(deviceKeys(), ['1', '2', '3', '4', '5', '6', '7', '8', '9'], 'the preview mode and interact mode send every device key');
  interactive = false;
  press({ key: '3' });
  assert.deepEqual(deviceKeys().slice(9), ['3'], 'select mode sends a device key once, not twice');
  press({ key: '4', target: new FakeElement(true) });
  assert.equal(deviceKeys().length, 10, 'a digit typed in a field stays there');
  press({ key: '4', metaKey: true });
  press({ key: '4', ctrlKey: true });
  press({ key: '4', altKey: true });
  assert.equal(deviceKeys().length, 10, 'a modified digit is not a device key');
  interactive = true;
  press({ key: '0' });
  press({ key: 'z' });
  assert.equal(deviceKeys().length, 10, 'a key that is not a device key stays in the preview');
});

test('the editor replays a device key from the preview mode and refuses any other key', async () => {
  const { receivePreviewDeviceKey } = await import('../src/features/preview/previewKeys');
  const listener = (event: Event): void => {
    assert.ok(event instanceof FakeKeyboardEvent, 'the replay is a keyboard event');
    replayed.push(event.key);
  };
  frameWindow.addEventListener('keydown', listener);
  receivePreviewDeviceKey({ type: 'studio:key', key: '3' });
  assert.deepEqual(replayed, ['3'], 'a device key is replayed on the window');
  receivePreviewDeviceKey({ type: 'studio:key', key: 'Backspace' });
  receivePreviewDeviceKey({ type: 'studio:key', key: '0' });
  receivePreviewDeviceKey({ type: 'studio:key', key: '10' });
  receivePreviewDeviceKey({ type: 'studio:key', key: 3 });
  assert.deepEqual(replayed, ['3'], 'no other key is replayed from the preview mode');
  frameWindow.removeEventListener('keydown', listener);
});
