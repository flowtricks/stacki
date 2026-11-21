// Where ⌘R and ⇧⌘R go. The application menu owns the accelerators, so the key never reaches the page: with focus inside the canvas
// (the site's iframe) it used to reload Stacki itself, and what the person meant was the site. The menu click asks this module.
//
// Pure on purpose: `main.ts` reads the focused frame from Electron and acts on the answer; the decision needs neither.
import type { ReloadCommand } from './applicationMenu';

/** What a reload shortcut does: refresh the site preview (the toolbar's refresh button), or the menu item's own command. */
export type ReloadAction = 'refreshPreview' | ReloadCommand;

/** Where keyboard focus is when the accelerator fires. */
export type ReloadFocus = 'canvas' | 'app';

/** The part of Electron's `WebFrameMain` the classification reads. */
export interface FocusedFrame {
  readonly isMainFrame: boolean;
  readonly url: string;
}

// Hard and soft reload are the same refresh for the site: the toolbar button has one action, and it bumps the iframe's key, which
// mounts a new document rather than reloading from cache.
export function routeReload(command: ReloadCommand, focus: ReloadFocus): ReloadAction {
  if (focus === 'canvas') {
    return 'refreshPreview';
  }
  return command;
}

// Everything that is not the window's own document is a frame Stacki embeds: the site canvas (a loopback dev server) or an app's
// frame, which lives on the app scheme and keeps the old behaviour because an app is Stacki's, not the site. No frame focused, or
// the main one, is the app.
export function classifyFocusedFrame(frame: FocusedFrame | undefined, appScheme: string): ReloadFocus {
  if (frame === undefined) {
    return 'app';
  }
  if (frame.isMainFrame) {
    return 'app';
  }
  if (frame.url.startsWith(`${appScheme}:`)) {
    return 'app';
  }
  return 'canvas';
}
