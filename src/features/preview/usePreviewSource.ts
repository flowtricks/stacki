import { useEffect, useRef, useState } from 'react';
import { defaultsPreviewTransition } from '../../../shared/properties/previewRoute';

// Keep the same browsing context across defaults entry/exit. Ordinary navigation
// still changes src; refresh and component scripts retain their existing behavior.
export function usePreviewSource(url: string | undefined, send: (message: unknown) => void) {
  const previous = useRef(url);
  const [source, setSource] = useState({ requested: url, frameURL: url });
  // Resolve native navigation before committing children, so the runtime registers
  // the replacement window rather than sending new-page queries to the old one.
  if (source.requested !== url) {
    const morph = source.requested && url && defaultsPreviewTransition(source.requested, url);
    setSource({ requested: url, frameURL: morph ? source.frameURL : url });
  }
  useEffect(() => {
    const before = previous.current;
    previous.current = url;
    if (before === url) {
      return;
    }
    if (before && url && defaultsPreviewTransition(before, url)) {
      send({ type: 'avb:preview-route', url });
    }
  }, [url, send]);
  return {
    url: source.frameURL,
    loaded: () => {
      if (url) {
        send({ type: 'avb:preview-route', url });
      }
    },
  };
}
