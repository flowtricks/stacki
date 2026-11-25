// The thin loading line along the bottom of the address bar. It starts in the frame a page switch begins,
// creeps while the page loads, runs to the end and fades when the canvas is ready. No text and no spinner:
// a fill, not a border. Reduced motion gets a static bar that simply appears and disappears (previewViewport.css).
//
// The line can never stick: it ends when the last frame reports ready or unmounts, and after
// PAGE_LOAD_LINE_MS_MAX it finishes on its own, so a page that errors or never answers still clears it.

import { useEffect, useState } from 'react';
import { usePageLoad } from './pageLoadState';

/** The longest the line waits for a page before it completes anyway. */
export const PAGE_LOAD_LINE_MS_MAX = 20000;
/** How long the finish (run to the end, then fade) takes before the line is removed. */
export const PAGE_LOAD_LINE_FINISH_MS = 450;

type Phase = 'idle' | 'loading' | 'finishing';

export function PageLoadLine() {
  const load = usePageLoad();
  const [phase, setPhase] = useState<Phase>('idle');
  const [seen, setSeen] = useState(0);
  // Derived during render so the line is up in the same frame the frame starts loading. It rises only for a
  // wait it has not seen: after giving up, the same still-waiting frame must not raise it again.
  if (load !== seen) {
    setSeen(load);
    if (load !== 0) {
      setPhase('loading');
    }
  }
  useEffect(() => {
    if (phase === 'loading') {
      if (load !== 0) {
        const giveUp = window.setTimeout(() => setPhase('finishing'), PAGE_LOAD_LINE_MS_MAX);
        return () => window.clearTimeout(giveUp);
      }
      setPhase('finishing');
      return undefined;
    }
    if (phase === 'finishing') {
      const done = window.setTimeout(() => setPhase('idle'), PAGE_LOAD_LINE_FINISH_MS);
      return () => window.clearTimeout(done);
    }
    return undefined;
  }, [phase, load]);
  if (phase === 'idle') {
    return undefined;
  }
  return <span className={`page-load-line is-${phase}`} aria-hidden="true" />;
}
