// Who ⌘V belongs to when no text field has focus. By default it pastes the
// copied element: in Desktop the Edit menu's Paste does that (appKeys.ts), and
// in Studio the editor's keydown does (useEditorKeys.ts). A tool that reads the
// clipboard itself, such as the clip-path editor turning a pasted SVG into a
// shape, claims ⌘V while it is open. Then Desktop runs the browser's own paste,
// and Studio leaves the key alone, so a `paste` event reaches the tool's
// listener instead of a copied element landing on the page.
//
// A module-level count rather than React state: the claimant (a lazily loaded
// editor) and the readers (the app's key and menu handlers) share no component
// tree, and the readers ask at the moment of the key press, so nothing needs to
// re-render when a claim starts or ends. The count is the one piece of mutable
// state here, and only the two functions below touch it.

import { assert } from '../../shared/core/assert';

// More claims than this at once means a claimant is not releasing its own.
const MENU_PASTE_CLAIMS_MAX = 16;

let menuPasteClaimCount = 0;

// Claims ⌘V until the returned release runs. A release runs at most once, so a
// cleanup that is called twice cannot release someone else's claim.
export function claimMenuPaste(): () => void {
  assert(menuPasteClaimCount >= 0, 'claimMenuPaste: the claim count is not negative');
  assert(menuPasteClaimCount < MENU_PASTE_CLAIMS_MAX, 'claimMenuPaste: claims are released');
  menuPasteClaimCount += 1;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    assert(menuPasteClaimCount > 0, 'claimMenuPaste: a release has a claim to end');
    menuPasteClaimCount -= 1;
  };
}

// True while some open tool takes ⌘V for itself.
export function menuPasteClaimed(): boolean {
  assert(menuPasteClaimCount >= 0, 'menuPasteClaimed: the claim count is not negative');
  return menuPasteClaimCount > 0;
}
