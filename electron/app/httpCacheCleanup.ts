// The one-time clearing of the HTTP cache after an update.
//
// Versions up to this one let the preview's images into the disk cache for a year under names that
// hold no content hash (previewServer/previewImageCache.ts). The server now asks for them to be
// checked, but a stored answer carries the old promise and is used without asking, across restarts.
// So the cache is cleared once, before the window loads anything, and settings.json remembers which
// cleanup has run. Only the HTTP cache goes: cookies, local storage and every other kind of site
// data stay.
//
// Pure on purpose: `main.ts` supplies the clearing and the remembering.

import { assert } from '../../shared/core/assert';

/** Raise this to clear once more on every install that has run an earlier cleanup. */
export const HTTP_CACHE_CLEANUP_VERSION = 1;

/** The longest the window's load waits for the clearing; past it the app starts and the next launch tries again. */
export const HTTP_CACHE_CLEANUP_WAIT_MS_MAX = 2000;

export type HttpCacheCleanupOutcome = 'alreadyDone' | 'cleared' | 'failed' | 'timedOut';

export async function cleanUpHttpCacheOnce(options: {
  /** The cleanup settings.json says has run; 0 for none. */
  readonly doneVersion: number;
  readonly clearCache: () => Promise<void>;
  readonly waitMsMax: number;
  /** Stores that this cleanup ran. Only called after a clearing that finished. */
  readonly remember: (version: number) => void;
}): Promise<HttpCacheCleanupOutcome> {
  assert(Number.isSafeInteger(options.doneVersion), 'cleanUpHttpCacheOnce: the stored version is an integer');
  assert(options.waitMsMax > 0, 'cleanUpHttpCacheOnce: the wait has a bound');
  // A later version's number (after a downgrade) counts as done too.
  if (options.doneVersion >= HTTP_CACHE_CLEANUP_VERSION) {
    return 'alreadyDone';
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'timedOut'>((resolve) => {
    timer = setTimeout(() => resolve('timedOut'), options.waitMsMax);
  });
  try {
    const outcome = await Promise.race([options.clearCache().then(() => 'cleared' as const), late]);
    if (outcome === 'cleared') {
      options.remember(HTTP_CACHE_CLEANUP_VERSION);
    }
    return outcome;
  } catch (error: unknown) {
    console.warn('[startup] the HTTP cache was not cleared:', error instanceof Error ? error.message : String(error));
    return 'failed';
  } finally {
    clearTimeout(timer);
  }
}
