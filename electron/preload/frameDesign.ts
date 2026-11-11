import { isCanvasTextEditing } from './frameTextNative';
import { canvasCursorCSS, canvasInert, canvasSelects, guardCanvasNavigation, trackCanvasGesture } from './frameInteraction';
// Which frame this is, and what that changes. A class on <html> says canvas
// (`stacki-designer`) or interactive preview (`stacki-preview`); a design-mode
// frame (#avb-design) also gets an editor cursor, inert links and forms, and
// passes the editor's own shortcuts to the app.

// Marks <html> with the frame's mode, now and at the first two moments a frame
// that is still being created certainly has one.
export function markFrameMode(): void {
  // Which frame the page is in, as a class on <html>, so a project can style
  // for the editor: `stacki-designer` in the canvas, `stacki-preview` in the
  // interactive preview. Read from the frame's own URL rather than waited for
  // over a message — the page paints before the app can say anything, and a
  // canvas that started out looking like the preview would flash.
  //
  // The patcher leaves it alone: it applies the classes the SERVER's two
  // renderings disagree about, and neither of them has ever heard of these.
  const stackiMode = location.hash.includes('avb-design') ? 'stacki-designer' : 'stacki-preview';
  const markMode = () => document.documentElement?.classList.add(stackiMode);
  // <html> exists by the time a preload runs, but not always in a frame that
  // is still being created — so try again at the first two moments it
  // certainly does.
  markMode();
  document.addEventListener('readystatechange', markMode);
  window.addEventListener('DOMContentLoaded', markMode);
}

// Design-mode frames (canvas + editor preview) are marked with #avb-design.
// They get an editor cursor (no I-beam over text) and links/forms are
// inert — navigation only happens in the canvas's interact mode and the
// interactive preview.
export function listenForDesign(): void {
  trackCanvasGesture();
  guardCanvasNavigation();
  announceLeaving();
  showDesignCursor();
  makeNavigationInert();
  forwardModifiers();
  window.addEventListener('keydown', forwardShortcut, true);
}

// Said as the document goes, whatever takes it away: the host clears outlines
// drawn for it and checks that what loads next is still the site (useCanvasInteraction).
function announceLeaving(): void {
  window.addEventListener('pagehide', () => {
    try {
      window.parent.postMessage({ type: 'avb:leaving' }, '*');
    } catch {
      /* no parent to tell */
    }
  });
}

function showDesignCursor(): void {
  const injectDesignStyle = () => {
    if (document.getElementById('avb-design-style')) {
      return;
    }
    const style = document.createElement('style');
    style.id = 'avb-design-style';
    style.disabled = !canvasSelects();
    style.textContent = canvasCursorCSS();
    (document.head || document.documentElement)?.appendChild(style);
  };
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', injectDesignStyle);
  } else {
    injectDesignStyle();
  }
}

function makeNavigationInert(): void {
  // Block navigation and submits at capture so page handlers never fire.
  window.addEventListener(
    'click',
    (event) => {
      if (!canvasInert()) {
        return;
      }
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : undefined;
      if (anchor) {
        event.preventDefault();
      }
    },
    true,
  );
  window.addEventListener(
    'submit',
    (event) => {
      if (canvasInert()) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );
  // A press on the canvas is a selection, not an interaction — and left to
  // the browser, a press focuses whatever is under the pointer. Focusing
  // something REVEALS it: the page scrolls to bring it into view, sideways
  // as well as down.
  //
  // A card in a slider is covered by a full-bleed link and half of them sit
  // past the right edge, so selecting one scrolled the canvas across. The
  // page it came from is 3399px wide against a 1280px frame, so there is a
  // long way to travel and nothing on screen to say what happened: the site
  // simply looks as though it has slipped off to the left.
  //
  // The frame still takes focus itself — that is what carries the modifiers
  // (forwardModifiers), and what a page's own keyboard handlers listen from. It is the
  // ELEMENT focus, and the scroll that comes with it, that goes.
  window.addEventListener(
    'mousedown',
    (event) => {
      if (!canvasInert()) {
        return; // Interact mode: a press focuses a field, opens a <select>, starts a drag.
      }
      if (isCanvasTextEditing(event.target)) {
        return;
      }
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      window.focus();
    },
    true,
  );
}

function forwardModifiers(): void {
  // Which modifiers are held, forwarded for the same reason as the shortcuts
  // below: clicking an element on the canvas puts keyboard focus in here, so
  // every key after that is delivered to this frame and never reaches the
  // app. The style panel reads Shift and Option to decide how much of the
  // spacing box a hover or a drag applies to — and from the app's side,
  // nobody was pressing anything.
  let held = { shiftKey: false, altKey: false };
  const tellModifiers = (event: { shiftKey: boolean; altKey: boolean }) => {
    const next = { shiftKey: !!event.shiftKey, altKey: !!event.altKey };
    if (next.shiftKey === held.shiftKey && next.altKey === held.altKey) {
      return;
    }
    held = next;
    try {
      window.parent.postMessage({ type: 'avb:modifiers', ...held }, '*');
    } catch {
      /* no parent to tell */
    }
  };
  // Any key event, not just the modifiers themselves — see the style panel's
  // hover hook: what matters is the state now, so a keyup missed while this
  // frame was out of focus is corrected by whatever happens next.
  window.addEventListener('keydown', tellModifiers, true);
  window.addEventListener('keyup', tellModifiers, true);
  // Nothing is held once the page stops receiving keys.
  window.addEventListener('blur', () => tellModifiers({ shiftKey: false, altKey: false }));
}

// Forward app shortcuts when the canvas has keyboard focus — otherwise
// ⌘F/⌘E/⌘K die inside the iframe and the insert palette never opens.
function forwardShortcut(event: KeyboardEvent): void {
  // ⌥P toggles the preview, so it is forwarded from the live preview too, where
  // the canvas does not select. Matched on the physical key: Option turns P
  // into "π". A field in the page keeps it.
  if (isPreviewKey(event)) {
    if (!eventInField(event)) {
      event.preventDefault();
      try {
        window.parent.postMessage({ type: 'avb:shortcut', name: 'preview' }, '*');
      } catch {
        /* ignore */
      }
    }
    return;
  }
  // The app command range (shared/properties/appShortcuts.ts APP_RESERVED_SHORTCUTS,
  // held to this list by test/shared/properties/appShortcuts.test.ts): an app's
  // command runs from the canvas too, in the editor and the live preview alike.
  // The preload imports nothing, so the range is written out here.
  const commandDigit = /^Digit([1-9])$/.exec(event.code)?.[1];
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.altKey && commandDigit !== undefined) {
    event.preventDefault();
    try {
      window.parent.postMessage({ type: 'avb:shortcut', name: 'appCommand', shortcut: `Mod+Alt+Shift+${commandDigit}` }, '*');
    } catch {
      /* ignore */
    }
    return;
  }
  if (!canvasSelects()) {
    return;
  }
  const mod = event.metaKey || event.ctrlKey;
  if (mod && ['f', 'e', 'k'].includes(event.key.toLowerCase())) {
    event.preventDefault();
    try {
      window.parent.postMessage({ type: 'avb:shortcut', name: 'insert' }, '*');
    } catch {
      /* ignore */
    }
    return;
  }
  if (eventInField(event)) {
    return;
  }

  // Clicking the canvas puts keyboard focus inside this frame, so the
  // app's own arrow-key navigation would never see the keys. Forward
  // them (and swallow them here, so the page doesn't scroll instead).
  if (!mod && !event.altKey && !event.shiftKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
    event.preventDefault();
    try {
      window.parent.postMessage({ type: 'avb:shortcut', name: 'arrow', key: event.key }, '*');
    } catch {
      /* ignore */
    }
    return;
  }

  // Editing the selected node from the canvas. Undo, copy and paste
  // already survive an iframe-focused canvas because they're native
  // menu accelerators, which fire whatever holds focus; delete and
  // duplicate have no menu item, so without this they only work when
  // the selection was made in the navigator.
  const isDelete = !mod && !event.altKey && (event.key === 'Delete' || event.key === 'Backspace');
  const isDuplicate = mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'd';
  // ⌘Enter jumps to the class field. The canvas is where the selection is
  // usually made, so it has to reach the app from in here too.
  const isClassJump = mod && !event.altKey && !event.shiftKey && event.key === 'Enter';
  const isProperties = !mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k';
  // ⇧G shows or hides the column guide drawn over this frame. It is replayed
  // as the key "G", which says Shift on its own (src/features/preview/guideSettings.ts).
  const isGuide = !mod && !event.altKey && event.shiftKey && event.key.toLowerCase() === 'g';
  // The parent owns component/defaults navigation even while this frame has focus.
  const isClose = !mod && !event.altKey && !event.shiftKey && event.key === 'Escape';
  if (isDelete || isDuplicate || isClassJump || isProperties || isGuide || isClose) {
    event.preventDefault();
    try {
      window.parent.postMessage({ type: 'avb:shortcut', name: 'key', key: event.key, meta: mod }, '*');
    } catch {
      /* ignore */
    }
  }
}

// Option and P alone, the preview toggle (usePreviewKey in the app).
function isPreviewKey(event: KeyboardEvent): boolean {
  if (!event.altKey) {
    return false;
  }
  if (event.metaKey || event.ctrlKey || event.shiftKey) {
    return false;
  }
  return event.code === 'KeyP';
}

// Is the key going to a field in the page, which keeps it for typing?
function eventInField(event: KeyboardEvent): boolean {
  const target = event.target;
  return (
    target instanceof window.HTMLElement &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
  );
}
