// Where the page was scrolled, kept across the error page that replaced it (docs/canvas-recovery.md).
//
// A page that stops compiling is answered with the dev server's error screen; when the mistake is fixed the canvas
// loads the real page again as a new document, and a new document starts at the top. The person was looking at the
// middle of a long page when the edit went wrong, and is put back at its top when it comes right. So a healthy design
// frame remembers its scroll per route, and the next healthy document of the route restores it, but only when an error
// screen stood between the two: an ordinary reload, or coming back to a page later, starts where it always did.
//
// The error screen is recognised by its status (the navigation entry's `responseStatus`), the one thing the dev server
// does not change between Astro and Vite versions. It stores nothing of its own scroll, only that it was shown.
// Storage is the frame's own origin's session storage, which every document of the route in this window shares; a
// storage that throws (blocked, full, private mode) means nothing is remembered and nothing breaks.
export const SCROLL_MEMORY_LIMITS = {
  /** Animation frames spent putting the page back: the page may not be tall enough yet while images and fonts load. */
  restoreFramesMax: 60,
  /** CSS pixels the page may be off the remembered position and still count as restored. */
  restoreTolerancePx: 2,
  /** Characters of the route kept in a storage key. */
  routeCharsMax: 512,
} as const satisfies Record<string, number>;

const SCROLL_PREFIX = 'avb:scroll:';
const ERROR_SHOWN_PREFIX = 'avb:error-shown:';

interface RememberedScroll {
  readonly x: number;
  readonly y: number;
}

/** Starts remembering this frame's scroll, and restores it when an error screen was shown for this route just before. */
export function rememberScrollAcrossRecovery(): void {
  if (!location.hash.includes('avb-design')) {
    return;
  }
  const route = location.pathname.slice(0, SCROLL_MEMORY_LIMITS.routeCharsMax);
  if (documentFailed()) {
    // The error screen keeps its own scroll to itself: it would overwrite the page's.
    store(ERROR_SHOWN_PREFIX + route, '1');
    return;
  }
  const remembered = takeRememberedScroll(route);
  let queued = false;
  window.addEventListener(
    'scroll',
    () => {
      if (queued) {
        return;
      }
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        store(SCROLL_PREFIX + route, JSON.stringify({ x: window.scrollX, y: window.scrollY }));
      });
    },
    { passive: true },
  );
  if (remembered !== undefined) {
    restoreScroll(remembered);
  }
}

function documentFailed(): boolean {
  const entry = performance.getEntriesByType('navigation')[0];
  if (entry === undefined || !('responseStatus' in entry)) {
    return false;
  }
  const status = entry.responseStatus;
  return typeof status === 'number' && status >= 500;
}

// The scroll the last healthy document left, when an error screen was shown since; the flag is spent either way.
function takeRememberedScroll(route: string): RememberedScroll | undefined {
  const shown = load(ERROR_SHOWN_PREFIX + route);
  if (shown === undefined) {
    return undefined;
  }
  remove(ERROR_SHOWN_PREFIX + route);
  const saved = load(SCROLL_PREFIX + route);
  if (saved === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(saved);
    if (typeof parsed !== 'object' || parsed === null || !('x' in parsed) || !('y' in parsed)) {
      return undefined;
    }
    const { x, y } = parsed;
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
      return undefined;
    }
    return { x: Math.max(0, x), y: Math.max(0, y) };
  } catch {
    return undefined;
  }
}

// Puts the page back, a frame at a time: it may not be tall enough yet. A wheel, touch or key from the person ends it.
function restoreScroll(target: RememberedScroll): void {
  let frames = 0;
  let ended = false;
  const end = (): void => {
    ended = true;
  };
  for (const name of ['wheel', 'touchstart', 'keydown', 'pointerdown']) {
    window.addEventListener(name, end, { once: true, passive: true });
  }
  const step = (): void => {
    frames += 1;
    if (ended || frames > SCROLL_MEMORY_LIMITS.restoreFramesMax) {
      return;
    }
    window.scrollTo({ left: target.x, top: target.y, behavior: 'instant' });
    if (Math.abs(window.scrollY - target.y) > SCROLL_MEMORY_LIMITS.restoreTolerancePx) {
      requestAnimationFrame(step);
    }
  };
  requestAnimationFrame(step);
}

function store(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Nothing is remembered; the page still works.
  }
}

function load(key: string): string | undefined {
  try {
    return sessionStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function remove(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Nothing to forget.
  }
}
