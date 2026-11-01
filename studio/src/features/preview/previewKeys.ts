import { record } from '../../shared/validation';
const keys = new Set([
  'z',
  'y',
  'c',
  'd',
  'v',
  'f',
  'e',
  // ⇧G shows or hides the column guide (guideSettings.ts).
  'g',
  'backspace',
  'delete',
  '1',
  '2',
  '3',
  '4',
  'escape',
  'enter',
]);
export function forwardPreviewKeys(post: (message: unknown) => void, interactive: () => boolean) {
  document.addEventListener('keydown', (event) => {
    const insert = (event.metaKey || event.ctrlKey) && ['f', 'e'].includes(event.key.toLowerCase());
    if (
      event.defaultPrevented ||
      event.isComposing ||
      (event.target instanceof Element && event.target.closest('#studio-live-cursors')) ||
      interactive() ||
      !keys.has(event.key.toLowerCase()) ||
      (['f', 'e'].includes(event.key.toLowerCase()) && !insert) ||
      event.altKey ||
      (!insert && event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable=true], [contenteditable=plaintext-only]'))
    ) {
      return;
    }
    event.preventDefault();
    post({
      type: 'studio:key',
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
    });
  });
}
export function receivePreviewKey(input: unknown) {
  const value = record(input);
  if (typeof value['key'] !== 'string' || !keys.has(value['key'].toLowerCase())) {
    return;
  }
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: value['key'],
      ctrlKey: value['ctrlKey'] === true,
      metaKey: value['metaKey'] === true,
      shiftKey: value['shiftKey'] === true,
      cancelable: true,
    }),
  );
}
