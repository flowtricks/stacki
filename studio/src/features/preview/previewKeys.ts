import { record } from '../../shared/validation';
import { isReservedShortcut, shortcutOfPress } from '../../../vendor/stacki/shared/properties/appShortcuts';
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
  // The Navigator's arrows: ↑ parent, ↓ first child, ← → siblings (navigatorArrows.ts).
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
]);
const ARROWS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
export function forwardPreviewKeys(post: (message: unknown) => void, interactive: () => boolean) {
  // The app command range (APP_RESERVED_SHORTCUTS, ⌘⌥⇧1 to 9), as Desktop's canvas forwards it
  // (frameDesign.ts forwardShortcut): the editor's own listener (AppsHost.tsx) never sees a key
  // pressed in here, so an app's command would not run while the canvas has focus. Forwarded in
  // both canvas modes and from fields, as Desktop does: no Stacki shortcut or typed text uses it.
  // The message is Desktop's, so one parser (previewMessages.ts) reads it in both editors.
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.isComposing) {
        return;
      }
      const shortcut = shortcutOfPress(event);
      if (shortcut === undefined) {
        return;
      }
      if (isReservedShortcut(shortcut)) {
        event.preventDefault();
        post({ type: 'avb:shortcut', name: 'appCommand', shortcut });
      }
    },
    true,
  );
  // Arrow keys, as Desktop's canvas forwards them (frameDesign.ts forwardShortcut): a click on
  // the canvas puts keyboard focus in here, so without this they scroll the page instead of
  // moving the selection. Caught on the way down, before the page's own handlers, and in both
  // canvas modes, so a page carousel in interact mode does not take them either. A field in the
  // page, or the canvas's own text editor, keeps them for its caret.
  window.addEventListener(
    'keydown',
    (event) => {
      if (!ARROWS.has(event.key)) {
        return;
      }
      if (interactive() || event.isComposing) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
        return;
      }
      if (keyInField(event.target)) {
        return;
      }
      event.preventDefault();
      post({ type: 'studio:key', key: event.key, ctrlKey: false, metaKey: false, shiftKey: false });
    },
    true,
  );
  document.addEventListener('keydown', (event) => {
    if (ARROWS.has(event.key)) {
      return; // Forwarded above.
    }
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

// A field in the page, or the canvas's text editor (contenteditable), types with the key.
function keyInField(target: EventTarget | null): boolean {
  if (target instanceof Element) {
    if (target.closest('#studio-live-cursors')) {
      return true;
    }
    return target.closest('input, textarea, select, [contenteditable=true], [contenteditable=""], [contenteditable=plaintext-only]') !== null;
  }
  return false;
}
