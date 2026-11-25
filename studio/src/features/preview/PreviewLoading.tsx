import { useTranslate } from '../../../vendor/stacki/src/lib/i18n/useTranslate';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { handshakeWait, HANDSHAKE_LIMITS, pagePath, parsePreviewError, retryOffered, type HandshakeWait } from './previewHandshake';
import { STARTUP_LIMITS, type StartupView } from '../startup/startupStages';
import { STARTUP_STAGE_KEYS } from '../startup/startupText';
import { useElapsed } from '../startup/useElapsed';

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
  const [slow, setSlow] = useState(false);
  const [wait, setWait] = useState<HandshakeWait>({ kind: 'address' });
  const [frameError, setFrameError] = useState<string>();
  const errorRef = useRef<string>();
  const [attempt, setAttempt] = useState(0);
  // Frames that fired a load event. A cross-origin frame's document cannot be read, so the event is the evidence.
  const loads = useRef(new Set<EventTarget>());
  const session = `${canvas}:${attempt}`;
  const key = `${url ?? ''}:${session}`;
  // Attach before yielding to the browser so a cached frame cannot announce
  // readiness before the parent starts listening.
  useLayoutEffect(() => {
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
      const failure = parsePreviewError(data);
      if (failure !== undefined) {
        errorRef.current = failure;
        setFrameError(failure);
        return;
      }
      if (data && typeof data === 'object' && 'type' in data && data.type === 'studio:preview-ready') {
        // A client from an older bake names no page: it answers for the URL asked for.
        const path = 'path' in data ? readyPath(data.path) : undefined;
        setReady({ session, path: path ?? pagePath(url, location.href) });
      }
    };
    // A load event does not bubble, so the listener captures on the container.
    const element = container.current;
    const loaded = (event: Event) => {
      if (event.target instanceof HTMLIFrameElement) {
        loads.current.add(event.target);
      }
    };
    loads.current.clear();
    element?.addEventListener('load', loaded, true);
    window.addEventListener('message', receive);
    return () => {
      element?.removeEventListener('load', loaded, true);
      window.removeEventListener('message', receive);
    };
  }, [url, container, key, session]);
  const shown = url !== undefined && ready !== undefined && ready.session === session && ready.path === pagePath(url, location.href);
  // The long-wait clock runs from when the loader appeared, not from the last URL change: an address
  // that keeps being replaced must not keep postponing the message that says what is missing.
  useEffect(() => {
    if (shown) {
      setSlow(false);
      return undefined;
    }
    const timer = setTimeout(() => {
      const frames = [...(container.current?.querySelectorAll('iframe') ?? [])];
      const loaded = frames.filter((frame) => loads.current.has(frame)).length;
      const waiting = handshakeWait({ url, frames: frames.length, framesLoaded: loaded });
      setWait(waiting);
      setSlow(true);
      reportWait({
        stage: waiting.kind,
        frames: frames.length,
        framesLoaded: loaded,
        frameError: errorRef.current ?? '',
        page: url === undefined ? '' : new URL(url, location.href).pathname,
      });
    }, HANDSHAKE_LIMITS.slowAfterMs);
    return () => clearTimeout(timer);
  }, [shown, session, url, container]);
  return {
    ready: shown,
    // A frame that has shown its page is never "slow" for a URL it is already showing.
    slow: !shown && slow,
    wait,
    frameError: shown ? undefined : frameError,
    attempt,
    retry: () => {
      // Retry starts the whole wait again: the loader goes back to its spinner at once, the old frame's
      // error and load count are forgotten, and the slow clock restarts for the fresh grant. Without the
      // reset the button stayed on screen showing the old reason, and a click looked like nothing.
      setSlow(false);
      setWait({ kind: 'address' });
      setFrameError(undefined);
      errorRef.current = undefined;
      loads.current.clear();
      setAttempt((value) => (retryOffered(value) ? value + 1 : value));
      if (retryOffered(attempt)) {
        refresh();
      }
    },
  };
}

// Tells the Worker the canvas has waited too long (clientDiagnostics.ts), so a stuck canvas can be
// read from `wrangler tail` without the person's console. A failure to report is not worth a second one.
function reportWait(report: {
  readonly stage: HandshakeWait['kind'];
  readonly frames: number;
  readonly framesLoaded: number;
  readonly frameError: string;
  readonly page: string;
}) {
  void fetch('/studio/api/client-diagnostics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      stage: report.stage,
      frames: report.frames,
      framesLoaded: report.framesLoaded,
      frameError: report.frameError,
      page: report.page,
      startupStage: '',
      userAgent: navigator.userAgent.slice(0, 200),
    }),
  }).catch(() => undefined);
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

const WAIT_KEYS = {
  address: 'preview.studio.waitAddress',
  frame: 'preview.studio.waitFrame',
  script: 'preview.studio.waitScript',
} as const satisfies Record<HandshakeWait['kind'], string>;

export function PreviewLoading({
  slow,
  wait,
  frameError,
  retry,
  attempt,
  startup,
}: {
  readonly slow: boolean;
  readonly wait: HandshakeWait;
  readonly frameError: string | undefined;
  readonly retry: () => void;
  readonly attempt: number;
  readonly startup: StartupView | undefined;
}) {
  const translate = useTranslate();
  // While the container itself is still starting, the page cannot load and Retry cannot help:
  // say which stage it is in, and offer Retry only after the stated limit.
  const cold = startup !== undefined && startup.stage !== 'ready';
  const late = useElapsed(STARTUP_LIMITS.retryAfterMs);
  const message =
    startup !== undefined && cold
      ? translate(STARTUP_STAGE_KEYS[startup.stage])
      : slow
        ? translate('preview.studio.slow')
        : translate('preview.studio.loadingYours');
  const showRetry = (cold ? late : slow) && retryOffered(attempt);
  return (
    <div className="studio-preview-loading" role="status">
      <span className="studio-preview-spinner" aria-hidden="true" />
      <p>{message}</p>
      {slow && !cold && <p className="studio-preview-wait">{translate(WAIT_KEYS[wait.kind])}</p>}
      {frameError !== undefined && <p className="studio-preview-wait">{frameError}</p>}
      {showRetry && <button onClick={retry}>{translate('preview.studio.retry')}</button>}
    </div>
  );
}
