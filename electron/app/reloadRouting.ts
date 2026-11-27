// What ⌘R and ⇧⌘R do. The application menu owns the accelerators, so the key reaches here whatever has focus: a panel, a text field,
// the AI chat input or the canvas. The person means the site every time, so focus is deliberately not an input.
//
// Pure on purpose: `main.ts` knows whether a project is open and acts on the answer; the decision needs neither Electron nor focus.

/**
 * What a site-refresh shortcut does: refresh the site preview (the toolbar's refresh button), clear the HTTP cache first and then
 * refresh, or nothing.
 */
export type ReloadAction = 'refreshPreview' | 'clearCacheAndRefreshPreview' | 'noop';

// Both refreshes bump the iframe's key, which mounts a new document. An image replaced under the same name shows on either one
// because Stacki's preview servers send images with `no-store` (previewServer/previewImageCache.ts), not because of anything here.
// The hard refresh (⇧⌘R) also clears the HTTP cache, which helps with other long-lived answers (a remote file, say). It does not
// reach what a running window holds in memory, so it cannot by itself replace an image a server said to keep, as a server Stacki
// did not configure still does (one the person started, or the fallback on the project's own config). With no preview open (the
// welcome screen) there is nothing to refresh, and the shortcut must not fall back to reloading Stacki, which would discard the
// person's place.
export function routeReload(options: { readonly previewOpen: boolean; readonly hard?: boolean }): ReloadAction {
  if (!options.previewOpen) {
    return 'noop';
  }
  return options.hard === true ? 'clearCacheAndRefreshPreview' : 'refreshPreview';
}
