// The crosshair region selector: a layer over the whole window, so a region can cover the canvas or any
// Stacki panel. Drag to pick, release to take it, Escape or a right click cancels. It unmounts before
// the capture, so it never appears in the picture. The size of the region shows at its corner while dragging.
// Recording uses this same selector: nothing records until the drag is released.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { WindowRect } from '../../../lib/screenshotSource';
import { useFormat, useTranslate } from '../../../lib/i18n/useTranslate';

/** A drag shorter than this each way is a click, not a region: nothing is captured and the selector stays. */
const REGION_PX_MIN = 4;

interface Point {
  readonly x: number;
  readonly y: number;
}

export function RegionSelector({ onDone }: { readonly onDone: (region: WindowRect | undefined) => void }) {
  const translate = useTranslate();
  const format = useFormat();
  const layer = useRef<HTMLDivElement>(null);
  const [start, setStart] = useState<Point | undefined>(undefined);
  const [end, setEnd] = useState<Point | undefined>(undefined);
  useEffect(() => {
    layer.current?.focus();
    // Captured on the window so Escape cancels even when focus is in a text field behind the layer.
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onDone(undefined);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onDone]);
  const region = start !== undefined && end !== undefined ? rectBetween(start, end) : undefined;
  return createPortal(
    <div
      ref={layer}
      className="ai-region-layer"
      role="dialog"
      aria-label={translate('ai.screenshot.regionLabel')}
      tabIndex={-1}
      onContextMenu={(event) => {
        event.preventDefault();
        onDone(undefined);
      }}
      onPointerDown={(event) => {
        if (event.button === 0) {
          event.currentTarget.setPointerCapture(event.pointerId);
          setStart({ x: event.clientX, y: event.clientY });
          setEnd({ x: event.clientX, y: event.clientY });
        }
      }}
      onPointerMove={(event) => {
        if (start !== undefined) {
          setEnd({ x: event.clientX, y: event.clientY });
        }
      }}
      onPointerUp={(event) => {
        if (start === undefined) {
          return;
        }
        const picked = rectBetween(start, { x: event.clientX, y: event.clientY });
        setStart(undefined);
        setEnd(undefined);
        if (picked.width >= REGION_PX_MIN) {
          if (picked.height >= REGION_PX_MIN) {
            onDone(picked);
          }
        }
      }}
    >
      {region === undefined ? (
        <div className="ai-region-hint">{translate('ai.screenshot.hint')}</div>
      ) : (
        <div className="ai-region-box" style={{ left: region.x, top: region.y, width: region.width, height: region.height }}>
          <span className="ai-region-size">{`${format.formatNumber(Math.round(region.width))} × ${format.formatNumber(Math.round(region.height))}`}</span>
        </div>
      )}
    </div>,
    document.body,
  );
}

function rectBetween(from: Point, to: Point): WindowRect {
  const x = Math.min(from.x, to.x);
  const y = Math.min(from.y, to.y);
  return { x, y, width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y) };
}
