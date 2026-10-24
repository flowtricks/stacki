import { useSyncExternalStore } from 'react';

// Keep this breakpoint aligned with Studio's overlay panels in studio.css.
const MOBILE_EDITOR_QUERY = '(max-width: 700px)';

export function isMobileEditor(): boolean {
  return window.matchMedia(MOBILE_EDITOR_QUERY).matches;
}

export function useMobileEditor(): boolean {
  return useSyncExternalStore(subscribe, isMobileEditor);
}

function subscribe(changed: () => void): () => void {
  const media = window.matchMedia(MOBILE_EDITOR_QUERY);
  media.addEventListener('change', changed);
  return () => media.removeEventListener('change', changed);
}
