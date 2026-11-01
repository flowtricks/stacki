import { useLayoutEffect, useState } from 'react';

export function usePreviewLoading(url: string | undefined, container: React.RefObject<HTMLElement>, canvas: boolean, refresh: () => void) {
  const [readyKey, setReadyKey] = useState('');
  const [slowKey, setSlowKey] = useState('');
  const [attempt, setAttempt] = useState(0);
  const key = `${url ?? ''}:${canvas}:${attempt}`;
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
        setReadyKey(key);
      }
    };
    window.addEventListener('message', receive);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('message', receive);
    };
  }, [url, container, key]);
  return {
    ready: !!url && readyKey === key,
    slow: slowKey === key,
    attempt,
    retry: () => {
      setAttempt((value) => value + 1);
      refresh();
    },
  };
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
