import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { assert } from '../../../shared/core/assert';
import type { ScanComponent } from '../../../shared/properties/projectScan';
import type { TrailingSlash } from '../../editor/pageState';
import { componentPreviewURL, prettyComponentName, type ComponentPreviewMessage } from './paletteModel';
import { useResolvedPreviewURL, usePreviewMessages } from './previewSource';

interface PreviewTarget {
  readonly url: string;
  readonly name: string;
}

interface PreviewEntry {
  readonly target: PreviewTarget;
  readonly status: 'loading' | 'ready' | 'empty';
}

// Retain a small working set while browsing without accumulating live component scripts.
const previewFramesMax = 4;

/** What a preview frame reports about the URL it loaded: the component rendered, or there was nothing to show, and why. */
export type PreviewStatusHandler = (url: string, status: 'ready' | 'empty', reason?: string) => void;

/**
 * How long a loaded preview page may stay silent. The route reports as soon as its script runs, before
 * the page's load event; a page that loads and never reports is an error page (a component that threw).
 */
export const previewSilenceMs = 3000;

/** What a card says on hover when the route's page loaded but never answered. */
export const PREVIEW_SILENT_REASON =
  'The preview page loaded but did not render the component; it may have thrown an error. Open it on a page to see the error.';

/** What a card says on hover when the host could not give the preview an address (an expired draft session). */
export const PREVIEW_UNRESOLVED_REASON = 'The preview could not be opened: the preview session is not available.';

export function ComponentPreviewPopup({
  preview,
  devURL,
  trailingSlash,
  resolvePreviewURL,
}: {
  readonly preview: {
    readonly component: ScanComponent;
    readonly left: number;
    readonly top: number;
  };
  readonly devURL: string;
  readonly trailingSlash: TrailingSlash;
  readonly resolvePreviewURL?: (url: string) => Promise<string>;
}) {
  const url = componentPreviewURL(devURL, preview.component, trailingSlash);
  const name = preview.component.name;
  const target = useMemo(() => ({ url, name }), [url, name]);
  const { frames, receive } = usePreviewCache(target);
  const active = frames.find((frame) => frame.target.url === url);
  assert(active, 'The hovered preview must be cached');
  const empty = active.status === 'empty';
  const loading = active.status === 'loading';
  return (
    <div
      className="comp-preview"
      style={{ left: preview.left, top: preview.top, visibility: empty ? 'hidden' : 'visible' }}
      aria-hidden={empty}
      data-loading={loading}
    >
      <div className="comp-preview-title">{prettyComponentName(name)}</div>
      <div className="comp-preview-content">
        {loading && (
          <div className="comp-preview-loading" role="status">
            <span className="panel-loading-label">Loading preview…</span>
          </div>
        )}
        {frames.map((frame) => (
          <ComponentPreviewFrame
            key={frame.target.url}
            url={frame.target.url}
            name={frame.target.name}
            visible={frame.target.url === url && frame.status === 'ready'}
            surface="popup"
            resolvePreviewURL={resolvePreviewURL}
            onStatus={receive}
          />
        ))}
      </div>
    </div>
  );
}

function usePreviewCache(target: PreviewTarget) {
  const [cache, setCache] = useState<{
    readonly frames: ReadonlyArray<PreviewEntry>;
    readonly recentURLs: ReadonlyArray<string>;
  }>({ frames: [{ target, status: 'loading' }], recentURLs: [target.url] });
  assert(cache.frames.length > 0, 'The preview cache must contain its current target');
  assert(cache.frames.length <= previewFramesMax, 'The preview cache must remain bounded');
  let frames = cache.frames;
  if (cache.recentURLs.at(-1) !== target.url) {
    const recent = cache.recentURLs.filter((url) => url !== target.url);
    const recentURLs = [...recent.slice(-(previewFramesMax - 1)), target.url];
    frames = cache.frames.filter((entry) => recentURLs.includes(entry.target.url));
    if (!frames.some((entry) => entry.target.url === target.url)) {
      frames = [...frames, { target, status: 'loading' }];
    }
    // Keep DOM order stable: moving a cached iframe would reload it in the browser.
    // Adjust during rendering so switching never paints the previous component.
    setCache({ frames, recentURLs });
  }
  const receive = useCallback<PreviewStatusHandler>((readyURL, status) => {
    setCache((current) => ({
      ...current,
      frames: current.frames.map((entry) => (entry.target.url === readyURL ? { ...entry, status } : entry)),
    }));
  }, []);
  return { frames, receive };
}

/**
 * One live rendering of a component through the project's preview route: the Components panel's
 * hover card and the insert palette's cards both draw it, so the two show the same thing. In a
 * card it is a picture inside a control: never focused, hidden from assistive technology, and
 * the card's own click inserts (the card's CSS keeps the pointer off the frame).
 */
export function ComponentPreviewFrame({
  url,
  name,
  visible,
  surface,
  resolvePreviewURL,
  onStatus,
}: {
  readonly url: string;
  readonly name: string;
  readonly visible: boolean;
  readonly surface: 'popup' | 'card';
  readonly resolvePreviewURL?: ((url: string) => Promise<string>) | undefined;
  /** Stable across renders: the frame reports through it from effects. */
  readonly onStatus: PreviewStatusHandler;
}) {
  assert(url.length > 0, 'A preview frame has a URL');
  const frameRef = useRef<HTMLIFrameElement>(null);
  const resolvedURL = useResolvedPreviewURL(url, resolvePreviewURL);
  // Whether the page has said anything; a loaded page that has not is given up on after previewSilenceMs.
  const answered = useRef(false);
  const [pageLoaded, setPageLoaded] = useState(false);
  const receive = useCallback(
    (message: ComponentPreviewMessage): void => {
      answered.current = true;
      onStatus(url, message.status, message.reason);
    },
    [url, onStatus],
  );
  usePreviewMessages(frameRef, receive);
  useEffect(() => {
    if (resolvedURL.kind === 'empty') {
      onStatus(url, 'empty', PREVIEW_UNRESOLVED_REASON);
    }
  }, [resolvedURL.kind, url, onStatus]);
  useEffect(() => {
    if (!pageLoaded) {
      return;
    }
    const timer = setTimeout(() => {
      if (!answered.current) {
        onStatus(url, 'empty', PREVIEW_SILENT_REASON);
      }
    }, previewSilenceMs);
    return () => clearTimeout(timer);
  }, [pageLoaded, url, onStatus]);
  if (resolvedURL.kind !== 'ready') {
    return undefined;
  }
  return (
    <iframe
      ref={frameRef}
      className={surface === 'card' ? 'insert-frame' : undefined}
      src={resolvedURL.url}
      title={`${name} preview`}
      tabIndex={surface === 'card' ? -1 : undefined}
      style={{ opacity: visible ? 1 : 0 }}
      aria-hidden={surface === 'card' ? true : !visible}
      onLoad={() => setPageLoaded(true)}
    />
  );
}
