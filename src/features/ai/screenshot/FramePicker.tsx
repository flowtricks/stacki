// The "Pick frames" sheet after a recording, compact and balanced:
//
//   header     title, and "N of 8 selected" as a small pill
//   preview    the whole current frame, never cropped: a box of the recording's own aspect fitted inside a stage of
//              fixed size (fitContain), so every frame shows at one size and nothing moves while scrubbing
//   controls   play or pause, the time on one line, previous and next, "Use this frame", "Pick evenly"
//   timeline   the WHOLE recording across the strip's width, never scrolled: as many thumbnail tiles as fit, each
//              showing the frame at its place, a thin playhead line, blue ticks above for the chosen frames and a
//              time scale beneath. Press anywhere to jump, drag to scrub continuously across every real frame.
//   footer     Discard, and "Add N frames to chat"
//
// Keys (told to assistive technology through aria-keyshortcuts, never printed): the arrows step one frame and
// Shift with an arrow ten (mirrored in right-to-left), Home and End jump, Space plays or pauses, Enter toggles
// "use this frame", Escape closes (discards). Shift-click on the timeline adds the range from the last frame toggled.
//
// Why a drag is cheap (FramePicker drag test): every thumbnail is decoded once, up front, into an object URL; the
// strip's box is read once when a drag starts; each move is arithmetic (x to frame index), and at most once per
// animation frame the playhead's transform, the preview's source and the time label are written to the DOM
// directly. Nothing awaits IPC during a drag and React renders nothing per move; the frame is committed to state
// when the drag ends. Full frames are fetched around the playhead when it rests (or a drag pauses for
// SCRUB_REST_MS) into a bounded cache (FULL_FRAMES_CACHED); until a frame's own is there, a full neighbour within
// SHARP_NEIGHBOUR_FRAMES stands in, else its 640 px thumbnail, in the same box. A click toggles the frame.
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { assert } from '../../../../shared/core/assert';
import type { RecordedFrame } from '../../../../shared/ipc/aiChat';
import { centralIcon } from '../../../ui/central/CentralIcon';
import {
  check as centralCheck,
  chevronDown as centralChevronDown,
  chevronLeft as centralChevronLeft,
  chevronRight as centralChevronRight,
  play as centralPlay,
  stop as centralStop,
} from '../../../ui/central/centralGeometry';
import Menu, { useMenuTrigger } from '../../../ui/Menu';
import Popup from '../../../ui/Popup';
import { useFormat, useTranslate } from '../../../lib/i18n/useTranslate';
import { aiRecord } from '../aiBridge';
import { EMPTY_SELECTION, everyNth, extendTo, toggleFrame, type FrameSelection } from './frameSelection';

const CheckGlyph = centralIcon(centralCheck);
const ChevronDownGlyph = centralIcon(centralChevronDown);
const PreviousGlyph = centralIcon(centralChevronLeft);
const NextGlyph = centralIcon(centralChevronRight);
const PlayGlyph = centralIcon(centralPlay);
const PauseGlyph = centralIcon(centralStop);

/** The steps "Pick evenly" offers. */
const EVERY_STEPS = [2, 3, 5, 10] as const;
/**
 * Full frames kept for the preview, as their JPEG bytes in object URLs (about 100 KB each, so about 2.5 MB at most),
 * pre-decoded by the browser with `decode()`: the playhead's frame and up to FULL_FRAMES_AROUND each side. Decoded
 * bitmaps of that many 1600 px frames would cost about 150 MB; the compressed bytes keep the sheet light.
 */
export const FULL_FRAMES_CACHED = 24;
/** Frames each side of the playhead fetched once it rests. */
const FULL_FRAMES_AROUND = 10;
/** A full neighbour this close is shown, sharp, instead of a thumbnail, while the exact frame loads. */
const SHARP_NEIGHBOUR_FRAMES = 3;
/** A pause this long in a drag fetches the exact frame. */
const SCRUB_REST_MS = 60;
/** A press that moves no further than this is a click. */
const CLICK_SLOP_PX = 4;
/** Frames the arrows move with Shift held. */
const SHIFT_STEP_FRAMES = 10;
/** The stage's height (screenshot.css) and the widths assumed before anything is measured. */
const STAGE_HEIGHT_PX = 360;
const STAGE_WIDTH_UNMEASURED_PX = 640;
const TIMELINE_WIDTH_UNMEASURED_PX = 640;
/** A timeline tile's height; its width follows the recording's aspect, within TILE_WIDTH_PX bounds. */
const TILE_HEIGHT_PX = 40;
const TILE_WIDTH_PX = { min: 14, max: 96 } as const;
/** Labels on the time scale beneath the timeline: start, end and a few between. */
const SCALE_LABELS = 5;

export function FramePicker({
  projectPath,
  id,
  frames,
  fps,
  cap,
  onAdd,
  onGone,
  onDiscard,
}: {
  readonly projectPath: string;
  readonly id: string;
  readonly frames: readonly RecordedFrame[];
  readonly fps: number;
  /** Frames the draft can still take. */
  readonly cap: number;
  readonly onAdd: (chosen: readonly RecordedFrame[]) => void;
  /** The recording was freed in main (it can no longer be read): the caller says so in a toast and closes the sheet. */
  readonly onGone: () => void;
  readonly onDiscard: () => void;
}) {
  const translate = useTranslate();
  const format = useFormat();
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selection, setSelection] = useState<FrameSelection>(EMPTY_SELECTION);
  const thumbs = useThumbnailURLs(frames);
  useKeepAlive(projectPath, id, onGone);
  const full = useFullFrames(projectPath, id, frames, { current, resting: !playing });
  // The sharpest picture there is for a frame: its own full frame, else a full neighbour within SHARP_NEIGHBOUR_FRAMES,
  // else its thumbnail (640 px, sharp enough at the preview's size).
  const pictureFor = (index: number): string | undefined => full.get(index) ?? full.nearest(index, SHARP_NEIGHBOUR_FRAMES) ?? thumbs[index];
  const evenly = useMenuTrigger();
  const frame = frames[current];
  const first = frames[0];
  const last = Math.max(0, frames.length - 1);
  const seconds = useCallback((atMs: number): string => format.formatNumber(atMs / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 }), [format]);
  const stage = useMeasuredBox<HTMLDivElement>({ width: STAGE_WIDTH_UNMEASURED_PX, height: STAGE_HEIGHT_PX });
  const timeline = useMeasuredBox<HTMLDivElement>({ width: TIMELINE_WIDTH_UNMEASURED_PX, height: TILE_HEIGHT_PX });
  const fitted = first === undefined ? { width: 0, height: 0 } : fitContain(first, stage.box);
  const tileWidth = first === undefined ? TILE_WIDTH_PX.min : tileWidthFor(first);
  const tiles = useMemo(
    () => timelineTiles(frames.length, Math.max(1, Math.floor(timeline.box.width / tileWidth))),
    [frames.length, timeline.box.width, tileWidth],
  );
  // The loop: one step per captured frame interval while playing.
  useEffect(() => {
    if (!playing || frames.length < 2) {
      return undefined;
    }
    const step = setInterval(() => setCurrent((index) => (index >= last ? 0 : index + 1)), Math.max(66, Math.round(1000 / Math.max(1, fps))));
    return () => clearInterval(step);
  }, [playing, frames.length, last, fps]);
  const move = (index: number): void => setCurrent(Math.min(last, Math.max(0, index)));
  const toggle = (index: number, how: { readonly extend: boolean }): void => {
    setSelection((now) => (how.extend ? extendTo(now, index, cap) : toggleFrame(now, index, cap)).selection);
    move(index);
  };
  const rtl = (): boolean => timeline.ref.current !== null && getComputedStyle(timeline.ref.current).direction === 'rtl';
  const step = (by: number): void => {
    setPlaying(false);
    setCurrent((index) => Math.min(last, Math.max(0, index + by)));
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const forward = rtl() ? 'ArrowLeft' : 'ArrowRight';
    const back = rtl() ? 'ArrowRight' : 'ArrowLeft';
    if (event.key === forward || event.key === back) {
      event.preventDefault();
      const size = event.shiftKey ? SHIFT_STEP_FRAMES : 1;
      step(event.key === forward ? size : -size);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setPlaying(false);
      move(event.key === 'Home' ? 0 : last);
    } else if (event.key === ' ' && event.target === event.currentTarget) {
      event.preventDefault();
      setPlaying((now) => !now);
    } else if (event.key === 'Enter' && event.target === event.currentTarget) {
      event.preventDefault();
      toggle(current, { extend: event.shiftKey });
    }
  };
  // The drag: the box is read once at the press; each move is arithmetic and at most one DOM write per frame.
  const playhead = useRef<HTMLSpanElement>(null);
  const preview = useRef<HTMLImageElement>(null);
  const timeLabel = useRef<HTMLSpanElement>(null);
  const drag = useRef<
    | {
        readonly left: number;
        readonly width: number;
        readonly rtl: boolean;
        readonly startX: number;
        readonly extend: boolean;
        index: number;
        moved: boolean;
        pending: number | undefined;
        rest: ReturnType<typeof setTimeout> | undefined;
      }
    | undefined
  >(undefined);
  const paint = (index: number): void => {
    const target = frames[index];
    if (target === undefined) {
      return;
    }
    if (playhead.current !== null) {
      // A transform only: the playhead spans the strip and is moved by a share of its own width (screenshot.css).
      playhead.current.style.setProperty('--ai-playhead', `${positionPercent(index, frames.length)}%`);
    }
    if (preview.current !== null) {
      const source = pictureFor(index);
      if (source !== undefined && preview.current.getAttribute('src') !== source) {
        preview.current.src = source;
      }
    }
    if (timeLabel.current !== null) {
      timeLabel.current.textContent = translate('ai.record.elapsed', { seconds: seconds(target.atMs) });
    }
  };
  const indexAt = (clientX: number): number => {
    const box = drag.current;
    assert(box !== undefined, 'indexAt: only while pressed');
    return frameAt(box.rtl ? box.left + box.width - clientX : clientX - box.left, box.width, frames.length);
  };
  // A press only moves the playhead; releasing it within CLICK_SLOP_PX of where it began is a click, which toggles
  // that frame (Shift: the range from the last frame toggled). Anything further is a drag, which only scrubs.
  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    const box = event.currentTarget.getBoundingClientRect();
    drag.current = {
      left: box.left,
      width: Math.max(1, box.width),
      rtl: rtl(),
      startX: event.clientX,
      extend: event.shiftKey,
      index: current,
      moved: false,
      pending: undefined,
      rest: undefined,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setPlaying(false);
    drag.current.index = indexAt(event.clientX);
    paint(drag.current.index);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const pressed = drag.current;
    if (pressed === undefined) {
      return;
    }
    if (Math.abs(event.clientX - pressed.startX) > CLICK_SLOP_PX) {
      pressed.moved = true;
    }
    pressed.index = indexAt(event.clientX);
    if (pressed.pending === undefined) {
      pressed.pending = requestAnimationFrame(() => {
        pressed.pending = undefined;
        paint(pressed.index);
      });
    }
    // Resting mid-drag asks for the exact frame (and its neighbours), so a pause shows it sharp.
    clearTimeout(pressed.rest);
    pressed.rest = setTimeout(() => full.around(pressed.index), SCRUB_REST_MS);
  };
  const onPointerUp = (): void => {
    const pressed = drag.current;
    drag.current = undefined;
    if (pressed !== undefined) {
      if (pressed.pending !== undefined) {
        cancelAnimationFrame(pressed.pending);
      }
      clearTimeout(pressed.rest);
      if (pressed.moved) {
        move(pressed.index);
      } else {
        toggle(pressed.index, { extend: pressed.extend });
      }
    }
  };
  const chosen = selection.chosen;
  const isChosen = frame !== undefined && chosen.includes(frame.index);
  // While a drag runs, a render (a full frame arriving) shows the dragged frame, not the committed one.
  const showing = drag.current?.index ?? current;
  const shown = frames[showing] === undefined ? undefined : pictureFor(showing);
  return (
    <Popup className="modal ai-frame-picker" label={translate('ai.record.picker.title')} onClose={onDiscard}>
      <div
        className="ai-frame-sheet"
        tabIndex={0}
        onKeyDown={onKey}
        aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Home End Space Enter Escape"
      >
        <div className="ai-frame-head">
          <span className="ai-frame-title">{translate('ai.record.picker.title')}</span>
          <span className="ai-frame-count">{translate('ai.record.selected', { count: chosen.length, max: cap })}</span>
        </div>
        {frame === undefined || first === undefined ? (
          <div className="ai-frame-empty">{translate('ai.record.noFrames')}</div>
        ) : (
          <>
            <div ref={stage.ref} className="ai-frame-stage" data-frame={frame.index}>
              {shown !== undefined && (
                <img
                  ref={preview}
                  className="ai-frame-preview"
                  style={{ width: fitted.width, height: fitted.height }}
                  src={shown}
                  alt={translate('ai.record.frameLabel', { frame: current + 1, seconds: seconds(frame.atMs) })}
                />
              )}
            </div>
            <div className="ai-frame-controls">
              <button
                type="button"
                className="ghost ai-frame-icon"
                aria-label={playing ? translate('ai.record.pause') : translate('ai.record.play')}
                aria-pressed={playing}
                onClick={() => setPlaying((now) => !now)}
              >
                {playing ? <PauseGlyph size={14} /> : <PlayGlyph size={14} />}
              </button>
              <span ref={timeLabel} className="ai-frame-time">
                {translate('ai.record.elapsed', { seconds: seconds(frame.atMs) })}
              </span>
              <button
                type="button"
                className="ghost ai-frame-icon ai-frame-step"
                aria-label={translate('ai.record.previous')}
                disabled={current === 0}
                onClick={() => step(-1)}
              >
                <PreviousGlyph size={14} />
              </button>
              <button
                type="button"
                className="ghost ai-frame-icon ai-frame-step"
                aria-label={translate('ai.record.next')}
                disabled={current === last}
                onClick={() => step(1)}
              >
                <NextGlyph size={14} />
              </button>
              <span className="ai-frame-spacer" />
              <button
                type="button"
                className={`ai-frame-use${isChosen ? ' is-on' : ''}`}
                aria-pressed={isChosen}
                onClick={(event) => toggle(frame.index, { extend: event.shiftKey })}
              >
                <CheckGlyph size={14} />
                <span>{isChosen ? translate('ai.record.used') : translate('ai.record.use')}</span>
              </button>
              <button
                ref={evenly.ref}
                type="button"
                className={`ghost ai-frame-evenly${evenly.open ? ' is-open' : ''}`}
                aria-haspopup="menu"
                aria-expanded={evenly.open}
                onClick={evenly.toggle}
              >
                <span>{translate('ai.record.every.label')}</span>
                <ChevronDownGlyph size={12} />
              </button>
              <Menu
                open={evenly.open}
                anchor={evenly.anchor}
                label={translate('ai.record.every.label')}
                placement="above-end"
                onClose={evenly.close}
                entries={[
                  ...EVERY_STEPS.map((every) => ({
                    kind: 'item' as const,
                    id: `every-${every}`,
                    label: translate('ai.record.every.option', { count: every }),
                    onSelect: () => setSelection(everyNth(frames.length, every, cap).selection),
                  })),
                  {
                    kind: 'item' as const,
                    id: 'clear',
                    label: translate('ai.record.every.clear'),
                    disabled: chosen.length === 0,
                    onSelect: () => setSelection(EMPTY_SELECTION),
                  },
                ]}
              />
            </div>
            <div className="ai-frame-timeline">
              <div className="ai-frame-marks" aria-hidden="true">
                {chosen.map((index) => (
                  <span key={index} className="ai-frame-mark" style={{ insetInlineStart: `${positionPercent(index, frames.length)}%` }} />
                ))}
              </div>
              <div
                ref={timeline.ref}
                className="ai-frame-strip"
                role="slider"
                aria-label={translate('ai.record.timeline')}
                aria-valuemin={1}
                aria-valuemax={frames.length}
                aria-valuenow={current + 1}
                aria-valuetext={translate('ai.record.frameLabel', { frame: current + 1, seconds: seconds(frame.atMs) })}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
              >
                <TimelineTiles tiles={tiles} thumbs={thumbs} />
                <span ref={playhead} className="ai-frame-playhead" style={playheadStyle(positionPercent(showing, frames.length))} />
              </div>
              <TimeScale frames={frames} seconds={seconds} />
            </div>
          </>
        )}
        <div className="ai-frame-actions">
          <button type="button" className="ghost ai-frame-discard" onClick={onDiscard}>
            {translate('ai.record.discard')}
          </button>
          <button
            type="button"
            className="primary ai-frame-add"
            disabled={chosen.length === 0}
            onClick={() => onAdd(chosen.map((index) => frames[index]).filter((entry): entry is RecordedFrame => entry !== undefined))}
          >
            {translate('ai.record.add', { count: chosen.length })}
          </button>
        </div>
      </div>
    </Popup>
  );
}

// The tiles never change during a drag, so they render once per layout, not once per move.
const TimelineTiles = memo(function TimelineTiles({ tiles, thumbs }: { readonly tiles: readonly number[]; readonly thumbs: readonly string[] }) {
  return (
    <div className="ai-frame-tiles" aria-hidden="true">
      {tiles.map((index, tile) => (
        <img key={tile} className="ai-frame-tile" data-index={index} src={thumbs[index]} alt="" draggable={false} decoding="async" />
      ))}
    </div>
  );
});

// Start, end and a few times between, under the timeline.
function TimeScale({ frames, seconds }: { readonly frames: readonly RecordedFrame[]; readonly seconds: (atMs: number) => string }) {
  const end = frames.at(-1)?.atMs ?? 0;
  const labels = Array.from({ length: SCALE_LABELS }, (_, step) => Math.round((end * step) / (SCALE_LABELS - 1)));
  return (
    <div className="ai-frame-scale" aria-hidden="true">
      {labels.map((atMs, step) => (
        <span key={step} className="ai-frame-scale-tick" style={{ insetInlineStart: `${(step * 100) / (SCALE_LABELS - 1)}%` }}>
          {seconds(atMs)}
        </span>
      ))}
    </div>
  );
}

// The playhead's place as the custom property its transform reads (screenshot.css).
function playheadStyle(percent: number): CSSProperties & { readonly '--ai-playhead': string } {
  return { '--ai-playhead': `${percent}%` };
}

/** A timeline tile's width: the recording's aspect at the tile height, within reason; tiles are contained, never cropped. */
export function tileWidthFor(frame: Pick<RecordedFrame, 'width' | 'height'>): number {
  assert(frame.height >= 1, 'tileWidthFor: a frame has a height');
  return Math.min(TILE_WIDTH_PX.max, Math.max(TILE_WIDTH_PX.min, Math.round((TILE_HEIGHT_PX * frame.width) / frame.height)));
}

/** Which frame each of `tileCount` tiles shows, spread evenly over the whole recording, first and last included. */
export function timelineTiles(frameCount: number, tileCount: number): readonly number[] {
  assert(Number.isSafeInteger(frameCount), 'timelineTiles: a whole number of frames');
  assert(tileCount >= 1, 'timelineTiles: at least one tile');
  const count = Math.min(frameCount, tileCount);
  if (count <= 1) {
    return count === 1 ? [0] : [];
  }
  return Array.from({ length: count }, (_, tile) => Math.round((tile * (frameCount - 1)) / (count - 1)));
}

/** The frame under an offset from the timeline's inline start: the whole width addresses every real frame. */
export function frameAt(offsetPx: number, widthPx: number, frameCount: number): number {
  assert(widthPx > 0, 'frameAt: the timeline has a width');
  assert(frameCount >= 1, 'frameAt: there is a frame');
  const ratio = Math.min(1, Math.max(0, offsetPx / widthPx));
  return Math.min(frameCount - 1, Math.floor(ratio * frameCount));
}

/** Where a frame sits along the timeline, as a percentage from its inline start: the middle of its share. */
export function positionPercent(index: number, frameCount: number): number {
  assert(frameCount >= 1, 'positionPercent: there is a frame');
  return ((index + 0.5) * 100) / frameCount;
}

/**
 * The largest box of the frame's aspect that fits inside `box`, in whole pixels: the preview shows the entire frame
 * (contain), never a crop, whether the region was a narrow phone column or a wide banner.
 */
export function fitContain(
  frame: Pick<RecordedFrame, 'width' | 'height'>,
  box: { readonly width: number; readonly height: number },
): { readonly width: number; readonly height: number } {
  assert(frame.width >= 1, 'fitContain: a frame has a width');
  assert(frame.height >= 1, 'fitContain: a frame has a height');
  const scale = Math.min(box.width / frame.width, box.height / frame.height);
  // A hair of slack, so a side that scales to a whole number exactly is not floored one short by float error.
  return { width: Math.max(1, Math.floor(frame.width * scale + 1e-9)), height: Math.max(1, Math.floor(frame.height * scale + 1e-9)) };
}

// An element's size, read on mount and on resize only (never while scrubbing); `fallback` until it lays out.
function useMeasuredBox<T extends HTMLElement>(fallback: { readonly width: number; readonly height: number }) {
  const ref = useRef<T>(null);
  const [box, setBox] = useState(fallback);
  useEffect(() => {
    const element = ref.current;
    if (element === null) {
      return undefined;
    }
    const measure = (): void => {
      if (element.clientWidth > 0) {
        setBox({ width: element.clientWidth, height: element.clientHeight > 0 ? element.clientHeight : fallback.height });
      }
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
    // The fallback is a constant per call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `fallback` is a fresh literal each render with constant values.
  }, []);
  return { ref, box };
}

// Every thumbnail as an object URL made once (decoded ahead with `decode()` where the platform has it), so showing
// any frame while scrubbing is instant; revoked when the sheet closes. Data URLs where object URLs are unavailable.
function useThumbnailURLs(frames: readonly RecordedFrame[]): readonly string[] {
  const urls = useMemo(() => frames.map((frame) => imageURL(frame.thumb)), [frames]);
  useEffect(() => {
    for (const url of urls) {
      const image = document.createElement('img');
      image.src = url;
      if (typeof image.decode === 'function') {
        image.decode().catch(() => undefined);
      }
    }
    return () => urls.forEach(revokeURL);
  }, [urls]);
  return urls;
}

function imageURL(base64: string): string {
  if (typeof URL.createObjectURL !== 'function') {
    return `data:image/jpeg;base64,${base64}`;
  }
  const binary = atob(base64);
  const bytes = Uint8Array.from({ length: binary.length }, (_, index) => binary.charCodeAt(index));
  return URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
}

function revokeURL(url: string): void {
  if (url.startsWith('blob:')) {
    URL.revokeObjectURL(url);
  }
}

/** How often an open sheet tells main its recording is still in use, well inside main's stoppedKeepMs. */
const KEEP_ALIVE_MS = 60_000;

// While the sheet is open its recording is never freed for being left alone: a status read restarts main's lifetime
// for it. A recording main no longer has ends the sheet through `onGone`.
function useKeepAlive(projectPath: string, id: string, onGone: () => void): void {
  const gone = useRef(onGone);
  gone.current = onGone;
  useEffect(() => {
    const beat = setInterval(() => {
      void aiRecord({ projectPath, action: { kind: 'status', id } }).then((reply) => {
        if (!reply.ok) {
          gone.current();
        }
        return undefined;
      });
    }, KEEP_ALIVE_MS);
    return () => clearInterval(beat);
  }, [projectPath, id]);
}

// Full frames for the preview: once the playhead rests (or a drag pauses, through `around`), the frame there and then
// its neighbours outwards to FULL_FRAMES_AROUND, fetched one at a time, kept as object URLs and decoded ahead, in a
// cache that drops the frames farthest from the playhead beyond FULL_FRAMES_CACHED.
function useFullFrames(
  projectPath: string,
  id: string,
  frames: readonly RecordedFrame[],
  at: { readonly current: number; readonly resting: boolean },
): {
  readonly get: (index: number) => string | undefined;
  readonly nearest: (index: number, within: number) => string | undefined;
  readonly around: (index: number) => void;
} {
  const { current, resting } = at;
  const cache = useRef(new Map<number, string>());
  const asked = useRef(new Set<number>());
  // Bumped when a frame arrives, so the preview re-renders with it; the cache itself lives in the ref.
  const [, setArrived] = useState(0);
  const wanted = useRef<readonly number[]>([]);
  const mounted = useRef(true);
  const fetchOne = useCallback(
    async (index: number, centre: number): Promise<void> => {
      asked.current.add(index);
      const reply = await aiRecord({ projectPath, action: { kind: 'frame', id, index } });
      asked.current.delete(index);
      if (!mounted.current || !reply.ok || reply.value.kind !== 'frame') {
        return;
      }
      const url = imageURL(reply.value.image.data);
      const image = document.createElement('img');
      image.src = url;
      if (typeof image.decode === 'function') {
        await image.decode().catch(() => undefined);
      }
      if (!mounted.current) {
        revokeURL(url);
        return;
      }
      cache.current.set(index, url);
      trimmed(cache.current, centre);
      setArrived((count) => count + 1);
    },
    [projectPath, id],
  );
  const around = useCallback(
    (centre: number): void => {
      const order = [centre];
      for (let offset = 1; offset <= FULL_FRAMES_AROUND; offset += 1) {
        order.push(centre + offset, centre - offset);
      }
      wanted.current = order.filter((index) => index >= 0 && index < frames.length);
      const run = async (): Promise<void> => {
        const queue = wanted.current;
        // At most 2 × FULL_FRAMES_AROUND + 1 frames, one at a time; a newer centre replaces the queue.
        for (const index of queue) {
          if (wanted.current !== queue || !mounted.current) {
            return;
          }
          if (!cache.current.has(index) && !asked.current.has(index)) {
            await fetchOne(index, centre);
          }
        }
      };
      void run();
    },
    [frames.length, fetchOne],
  );
  useEffect(() => {
    mounted.current = true;
    const held = cache.current;
    return () => {
      mounted.current = false;
      held.forEach(revokeURL);
      held.clear();
    };
  }, []);
  useEffect(() => {
    if (!resting || frames.length === 0) {
      return undefined;
    }
    const rest = setTimeout(() => around(current), SCRUB_REST_MS);
    return () => clearTimeout(rest);
  }, [current, resting, frames.length, around]);
  return {
    get: (index) => cache.current.get(index),
    nearest: (index, within) => {
      for (let offset = 1; offset <= within; offset += 1) {
        const found = cache.current.get(index - offset) ?? cache.current.get(index + offset);
        if (found !== undefined) {
          return found;
        }
      }
      return undefined;
    },
    around,
  };
}

function trimmed(cache: Map<number, string>, current: number): void {
  // Bounded by FULL_FRAMES_CACHED; each pass drops one entry, so the loop ends within the cache's size.
  for (let pass = 0; cache.size > FULL_FRAMES_CACHED && pass < FULL_FRAMES_CACHED * 4; pass += 1) {
    const farthest = [...cache.keys()].reduce((far, index) => (Math.abs(index - current) > Math.abs(far - current) ? index : far));
    const url = cache.get(farthest);
    if (url !== undefined) {
      revokeURL(url);
    }
    cache.delete(farthest);
  }
}
