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

type PreviewStatusHandler = (target: PreviewTarget, status: 'ready' | 'empty') => void;

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
            target={frame.target}
            visible={frame.target.url === url && frame.status === 'ready'}
            onStatus={receive}
            {...(resolvePreviewURL ? { resolvePreviewURL } : {})}
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
  const receive = useCallback<PreviewStatusHandler>((readyTarget, status) => {
    setCache((current) => ({
      ...current,
      frames: current.frames.map((entry) => (entry.target.url === readyTarget.url ? { ...entry, status } : entry)),
    }));
  }, []);
  return { frames, receive };
}

function ComponentPreviewFrame({
  target,
  visible,
  onStatus,
  resolvePreviewURL,
}: {
  readonly target: PreviewTarget;
  readonly visible: boolean;
  readonly onStatus: PreviewStatusHandler;
  readonly resolvePreviewURL?: (url: string) => Promise<string>;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const resolvedURL = useResolvedPreviewURL(target.url, resolvePreviewURL);
  const receive = useCallback(
    (message: ComponentPreviewMessage): void => {
      onStatus(target, message.status);
    },
    [target, onStatus],
  );
  usePreviewMessages(frameRef, receive);
  useEffect(() => {
    if (resolvedURL.kind === 'empty') {
      onStatus(target, 'empty');
    }
  }, [resolvedURL, target, onStatus]);
  if (resolvedURL.kind !== 'ready') {
    return undefined;
  }
  return <iframe ref={frameRef} src={resolvedURL.url} title={`${target.name} preview`} style={{ opacity: visible ? 1 : 0 }} aria-hidden={!visible} />;
}
