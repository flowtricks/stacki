// Design mode (experimental, removable: docs/design-mode/REMOVE.md): Compare, every frame side by side.
//
// Each frame is shown as its last picture (taken whenever the person leaves it, and kept with its draft), on a
// board that pans (drag, or scroll) and zooms (pinch, or Ctrl/Cmd with the wheel). Clicking a frame shows it in the
// editor. A frame never opened this session has no picture yet: its tile is a skeleton until it is.
import { useRef, useState, type PointerEvent, type WheelEvent } from 'react';
import type { DesignFrameId, DesignSessionState } from '../../../shared/ipc/designSession';
import { frameAction, type DesignHostSource } from './designActions';
import { updateDesignView } from './designStore';
import { useDesignWords } from './i18n/designWords';
import { useCanvasColumn } from './useCanvasColumn';

type OnSession = Extract<DesignSessionState, { kind: 'on' }>;

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 2;
/** A frame's width and the gap between frames on the board, as designMode.css draws them. */
const FRAME_WIDTH_PX = 1_200;
const FRAME_GAP_PX = 64;
const BOARD_MARGIN_PX = 32;
/** Room below the board's content for the bar. */
const BAR_ROOM_PX = 72;

export function DesignBoard({
  app,
  session,
  images,
}: {
  readonly app: DesignHostSource;
  readonly session: OnSession;
  readonly images: ReadonlyMap<DesignFrameId, string>;
}) {
  const words = useDesignWords();
  const column = useCanvasColumn();
  // Opens with every frame in view: as wide as the column allows, never larger than life.
  const [view, setView] = useState(() => {
    const count = Math.max(1, session.frames.length);
    const contentPx = count * FRAME_WIDTH_PX + (count - 1) * FRAME_GAP_PX;
    const widthPx = typeof column.width === 'number' ? column.width : 0;
    const zoom = Math.min(1, Math.max(ZOOM_MIN, (widthPx - 2 * BOARD_MARGIN_PX) / contentPx));
    return { x: BOARD_MARGIN_PX, y: BOARD_MARGIN_PX, zoom };
  });
  const drag = useRef<{ readonly x: number; readonly y: number; readonly startX: number; readonly startY: number } | undefined>(undefined);
  const onWheel = (event: WheelEvent<HTMLDivElement>): void => {
    if (event.ctrlKey || event.metaKey) {
      const factor = Math.exp(-event.deltaY / 300);
      setView((current) => ({ ...current, zoom: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, current.zoom * factor)) }));
    } else {
      setView((current) => ({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY }));
    }
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: view.x, y: view.y, startX: event.clientX, startY: event.clientY };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const start = drag.current;
    if (start !== undefined) {
      setView((current) => ({ ...current, x: start.x + event.clientX - start.startX, y: start.y + event.clientY - start.startY }));
    }
  };
  const open = (frame: DesignFrameId): void => {
    updateDesignView((current) => ({ ...current, board: 'closed' }));
    if (frame !== session.active) {
      void frameAction(app, words, { op: 'switch', frame });
    }
  };
  return (
    <div className="dm-board" style={{ ...column, paddingBottom: BAR_ROOM_PX }} aria-label={words('board.title')}>
      <div
        className="dm-board-plane"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => {
          drag.current = undefined;
        }}
      >
        <div className="dm-board-world" style={{ transform: `translate(${String(view.x)}px, ${String(view.y)}px) scale(${String(view.zoom)})` }}>
          {session.frames.map((frame) => {
            const image = images.get(frame.id);
            return (
              <button
                key={frame.id}
                type="button"
                className={frame.id === session.active ? 'dm-board-frame is-active' : 'dm-board-frame'}
                aria-label={words('board.open', { name: frame.name })}
                onClick={() => open(frame.id)}
              >
                <span className="dm-board-name">
                  <span>{frame.name}</span>
                  <span className="dm-board-count">
                    {frame.changedFiles === 0 ? words('frame.unchanged') : words('frame.changes', { count: frame.changedFiles })}
                  </span>
                </span>
                {image === undefined ? (
                  <span className="dm-board-skeleton ui-skeleton" aria-label={words('frame.noPicture')} />
                ) : (
                  <img className="dm-board-picture" src={image} alt={frame.name} draggable={false} />
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
