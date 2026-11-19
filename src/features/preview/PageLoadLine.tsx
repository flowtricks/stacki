// The thin loading line along the bottom of the address bar. It starts in the frame a page switch begins,
// creeps while the page loads, runs to the end and fades when the canvas is ready. No text and no spinner:
// a fill, not a border. Reduced motion gets a static bar that simply appears and disappears (previewViewport.css).
//
// The line can never stick: it ends when the last frame reports ready or unmounts, and after
// PAGE_LOAD_LINE_MS_MAX it finishes on its own, so a page that errors or never answers still clears it.

import { useEffect, useState } from 'react';
import { usePageLoading } from './pageLoadState';

/** The longest the line waits for a page before it completes anyway. */
export const PAGE_LOAD_LINE_MS_MAX = 20000;
/** How long the finish (run to the end, then fade) takes before the line is removed. */
export const PAGE_LOAD_LINE_FINISH_MS = 450;

type Phase = 'idle' | 'loading' | 'finishing';

export function PageLoadLine() {
  const loading = usePageLoading();
  const [phase, setPhase] = useState<Phase>('idle');
  // Derived during render so the line is up in the same frame the frame starts loading.
  if (loading && phase !== 'loading') {
    setPhase('loading');
  }
  useEffect(() => {
    if (phase === 'loading') {
      if (loading) {
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
  }, [phase, loading]);
  if (phase === 'idle') {
    return undefined;
  }
  return <span className={`page-load-line is-${phase}`} aria-hidden="true" />;
}
