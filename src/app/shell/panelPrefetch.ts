// Readies the left-rail panels after a project opens, so the first open of each
// paints its finished content in its first frame.
//
// Why: the first open of a panel in a session used to flicker. A lazy panel
// committed an empty frame while React.lazy resolved its chunk (lazyPanel.tsx),
// and a panel whose data is cached per project (usePanelData) painted its
// loading skeleton until its first read came back, then swapped in the list.
// The Code panel painted Astro source grey until the grammar loaded. Later
// opens were fine because by then the chunk, the cache and the grammar were
// all warm. This warms them ahead of the first open instead.
//
// A second open must not flicker either. Panels unmount when another one opens
// (they are not kept mounted hidden: see LeftPanel in AppShell.tsx for why), so
// each one opens on its last data, kept per project outside the panel, and
// reads again in place. This pass fills those caches before the first open.
//
// Work is bounded: one pass per project open (and one timeline read per branch
// and head), run one step at a time after a delay and then only when the
// renderer is idle, so it never competes with the dev server start, the first
// page render or the user's own input. Closing the project cancels the rest.
//
// Desktop (AppShell.tsx) and Studio (its Editor.tsx, which vendors this file) both
// run it. The panel chunks are the host's own (Desktop's lazy panels live in
// src/app/appPanels.ts), so the host passes how to preload them, and the reads
// of panels only one host has (Desktop's Instructions and Apps).
import { prefetchAstroHighlighter } from '../../ui/astroHighlight';
import { prewarmVariables } from '../../features/variables/variableCache';
import { prewarmCmsCatalog, prewarmCmsConnections } from '../../features/cms/cmsCatalog';
import { prewarmAssetListing } from '../../features/assets/assetListingCache';
import { prewarmTimeline } from '../../features/history/timelineCache';
import { assert } from '../../../shared/core/assert';

// After the dev server and the page have had the machine to themselves for a
// moment, but before most people reach for a second panel.
const PREFETCH_DELAY_MS = 1_500;
/** The host's own panel reads in one pass: Desktop has four. */
export const PREFETCH_HOST_READS_MAX = 6;
/** The chunks, the grammar, four shared panel reads and the host's: one pass never does more. */
const PREFETCH_STEPS_MAX = 6 + PREFETCH_HOST_READS_MAX;
// How long a step waits for an idle moment before it runs anyway.
const IDLE_WAIT_MS_MAX = 2_000;

export interface PanelPrefetch {
  /** The key the panels read the project under: Desktop's folder path, Studio's `studio`. */
  readonly projectPath: string;
  /** Fetches the host's lazy panel chunks; undefined for a host whose panels are in its main bundle. */
  readonly preloadChunks: (() => Promise<void>) | undefined;
  /** The first reads of panels only this host has, each into the cache its panel opens on. */
  readonly hostReads: ReadonlyArray<() => Promise<void>>;
}

/** Fetches the panel chunks, the Astro grammar and the panels' first reads. Returns a cancel. */
export function prefetchPanels({ projectPath, preloadChunks, hostReads }: PanelPrefetch): () => void {
  assert(projectPath.length > 0, 'prefetchPanels: a project is open');
  assert(hostReads.length <= PREFETCH_HOST_READS_MAX, 'prefetchPanels: the host reads are bounded');
  let active = true;
  // Each step is its own read; a step that fails leaves its panel to read, and
  // report, for itself when it opens. The chunks come first: a panel's chunk is
  // what its first open waits on longest.
  const steps: ReadonlyArray<() => Promise<void>> = [
    ...(preloadChunks === undefined ? [] : [preloadChunks]),
    prefetchAstroHighlighter,
    () => prewarmVariables(projectPath),
    () => prewarmAssetListing(projectPath),
    () => prewarmCmsCatalog(projectPath),
    () => prewarmCmsConnections(projectPath),
    ...hostReads,
  ];
  assert(steps.length <= PREFETCH_STEPS_MAX, 'prefetchPanels: the pass is bounded');
  const timer = setTimeout(() => {
    void runSteps(steps, () => active);
  }, PREFETCH_DELAY_MS);
  return () => {
    active = false;
    clearTimeout(timer);
  };
}

/** Reads the Git panel's first page of history for the branch and head the project is on. Returns a cancel. */
export function prefetchTimeline(projectPath: string, branch: string | undefined, head: string | undefined): () => void {
  assert(projectPath.length > 0, 'prefetchTimeline: a project is open');
  let active = true;
  const timer = setTimeout(() => {
    void runSteps([() => prewarmTimeline(projectPath, branch, head)], () => active);
  }, PREFETCH_DELAY_MS);
  return () => {
    active = false;
    clearTimeout(timer);
  };
}

async function runSteps(steps: ReadonlyArray<() => Promise<void>>, isActive: () => boolean): Promise<void> {
  assert(steps.length > 0, 'prefetch: there is something to fetch');
  for (const step of steps) {
    await idleMoment();
    if (!isActive()) {
      return;
    }
    try {
      await step();
    } catch (error: unknown) {
      // Best effort: the panel that needs this reads it again when it opens
      // and reports the failure there, where the user can act on it.
      console.warn('Panel prefetch failed', error);
    }
  }
}

// Resolves when the renderer has a moment to spare, or after IDLE_WAIT_MS_MAX at
// the latest, so a busy renderer still finishes the pass. A host without idle
// callbacks (Node under test) yields one task instead.
function idleMoment(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => resolve(), { timeout: IDLE_WAIT_MS_MAX });
    } else {
      setTimeout(resolve, 0);
    }
  });
}
