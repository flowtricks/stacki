// The renderer's start, as `performance.mark`s any profiler or test can read, and the work that waits
// for it: what a cold start does not need (the editor shell's chunk, the Settings dialog's chunk) is
// fetched once the first frame is on screen and the renderer has nothing else to do (docs/startup.md).
//
// Marks (durations since navigation start, in the Performance panel's User Timing track):
//   stacki:html-parsed    the document is parsed (an inline script in index.html).
//   stacki:shell-painted  React's first frame has been handed to the compositor.
//   stacki:interactive    the renderer went idle after that: input is handled at once.
//   stacki:project-ready  an opened project's pages are scanned and the first page selected.
import { assert } from '../../shared/core/assert';
import { reportFirstFrame } from '../lib/bootSeed';
import { loadShell } from './shell/lazyShell';
import { preloadSettings } from './settings/LazySettings';

export type RendererMark = 'stacki:shell-painted' | 'stacki:interactive' | 'stacki:project-ready';

/** Longest the idle work waits for a quiet moment before it runs anyway. */
const IDLE_WAIT_MS_MAX = 2_000;

/** Records a mark once; the second call for the same name is ignored so a reopen does not move it. */
export function markRenderer(name: RendererMark): void {
  if (performance.getEntriesByName(name).length === 0) {
    performance.mark(name);
  }
}

/** After the first frame paints: marks it, then, when idle, marks interactive and fetches the deferred chunks. */
export function runAfterFirstPaint(): void {
  assert(typeof requestAnimationFrame === 'function', 'startupMarks: a renderer has animation frames');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      markRenderer('stacki:shell-painted');
      // The first real frame is on its way to the screen: main shows the window (nothing was drawn in front of it).
      reportFirstFrame();
      whenIdle(() => {
        markRenderer('stacki:interactive');
        console.debug(describeRendererStart());
        // Failures are the chunk's own to report when it is first needed; a prefetch never throws into the page.
        void loadShell().catch(() => undefined);
        void preloadSettings().catch(() => undefined);
      });
    });
  });
}

function whenIdle(task: () => void): void {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(task, { timeout: IDLE_WAIT_MS_MAX });
  } else {
    setTimeout(task, 0);
  }
}

/** One debug line of durations, in whole milliseconds. */
function describeRendererStart(): string {
  const entries = performance
    .getEntriesByType('mark')
    .filter((entry) => entry.name.startsWith('stacki:'))
    .map((entry) => `${entry.name.slice('stacki:'.length)}=${Math.round(entry.startTime)}ms`);
  return `[startup] renderer ${entries.join(' ')}`;
}
