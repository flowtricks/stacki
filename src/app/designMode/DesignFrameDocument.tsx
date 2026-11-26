// Design mode (experimental, removable: docs/design-mode/REMOVE.md): the document a frame shows.
//
// A same-origin iframe with scripts off, in this renderer's own process: eight frames are eight documents, not eight
// processes. A new snapshot loads beside the shown one, hidden, and takes its place once loaded, so a frame never
// flashes white while it is edited. The frame is as tall as its page.
import { useEffect, useRef, useState } from 'react';
import { DESIGN_FRAME_WINDOW_NAME } from '../../../shared/ipc/designSnapshot';

/** The tallest a frame is drawn: past this a page is cut off on the canvas. */
export const FRAME_HEIGHT_PX_MAX = 30_000;
/** A page's height settles as its pictures arrive: measured at load, then at these delays after it. */
const MEASURE_AGAIN_MS = [250, 1_000, 3_000] as const;

export interface FrameMeasure {
  readonly document: Document;
  readonly heightPx: number;
  /** Counts up with every load and re-measure, so what is drawn over the frame is drawn again. */
  readonly revision: number;
}

interface Layer {
  readonly key: number;
  readonly html: string;
}

export function DesignFrameDocument({
  html,
  title,
  widthPx,
  heightPx,
  onMeasure,
}: {
  readonly html: string;
  readonly title: string;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly onMeasure: (measure: FrameMeasure) => void;
}) {
  // The shown document, and the one loading over it when the snapshot changed.
  const [layers, setLayers] = useState<{ readonly shown: Layer; readonly next: Layer | undefined }>(() => ({
    shown: { key: 0, html },
    next: undefined,
  }));
  useEffect(() => {
    setLayers((current) => {
      const latest = current.next ?? current.shown;
      return latest.html === html ? current : { shown: current.shown, next: { key: latest.key + 1, html } };
    });
  }, [html]);
  const timers = useRef<number[]>([]);
  const revision = useRef(0);
  useEffect(() => () => timers.current.forEach((timer) => window.clearTimeout(timer)), []);
  const measure = (frame: HTMLIFrameElement): void => {
    const document = frame.contentDocument ?? undefined;
    if (document === undefined || !frame.isConnected || document.body === null) {
      return;
    }
    const measured = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    revision.current += 1;
    onMeasure({ document, heightPx: Math.min(FRAME_HEIGHT_PX_MAX, Math.max(1, measured)), revision: revision.current });
  };
  const loaded = (layer: Layer, frame: HTMLIFrameElement): void => {
    setLayers((current) => (current.next?.key === layer.key ? { shown: current.next, next: undefined } : current));
    timers.current.forEach((timer) => window.clearTimeout(timer));
    measure(frame);
    timers.current = MEASURE_AGAIN_MS.map((delay) => window.setTimeout(() => measure(frame), delay));
  };
  return (
    <>
      {[layers.shown, layers.next].map((layer) =>
        layer === undefined ? undefined : (
          <iframe
            key={layer.key}
            name={DESIGN_FRAME_WINDOW_NAME}
            title={title}
            className="dm-document"
            // Scripts stay off; same origin so the canvas can read which element is under the pointer.
            sandbox="allow-same-origin"
            srcDoc={layer.html}
            tabIndex={-1}
            style={{ width: widthPx, height: heightPx, visibility: layer === layers.next ? 'hidden' : 'visible' }}
            onLoad={(event) => loaded(layer, event.currentTarget)}
          />
        ),
      )}
    </>
  );
}
