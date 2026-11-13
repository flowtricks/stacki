import { useEffect, useRef, useState } from 'react';
import { GearIcon } from '../../ui/Icons';
import PanelSheet from './components/PanelSheet';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { easingToBezier, bezierToEasing, isEasing } from './model/transition';
import VariableConnect from './VariableConnect';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../lib/i18n/localeContext';

// A cubic-bezier easing editor (Webflow-style): preset curves on the left, a large
// draggable curve on the right. Dragging either control point (or picking a preset)
// updates the timing-function; the curve maps the CSS bezier onto a 0→1 grid with
// progress increasing upward, so control points may overshoot above/below the box.

type Bezier = [number, number, number, number];

const PRESETS: ReadonlyArray<{
  heading: string;
  items: ReadonlyArray<{ label: string; b: Bezier }>;
}> = [
  {
    heading: 'Default', // i18n-ignore: an id compared by value; the shown text comes from the catalog.
    items: [
      { label: 'Linear', b: [0, 0, 1, 1] }, // i18n-ignore: standard easing curve name.
      { label: 'Ease', b: [0.25, 0.1, 0.25, 1] }, // i18n-ignore: standard easing curve name.
      { label: 'Ease In Out', b: [0.42, 0, 0.58, 1] }, // i18n-ignore: standard easing curve name.
    ],
  },
  {
    heading: 'Ease In', // i18n-ignore: standard easing family name.
    items: [
      { label: 'Sine', b: [0.12, 0, 0.39, 0] }, // i18n-ignore: standard easing curve name.
      { label: 'Quad', b: [0.11, 0, 0.5, 0] }, // i18n-ignore: standard easing curve name.
      { label: 'Cubic', b: [0.32, 0, 0.67, 0] }, // i18n-ignore: standard easing curve name.
      { label: 'Quart', b: [0.5, 0, 0.75, 0] }, // i18n-ignore: standard easing curve name.
      { label: 'Quint', b: [0.64, 0, 0.78, 0] }, // i18n-ignore: standard easing curve name.
      { label: 'Expo', b: [0.7, 0, 0.84, 0] }, // i18n-ignore: standard easing curve name.
      { label: 'Circ', b: [0.55, 0, 1, 0.45] }, // i18n-ignore: standard easing curve name.
      { label: 'Back', b: [0.36, 0, 0.66, -0.56] }, // i18n-ignore: standard easing curve name.
    ],
  },
  {
    heading: 'Ease Out', // i18n-ignore: standard easing family name.
    items: [
      { label: 'Sine', b: [0.61, 1, 0.88, 1] }, // i18n-ignore: standard easing curve name.
      { label: 'Quad', b: [0.5, 1, 0.89, 1] }, // i18n-ignore: standard easing curve name.
      { label: 'Cubic', b: [0.33, 1, 0.68, 1] }, // i18n-ignore: standard easing curve name.
      { label: 'Quart', b: [0.25, 1, 0.5, 1] }, // i18n-ignore: standard easing curve name.
      { label: 'Quint', b: [0.22, 1, 0.36, 1] }, // i18n-ignore: standard easing curve name.
      { label: 'Expo', b: [0.16, 1, 0.3, 1] }, // i18n-ignore: standard easing curve name.
      { label: 'Circ', b: [0, 0.55, 0.45, 1] }, // i18n-ignore: standard easing curve name.
      { label: 'Back', b: [0.34, 1.56, 0.64, 1] }, // i18n-ignore: standard easing curve name.
    ],
  },
  {
    heading: 'Ease In Out', // i18n-ignore: standard easing family name.
    items: [
      { label: 'Sine', b: [0.37, 0, 0.63, 1] }, // i18n-ignore: standard easing curve name.
      { label: 'Quad', b: [0.45, 0, 0.55, 1] }, // i18n-ignore: standard easing curve name.
      { label: 'Cubic', b: [0.65, 0, 0.35, 1] }, // i18n-ignore: standard easing curve name.
      { label: 'Quart', b: [0.76, 0, 0.24, 1] }, // i18n-ignore: standard easing curve name.
      { label: 'Quint', b: [0.83, 0, 0.17, 1] }, // i18n-ignore: standard easing curve name.
      { label: 'Expo', b: [0.87, 0, 0.13, 1] }, // i18n-ignore: standard easing curve name.
      { label: 'Circ', b: [0.85, 0, 0.15, 1] }, // i18n-ignore: standard easing curve name.
      { label: 'Back', b: [0.68, -0.6, 0.32, 1.6] }, // i18n-ignore: standard easing curve name.
    ],
  },
];

// Where a framed modal actually goes. The caller passes the box of the panel it
// belongs over, and that box is trusted only as far as the window: a panel
// wider than the viewport (or one measured while the layout was mid-change)
// would otherwise put the modal partly or wholly off-screen, and take the app's
// layout with it — an absolutely positioned box hanging past the right edge
// gives the document something to scroll.
const EDGE = 8;
// Wide enough for the curve (280px) and a row of preset thumbnails (8 x 46 plus
// gaps), and no wider: filling the panel made a dialog the size of the sheet it
// was opened over.
const IDEAL_WIDTH = 480;
function framedStyle(frame: { left: number; width: number }): { left: number; width: number } {
  const room = (typeof window === 'undefined' ? 0 : window.innerWidth) || frame.width || IDEAL_WIDTH;
  const panel = frame.width || room;
  const width = Math.max(320, Math.min(IDEAL_WIDTH, panel - EDGE * 2, room - EDGE * 2));
  // Centred in the panel it belongs to, then kept inside the window.
  const centred = (frame.left || 0) + (panel - width) / 2;
  const left = Math.max(EDGE, Math.min(centred, room - width - EDGE));
  return { left, width };
}

const bezEq = (left: Bezier, right: Bezier) => left.every((coordinate, i) => Math.abs(coordinate - (right[i] ?? 0)) < 0.005);
const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));
// One coordinate of the unit cubic-bezier (0,0)->(1,1) at parameter s.
// Each bisection halves the interval: 2⁻²⁴ is far finer than a rendered curve.
const BISECTION_PASSES_MAX = 24;
const bezAt = (parameter: number, firstControl: number, secondControl: number) =>
  3 * (1 - parameter) ** 2 * parameter * firstControl + 3 * (1 - parameter) * parameter ** 2 * secondControl + parameter ** 3;
// The eased PROGRESS (output) at input time t: solve x(s)=t for the parameter s, then
// read y(s). This is what makes the playback follow the ease — the parameter s is NOT
// time, so tracing the curve by s alone moves at the wrong (uniform) rate.
function easeProgress(time: number, x1: number, y1: number, x2: number, y2: number): number {
  if (time <= 0) {
    return 0;
  }
  if (time >= 1) {
    return 1;
  }
  let lo = 0,
    hi = 1,
    parameter = time;
  for (let i = 0; i < BISECTION_PASSES_MAX; i += 1) {
    const x = bezAt(parameter, x1, x2);
    if (Math.abs(x - time) < 1e-4) {
      break;
    }
    if (x < time) {
      lo = parameter;
    } else {
      hi = parameter;
    }
    parameter = (lo + hi) / 2;
  }
  return bezAt(parameter, y1, y2);
}
// The matched preset's name ("Ease", "Ease In Sine"), else "Custom".
function presetName(bezier: Bezier, translate: Translator): string {
  for (const group of PRESETS) {
    for (const item of group.items) {
      if (bezEq(item.b, bezier)) {
        return group.heading === 'Default' ? item.label : `${group.heading} ${item.label}`;
      }
    }
  }
  return translate('style.easingEditor.custom');
}
const PlayIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
    <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.2" />
    <path d="M6.6 5.6l4 2.4-4 2.4z" fill="currentColor" />
  </svg>
);
const PauseIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
    <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.2" />
    <path d="M6.4 5.5v5M9.6 5.5v5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

// A small preview curve for a preset button (unit bezier drawn in a 24×24 box).
/** The curve itself, at glyph size: a preset's thumbnail here, and the icon on
 *  the button that opens this editor from the variables sheet. */
export function MiniCurve({ b: bezier }: { b: Bezier }) {
  const size = 24;
  const point = (x: number, y: number) => `${(x * size).toFixed(1)} ${(size - y * size).toFixed(1)}`;
  return (
    <svg viewBox={`-3 -8 ${size + 6} ${size + 16}`} className="embed-editor_ease-mini" aria-hidden="true">
      <path
        d={`M ${point(0, 0)} C ${point(bezier[0], bezier[1])} ` + `${point(bezier[2], bezier[3])} ${point(1, 1)}`}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function BezierEditor({ value, onChange, playTime }: { value: Bezier; onChange: (b: Bezier) => void; playTime: number | undefined }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const areaRef = useRef<SVGRectElement>(null);
  const [drag, setDrag] = useState<0 | 1 | undefined>(undefined);
  const playPoint = playTime === undefined ? undefined : playPointAt(playTime, value);

  const move = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (drag === undefined) {
      return;
    }
    const rect = areaRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) {
      return;
    }
    const x = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const y = clamp(1 - (event.clientY - rect.top) / rect.height, -1, 2);
    const next: Bezier = [...value];
    next[drag * 2] = Math.round(x * 100) / 100;
    next[drag * 2 + 1] = Math.round(y * 100) / 100;
    onChange(next);
  };

  return (
    <svg
      ref={svgRef}
      viewBox={`-58 -90 ${CURVE_SIZE + 100} ${CURVE_SIZE + 210}`}
      className="embed-editor_ease-curve"
      onPointerMove={move}
      onPointerUp={() => setDrag(undefined)}
    >
      <rect ref={areaRef} x="0" y="0" width={CURVE_SIZE} height={CURVE_SIZE} className="embed-editor_ease-grid" />
      <CurveAxes />
      <CurveLines value={value} />
      {playPoint ? <CurvePlayhead point={playPoint} /> : undefined}
      {/* Draggable control points. */}
      {([0, 1] as const).map((i) => (
        <circle
          key={i}
          cx={curveX(value[i === 0 ? 0 : 2])}
          cy={curveY(value[i === 0 ? 1 : 3])}
          r="7"
          className="embed-editor_ease-handle"
          onPointerDown={(event) => {
            event.preventDefault();
            setDrag(i);
            svgRef.current?.setPointerCapture(event.pointerId);
          }}
        />
      ))}
    </svg>
  );
}

// The play point: x is linear elapsed time; y is the EASED progress at that time (so the
// dot rides the curve and the right-edge playhead slides up at the eased rate, not
// uniformly).
function playPointAt(playTime: number, value: Bezier): { x: number; y: number } {
  const progress = easeProgress(playTime, value[0], value[1], value[2], value[3]);
  return { x: curveX(playTime), y: curveY(progress) };
}

// The curve's drawing box, in SVG units, and the unit square mapped onto it (y up).
const CURVE_SIZE = 280;
const curveX = (x: number) => x * CURVE_SIZE;
const curveY = (y: number) => CURVE_SIZE - y * CURVE_SIZE;

// The axis captions and the 8×8 grid.
function CurveAxes() {
  return (
    <>
      <text transform={`translate(-34 ${CURVE_SIZE / 2}) rotate(-90)`} textAnchor="middle" className="embed-editor_ease-axis">
        PROGRESS
      </text>
      <text x={CURVE_SIZE / 2} y={CURVE_SIZE + 42} textAnchor="middle" className="embed-editor_ease-axis">
        TIME
      </text>
      {[1, 2, 3, 4, 5, 6, 7].map((i) => (
        <g key={i} className="embed-editor_ease-gridline">
          <line x1={(CURVE_SIZE / 8) * i} y1="0" x2={(CURVE_SIZE / 8) * i} y2={CURVE_SIZE} />
          <line x1="0" y1={(CURVE_SIZE / 8) * i} x2={CURVE_SIZE} y2={(CURVE_SIZE / 8) * i} />
        </g>
      ))}
    </>
  );
}

// The handle guide lines and the easing curve itself.
function CurveLines({ value }: { value: Bezier }) {
  return (
    <>
      {/* Handle guide lines from the endpoints to the control points. */}
      <line x1={curveX(0)} y1={curveY(0)} x2={curveX(value[0])} y2={curveY(value[1])} className="embed-editor_ease-handle-line" />
      <line x1={curveX(1)} y1={curveY(1)} x2={curveX(value[2])} y2={curveY(value[3])} className="embed-editor_ease-handle-line" />
      {/* The easing curve. */}
      <path
        d={`M ${curveX(0)} ${curveY(0)} C ${curveX(value[0])} ${curveY(value[1])} ` + `${curveX(value[2])} ${curveY(value[3])} ${curveX(1)} ${curveY(1)}`}
        className="embed-editor_ease-path"
      />
    </>
  );
}

// The playhead on the right edge — it slides up with the current progress — and the
// play-preview dot tracing the curve.
function CurvePlayhead({ point }: { point: { x: number; y: number } }) {
  const size = CURVE_SIZE;
  return (
    <>
      <polygon
        points={`${size},${point.y} ${size + 9},${point.y - 9} ${size + 27},${point.y - 9} ` + `${size + 27},${point.y + 9} ${size + 9},${point.y + 9}`}
        className="embed-editor_ease-playhead"
      />
      <circle cx={point.x} cy={point.y} r="6" className="embed-editor_ease-play-dot" />
    </>
  );
}

// The looping preview: the playhead + dot trace the easing. It LOOPS — play → brief
// hold → restart — until paused (matching Webflow); the button toggles play/pause.
function usePlayback() {
  const [playTime, setPlayTime] = useState<number | undefined>(undefined);
  const [playing, setPlaying] = useState(false);
  const playRaf = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      if (playRaf.current !== undefined) {
        cancelAnimationFrame(playRaf.current);
      }
    },
    [],
  );
  const stopPlay = () => {
    if (playRaf.current !== undefined) {
      cancelAnimationFrame(playRaf.current);
      playRaf.current = undefined;
    }
    setPlaying(false);
    setPlayTime(undefined);
  };
  const startPlay = () => {
    setPlaying(true);
    const DUR = 1200,
      HOLD = 350;
    let start = performance.now();
    const step = (now: number) => {
      const elapsed = now - start;
      if (elapsed < DUR) {
        setPlayTime(elapsed / DUR);
      } else if (elapsed < DUR + HOLD) {
        setPlayTime(1);
      } else {
        start = now;
        setPlayTime(0);
      }
      playRaf.current = requestAnimationFrame(step);
    };
    playRaf.current = requestAnimationFrame(step);
  };
  const togglePlay = () => {
    if (playing) {
      stopPlay();
    } else {
      startPlay();
    }
  };
  return { playTime, playing, togglePlay };
}

export default function EasingEditor({
  value,
  onClose,
  onChange,
  frame,
}: {
  value: string;
  onClose: () => void;
  onChange: (timing: string) => void;
  /** Where to put the modal, when it belongs over one panel rather than the
   *  window. The style panel opens it full width (its own panel IS the width);
   *  the variables sheet passes its own box so the editor covers the sheet it
   *  was opened from instead of the panel beside it. */
  frame?: { left: number; width: number };
}) {
  const translate = useTranslate();
  const [bezier, setBezier] = useState<Bezier>(() => easingToBezier(value));
  // What is being typed into the value field, until it is committed. Undefined while
  // the field simply shows the curve.
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const { playTime, playing, togglePlay } = usePlayback();
  const apply = (next: Bezier) => {
    setDraft(undefined);
    setBezier(next);
    onChange(bezierToEasing(next));
  };

  return (
    <PanelSheet
      className={`embed-editor_ease-modal u-surface-surface${frame ? ' is-framed' : ''}`}
      style={frame ? framedStyle(frame) : undefined}
      label={translate('style.easingEditor.easingEditor')}
      onClose={onClose}
    >
      {({ close }) => (
        <>
          <EasingHeader onClose={close} />
          <div className="embed-editor_ease-body">
            <div className="embed-editor_ease-main">
              <div className="embed-editor_ease-main-head">
                <button
                  type="button"
                  className={`embed-editor_ease-play ${playing ? 'is-playing' : ''}`}
                  onClick={togglePlay}
                  aria-label={playing ? translate('style.easingEditor.pausePreview') : translate('style.easingEditor.previewEasing')}
                >
                  {playing ? <PauseIcon /> : <PlayIcon />}
                </button>
                <span className="embed-editor_ease-name">{presetName(bezier, translate)}</span>
              </div>
              <BezierEditor value={bezier} onChange={apply} playTime={playTime} />
              <EasingValueField bezier={bezier} draft={draft} setDraft={setDraft} apply={apply} />
            </div>
            <EasingPresets bezier={bezier} apply={apply} />
          </div>
        </>
      )}
    </PanelSheet>
  );
}

// The header is the editor's drag handle (see PanelSheet): it opens over the
// variables window it was launched from, and has to be moved to see that window.
function EasingHeader({ onClose }: { onClose: () => void }) {
  const translate = useTranslate();
  return (
    <header className="embed-editor_ease-head" data-floating-drag-handle="">
      <span className="embed-editor_ease-title">
        <GearIcon size={16} /> {translate('style.easingEditor.title')}
      </span>
      <button type="button" className="embed-editor_icon-btn" onClick={onClose} aria-label={translate('ui.close')}>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
    </header>
  );
}

// The value as text, editable: the same code field the variables sheet uses, so it is
// coloured as you read it and a curve can be typed or pasted rather than only dragged.
// A value that is not a curve the editor can show (a steps(), a half-typed one) reverts
// on commit — the curve above it is the source of truth.
function EasingValueField({
  bezier,
  draft,
  setDraft,
  apply,
}: {
  bezier: Bezier;
  draft: string | undefined;
  setDraft: (draft: string | undefined) => void;
  apply: (next: Bezier) => void;
}) {
  const translate = useTranslate();
  /** Take what was typed, if it is a curve this editor can show. */
  const commitText = () => {
    const text = (draft ?? '').trim();
    setDraft(undefined);
    if (!text || !isEasing(text)) {
      return;
    }
    apply(easingToBezier(text));
  };
  return (
    <div className="embed-editor_ease-value">
      <VariableConnect
        className="is-fill"
        code
        prop="transition-timing-function"
        ariaLabel={translate('style.easingEditor.timingFunction')}
        onPick={(binding) => setDraft(binding)}
      >
        <input
          className="u-input embed-editor_ease-input"
          value={draft ?? bezierToEasing(bezier)}
          spellCheck={false}
          aria-label={translate('style.easingEditor.timingFunction')}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => commitText()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitText();
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              setDraft(undefined);
            }
          }}
        />
      </VariableConnect>
    </div>
  );
}

function EasingPresets({ bezier, apply }: { bezier: Bezier; apply: (next: Bezier) => void }) {
  const translate = useTranslate();
  return (
    <div className="embed-editor_ease-presets">
      {PRESETS.map((group) => (
        <div key={group.heading} className="embed-editor_ease-group">
          <h4 className="embed-editor_ease-group-title">{group.heading === 'Default' ? translate('style.easingEditor.defaultHeading') : group.heading}</h4>
          <div className="embed-editor_ease-grid-presets">
            {group.items.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className={'embed-editor_ease-preset ' + (bezEq(preset.b, bezier) ? 'is-active' : '')}
                title={group.heading === 'Default' ? preset.label : `${group.heading} ${preset.label}`}
                onClick={() => apply(preset.b)}
              >
                <MiniCurve b={preset.b} />
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
