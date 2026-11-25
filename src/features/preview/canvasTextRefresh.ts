// A write beside the page (a data module the canvas text was edited in) changes
// what its text catalog says without changing the page's own source, which is
// what rebuilds the catalog. This is the one signal that asks for a rebuild:
// held outside React, read by the text session of the open page (useCanvasText).

import { createLiveValue } from '../../ui/liveValue';

const refreshes = createLiveValue<number>(0);
/** Counts requests; wraps so it stays a small safe integer. */
const COUNT_WRAP = 1_000_000;

/** Asks the open page's text catalog to be built again from the files as they are now. */
export function requestCanvasTextRefresh(): void {
  refreshes.set((refreshes.get() + 1) % COUNT_WRAP);
}

/** Calls `listener` on every request; returns the way to stop. */
export function onCanvasTextRefresh(listener: () => void): () => void {
  return refreshes.subscribe(listener);
}
