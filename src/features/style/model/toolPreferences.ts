/*
 * Local UI preferences — kept separate from `storage.ts` (which owns the auth
 * session):
 *   - embedSource: the embed the Style Editor last targeted for new styles
 *   - selectorFilters: whether the selector well hides global selectors and
 *     inherited styles. A person's way of working, not a site's, so it is kept
 *     for the app as a whole and holds in every project.
 * Best-effort: any read failure falls back to no preference rather than
 * throwing, so a corrupt value never blocks the app from loading.
 */
import { BOUNDARY_LIMITS } from '../../../../shared/core/boundary';

// The embed the Style Editor last targeted for new custom styles — restored as the
// default so a chosen embed (e.g. a global-CSS embed) sticks across reloads.
const EMBED_SOURCE_KEY = 'moden.embedEditor.source';

/** A stored embed source key, or undefined when absent or not one: storage is
 * shared with every earlier build, so what it holds is parsed like any input.
 * A key names a file or a node, so it is bounded as a path. */
export function parseStoredEmbedSource(raw: unknown): string | undefined {
  if (typeof raw === 'string') {
    if (raw.length > 0) {
      return raw.length <= BOUNDARY_LIMITS.pathLengthMax ? raw : undefined;
    }
  }
  return undefined;
}

const SELECTOR_FILTERS_KEY = 'stacki.styleEditor.selectorFilters';

/** Which kinds of selector the well hides. Off by default: everything shows. */
export type SelectorFilters = { readonly hideGlobals: boolean; readonly hideInherited: boolean };

export const SELECTOR_FILTERS_DEFAULT: SelectorFilters = { hideGlobals: false, hideInherited: false };

/** The stored filters, or the default for anything absent or malformed. */
export function parseStoredSelectorFilters(raw: unknown): SelectorFilters {
  if (typeof raw !== 'string') {
    return SELECTOR_FILTERS_DEFAULT;
  }
  if (raw.length > SELECTOR_FILTERS_CHARS_MAX) {
    return SELECTOR_FILTERS_DEFAULT;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return SELECTOR_FILTERS_DEFAULT;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return SELECTOR_FILTERS_DEFAULT;
  }
  const hideGlobals: unknown = Reflect.get(parsed, 'hideGlobals');
  const hideInherited: unknown = Reflect.get(parsed, 'hideInherited');
  return { hideGlobals: hideGlobals === true, hideInherited: hideInherited === true };
}

// Two flags as JSON; anything longer is not one of these.
const SELECTOR_FILTERS_CHARS_MAX = 128;

export function loadSelectorFilters(): SelectorFilters {
  try {
    return parseStoredSelectorFilters(localStorage.getItem(SELECTOR_FILTERS_KEY));
  } catch {
    return SELECTOR_FILTERS_DEFAULT;
  }
}

export function saveSelectorFilters(filters: SelectorFilters): void {
  try {
    localStorage.setItem(SELECTOR_FILTERS_KEY, JSON.stringify({ hideGlobals: filters.hideGlobals, hideInherited: filters.hideInherited }));
  } catch {
    /* noop: an unsaved preference is only forgotten on the next launch */
  }
}

export function loadEmbedSource(): string | undefined {
  try {
    return parseStoredEmbedSource(localStorage.getItem(EMBED_SOURCE_KEY));
  } catch {
    return undefined;
  }
}

export function saveEmbedSource(key: string | undefined) {
  try {
    if (key) {
      localStorage.setItem(EMBED_SOURCE_KEY, key);
    } else {
      localStorage.removeItem(EMBED_SOURCE_KEY);
    }
  } catch {
    /* noop */
  }
}
