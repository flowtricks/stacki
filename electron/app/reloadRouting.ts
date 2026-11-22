// What ⌘R and ⇧⌘R do. The application menu owns the accelerators, so the key reaches here whatever has focus: a panel, a text field,
// the AI chat input or the canvas. The person means the site every time, so focus is deliberately not an input.
//
// Pure on purpose: `main.ts` knows whether a project is open and acts on the answer; the decision needs neither Electron nor focus.

/** What a site-refresh shortcut does: refresh the site preview (the toolbar's refresh button), or nothing. */
export type ReloadAction = 'refreshPreview' | 'noop';

// Hard and soft refresh are the same for the site: the toolbar button has one action, and it bumps the iframe's key, which mounts a
// new document rather than reloading from cache. With no preview open (the welcome screen) there is nothing to refresh, and the
// shortcut must not fall back to reloading Stacki, which would discard the person's place.
export function routeReload(options: { readonly previewOpen: boolean }): ReloadAction {
  if (options.previewOpen) {
    return 'refreshPreview';
  }
  return 'noop';
}
