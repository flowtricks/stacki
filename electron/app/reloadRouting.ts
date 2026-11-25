// What ⌘R and ⇧⌘R do. The application menu owns the accelerators, so the key reaches here whatever has focus: a panel, a text field,
// the AI chat input or the canvas. The person means the site every time, so focus is deliberately not an input.
//
// Pure on purpose: `main.ts` knows whether a project is open and acts on the answer; the decision needs neither Electron nor focus.

/**
 * What a site-refresh shortcut does: refresh the site preview (the toolbar's refresh button), clear the HTTP cache first and then
 * refresh, or nothing.
 */
export type ReloadAction = 'refreshPreview' | 'clearCacheAndRefreshPreview' | 'noop';

// Both refreshes bump the iframe's key, which mounts a new document. Its subresources still come from the HTTP cache, and Astro's
// dev server sends `/_image` with a year-long max-age and no content hash in the URL: an image replaced under the same name (after a
// pull, say) keeps showing the old file, across restarts too. The hard refresh (⇧⌘R) therefore clears the cache first. With no
// preview open (the welcome screen) there is nothing to refresh, and the shortcut must not fall back to reloading Stacki, which would
// discard the person's place.
export function routeReload(options: { readonly previewOpen: boolean; readonly hard?: boolean }): ReloadAction {
  if (!options.previewOpen) {
    return 'noop';
  }
  return options.hard === true ? 'clearCacheAndRefreshPreview' : 'refreshPreview';
}
