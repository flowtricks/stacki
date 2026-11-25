// Who the Edit menu's Copy and Paste belong to when a panel that is not a text field has focus. By default they copy
// and paste the selected element on the canvas (appKeys.ts, menuCopy and menuPaste); a panel with a selection of its
// own (the Files panel's tree) registers its element here, and while focus is inside it the menu's Copy and Paste go to
// the panel instead. On macOS the menu takes ⌘C and ⌘V before the page sees the key, so a keydown handler alone would
// never hear them.
//
// A module-level list rather than React state: the registrant and the readers (the app's menu handlers) share no
// component tree, and the readers ask at the moment of the key press.
import { assert } from '../../shared/core/assert';

export interface MenuEditHandlers {
  readonly copy: () => void;
  readonly paste: () => void;
}

// More targets than this at once means a registrant is not releasing its own.
const MENU_EDIT_TARGETS_MAX = 16;

const targets: { readonly element: HTMLElement; readonly handlers: MenuEditHandlers }[] = [];

/** Routes the menu's Copy and Paste to `handlers` while focus is inside `element`; returns the release. */
export function registerMenuEditTarget(element: HTMLElement, handlers: MenuEditHandlers): () => void {
  assert(targets.length < MENU_EDIT_TARGETS_MAX, 'registerMenuEditTarget: targets are released');
  const entry = { element, handlers };
  targets.push(entry);
  return () => {
    const index = targets.indexOf(entry);
    if (index >= 0) {
      targets.splice(index, 1);
    }
  };
}

/** The handlers of the target holding focus, or undefined when none does. */
export function focusedMenuEditTarget(active: Element | undefined): MenuEditHandlers | undefined {
  if (active === undefined) {
    return undefined;
  }
  return targets.find((target) => target.element.contains(active))?.handlers;
}
