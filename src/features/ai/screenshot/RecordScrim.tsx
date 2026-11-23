// The dim that stays over the window while a recording runs: the same state the region drag showed (everything
// outside the dragged region greyed, the region itself clear), kept from the moment the drag is released until
// the recording stops or is cancelled. The window below stays fully usable: the scrim takes no pointer events, so
// the recorded region (and the rest of the app) responds as usual and the pointer is the ordinary one.
//
// Why it never reaches a frame: main photographs only the region (`capturePage` of its rect, already rounded
// outwards to whole pixels by clampToWindow), and the scrim has a hole over that rect, grown by HOLE_GUARD_PX on
// every side so zoom rounding and anti-aliased edges never bring a dimmed pixel into the crop. The hole is an SVG
// mask, so it needs no capture-time prepare/restore and costs nothing per frame. A second hole keeps the capture
// bar (the microphone, Screenshot and Record, with Record red) undimmed: it belongs to the recording's controls.
import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import type { WindowRect } from '../../../lib/screenshotSource';

/** Whole pixels the region's hole is grown by on each side; the crop is inside it, so nothing dimmed is photographed. */
export const HOLE_GUARD_PX = 2;
/** How often the capture bar's place is read again (it grows open, and the window may resize). */
const BAR_POLL_MS = 250;
/** Room around the capture bar's track so its rounded ends are not clipped by the rectangular hole. */
const BAR_PAD_PX = 2;
const CAPTURE_BAR_SELECTOR = '.ai-capture-track';

/** The region grown by `guard` on each side: the hole's rect. */
export function holeAround(region: WindowRect, guard: number = HOLE_GUARD_PX): WindowRect {
  return { x: region.x - guard, y: region.y - guard, width: region.width + guard * 2, height: region.height + guard * 2 };
}

export function RecordScrim({ region }: { readonly region: WindowRect }) {
  const maskId = `ai-record-mask-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const bar = useCaptureBarRect();
  const holes = bar === undefined ? [holeAround(region)] : [holeAround(region), holeAround(bar, BAR_PAD_PX)];
  return createPortal(
    <svg className="ai-record-scrim" aria-hidden="true" data-testid="ai-record-scrim">
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="100%" height="100%">
          <rect x="0" y="0" width="100%" height="100%" fill="white" />
          {holes.map((hole, index) => (
            <rect key={index} className="ai-record-scrim-hole" x={hole.x} y={hole.y} width={hole.width} height={hole.height} fill="black" />
          ))}
        </mask>
      </defs>
      <rect className="ai-record-scrim-fill" x="0" y="0" width="100%" height="100%" mask={`url(#${maskId})`} />
    </svg>,
    document.body,
  );
}

/** Where the capture bar's track is, read while the scrim is up; undefined when the bar is not on screen. */
function useCaptureBarRect(): WindowRect | undefined {
  const [rect, setRect] = useState<WindowRect | undefined>(undefined);
  useEffect(() => {
    const read = (): void => {
      const track = document.querySelector<HTMLElement>(CAPTURE_BAR_SELECTOR);
      const box = track?.getBoundingClientRect();
      const next = box === undefined || box.width < 1 || box.height < 1 ? undefined : roundedOut(box);
      setRect((previous) => (sameRect(previous, next) ? previous : next));
    };
    read();
    const poll = setInterval(read, BAR_POLL_MS);
    window.addEventListener('resize', read);
    return () => {
      clearInterval(poll);
      window.removeEventListener('resize', read);
    };
  }, []);
  return rect;
}

function roundedOut(box: DOMRect): WindowRect {
  const x = Math.floor(box.left);
  const y = Math.floor(box.top);
  return { x, y, width: Math.ceil(box.right) - x, height: Math.ceil(box.bottom) - y };
}

function sameRect(first: WindowRect | undefined, second: WindowRect | undefined): boolean {
  if (first === undefined || second === undefined) {
    return first === second;
  }
  return first.x === second.x && first.y === second.y && first.width === second.width && first.height === second.height;
}
