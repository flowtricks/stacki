import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { pageLoadEnd, pageLoadStart } from './pageLoadState';
import { registerPreviewFrame } from './previewFrames';
import { parsePreviewMessage } from './previewMessages';

interface FrameSource {
  readonly key: string;
  readonly url: string;
}

interface PreviewFrameProps {
  readonly url: string;
  readonly refreshKey: string | number;
  readonly title: string;
  readonly frameRef?: React.ForwardedRef<HTMLIFrameElement>;
  readonly onLoad: (event: React.SyntheticEvent<HTMLIFrameElement>) => void;
}

/** Keep at most two documents: the last ready page and its replacement.
 * Distinct windows keep the old page's messages out of the new editor session. */
export function PreviewFrame({ url, refreshKey, title, frameRef, onLoad }: PreviewFrameProps) {
  const translate = useTranslate();
  const target = useMemo(() => ({ key: JSON.stringify([url, refreshKey]), url }), [url, refreshKey]);
  const latest = useRef(target.key);
  latest.current = target.key;
  const [shown, setShown] = useState<FrameSource>();
  const { attach, element } = useFrameReady(target, frameRef, setShown);
  const loading = shown?.key !== target.key;
  const retained = loading ? shown : undefined;
  // The address bar draws the loading line from this; ending on unmount keeps it from sticking. Each page
  // switched to is a new report, so the line returns even after it gave up on one that never answered.
  const frameId = useId();
  useEffect(() => {
    if (!loading) {
      return undefined;
    }
    pageLoadStart(frameId);
    return () => pageLoadEnd(frameId);
  }, [loading, frameId, target.key]);
  // A frame with its page can be asked whether it is still there (previewSupervisor.ts).
  useEffect(() => (loading ? undefined : registerPreviewFrame(frameId, element)), [loading, frameId, element]);
  const frames = retained ? [retained, target] : [target];
  return (
    <>
      {frames.map((source) => {
        const current = source.key === target.key;
        return (
          <iframe
            key={source.key}
            ref={current ? attach : undefined}
            src={`${source.url}#avb-design`}
            title={current ? title : translate('preview.frame.previous', { title })}
            aria-hidden={!current}
            tabIndex={current ? undefined : -1}
            style={{
              visibility: current && retained ? 'hidden' : 'visible',
              pointerEvents: current ? undefined : 'none',
            }}
            onLoad={(event) => {
              if (!current || latest.current !== source.key) {
                return;
              }
              setShown(source);
              onLoad(event);
            }}
          />
        );
      })}
    </>
  );
}

function useFrameReady(
  target: FrameSource,
  forwardedRef: React.ForwardedRef<HTMLIFrameElement> | undefined,
  show: React.Dispatch<React.SetStateAction<FrameSource | undefined>>,
) {
  const frame = useRef<HTMLIFrameElement>();
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>): void => {
      if (!frame.current || event.source !== frame.current.contentWindow) {
        return;
      }
      if (parsePreviewMessage(event.data)?.kind === 'canvas-ready') {
        // The preload announces this after parsing and mapping the document.
        // Waiting for load instead also waits for images and embedded resources.
        show(target);
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [target, show]);
  const attach = useCallback<React.RefCallback<HTMLIFrameElement>>(
    (element): void => {
      frame.current = element ?? undefined;
      if (typeof forwardedRef === 'function') {
        forwardedRef(element);
      } else if (forwardedRef) {
        forwardedRef.current = element;
      }
    },
    [forwardedRef],
  );
  const element = useCallback(() => frame.current, []);
  return { attach, element };
}
