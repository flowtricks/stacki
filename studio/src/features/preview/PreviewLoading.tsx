import { useLayoutEffect, useState } from 'react';

// Readiness belongs to the document the frame is showing, not to the URL Studio
// last asked for. Following a link in interact mode loads the new page in the
// frame first; Studio learns the route afterwards and sets the frame to the URL
// it already shows, which does not load it again, so no second ready message
// comes. Keyed by the URL alone, that first one was thrown away and the canvas
// waited behind its loader. The client says which page it is (previewClient.ts),
// and that page answers for any URL with the same path.
const READY_PATH_CHARS_MAX = 4000;

export function usePreviewLoading(url: string | undefined, container: React.RefObject<HTMLElement>, canvas: boolean, refresh: () => void) {
  const [ready, setReady] = useState<{ readonly session: string; readonly path: string }>();
  const [slowKey, setSlowKey] = useState('');
  const [attempt, setAttempt] = useState(0);
  const session = `${canvas}:${attempt}`;
  const key = `${url ?? ''}:${session}`;
  // Attach before yielding to the browser so a cached frame cannot announce
  // readiness before the parent starts listening.
  useLayoutEffect(() => {
    const timer = setTimeout(() => setSlowKey(key), 15000);
    const receive = (event: MessageEvent) => {
      if (!url || event.origin !== new URL(url, location.href).origin) {
        return;
      }
      // Browser error documents fire load too. Only our preview client can
      // confirm readiness, and it must belong to one of this canvas's frames.
      const frames = container.current?.querySelectorAll('iframe') ?? [];
      if (![...frames].slice(0, 3).some((frame) => event.source === frame.contentWindow)) {
        return;
      }
      const data: unknown = event.data;
      if (data && typeof data === 'object' && 'type' in data && data.type === 'studio:preview-ready') {
        // A client from an older bake names no page: it answers for the URL asked for.
        const path = 'path' in data ? readyPath(data.path) : undefined;
        setReady({ session, path: path ?? pagePath(url) });
      }
    };
    window.addEventListener('message', receive);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('message', receive);
    };
  }, [url, container, key, session]);
  const shown = url !== undefined && ready !== undefined && ready.session === session && ready.path === pagePath(url);
  return {
    ready: shown,
    // A frame that has shown its page is never "slow" for a URL it is already showing.
    slow: !shown && slowKey === key,
    attempt,
    retry: () => {
      setAttempt((value) => value + 1);
      refresh();
    },
  };
}

/** The page a URL names: its path and query, without the editor's fragment. */
export function pagePath(url: string): string {
  const parsed = new URL(url, location.href);
  return parsed.pathname + parsed.search;
}

function readyPath(input: unknown): string | undefined {
  if (typeof input !== 'string') {
    return undefined;
  }
  if (input.length > READY_PATH_CHARS_MAX) {
    return undefined;
  }
  return input.startsWith('/') ? input : undefined;
}

export function PreviewLoading({ slow, retry }: { readonly slow: boolean; readonly retry: () => void }) {
  return (
    <div className="studio-preview-loading" role="status">
      <span className="studio-preview-spinner" aria-hidden="true" />
      <p>{slow ? 'Your preview is taking a little longer to start…' : 'Loading your preview…'}</p>
      {slow && <button onClick={retry}>Retry preview</button>}
    </div>
  );
}
