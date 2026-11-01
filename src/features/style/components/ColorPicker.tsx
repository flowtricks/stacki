import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Popup from '../../../ui/Popup';
import { colorMode, formatColor, formatHex, hsvaToRgba, parseColor, rgbaToHsl, rgbaToHsva, type ColorMode, type HSVA, type RGBA } from '../model/colorSpace';
import { dragNote, endDragNotes } from '../../../ui/sound';
import type { CSSProperties, RefObject } from 'react';

type EyeDropperConstructor = new () => { open: () => Promise<{ sRGBHex: string }> };

function isEyeDropperConstructor(candidate: unknown): candidate is EyeDropperConstructor {
  return typeof candidate === 'function';
}

function readEyeDropper(): EyeDropperConstructor | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(window, 'EyeDropper');
  const candidate: unknown = descriptor?.value;
  return isEyeDropperConstructor(candidate) ? candidate : undefined;
}

// A Webflow-style color chooser popover: a saturation/brightness square, hue and
// alpha sliders, an eyedropper, and hex / RGB / HSB inputs. Portaled to <body> and
// anchored under the swatch that opened it, so it clears the panel and any scroll.
// HSVA is the canonical internal state; output notation follows the input's (hex /
// rgb / hsl), with alpha forcing the alpha form.

type Props = {
  value: string;
  anchor: DOMRect;
  /** The swatch that opened the picker — excluded from the outside-close so clicking
   *  it again toggles closed instead of closing-then-reopening. */
  trigger?: HTMLElement | undefined;
  onChange: (color: string, live: boolean) => void;
  onClose: () => void;
};

const CHECKER = 'repeating-conic-gradient(#808080 0% 25%, #a0a0a0 0% 50%) 50% / 10px 10px';
const HUE_BAR = 'linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)';
const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));

function checkerStyle(): CSSProperties & { readonly '--picker-checker': string } {
  return { '--picker-checker': CHECKER };
}

/** Whether a report is mid-drag (live) or the release that commits it (final). */
type DragPhase = 'live' | 'final';

// Track the pointer across a drag on an element, reporting a 0..1 fraction of its
// width (and, for the 2D square, height). Live during the drag; committed on release.
// `tall` says the vertical is worth hearing: the saturation square is a surface
// you drag around in, the hue and alpha bars are a few pixels high, where a
// fraction of the height is noise rather than intent.
function useDrag({ tall = false, onMove }: { readonly tall?: boolean; readonly onMove: (fx: number, fy: number, phase: DragPhase) => void }) {
  return (element: HTMLElement, event: React.PointerEvent) => {
    const rect = element.getBoundingClientRect();
    const report = (event: PointerEvent | React.PointerEvent, phase: DragPhase) => {
      const fx = clamp((event.clientX - rect.left) / rect.width, 0, 1);
      const fy = clamp((event.clientY - rect.top) / rect.height, 0, 1);
      // A note as the value moves: pitched by where along the track it is —
      // right higher, left lower — and, on the square, played harder the higher
      // up it is. The same on all three of these, because they are one gesture
      // wearing three shapes. Silent unless the setting is on, and it decides
      // for itself which moves are worth a sound.
      if (phase === 'live') {
        dragNote(fx, tall ? fy : undefined);
      }
      onMove(fx, fy, phase);
    };
    report(event, 'live');
    const move = (event: PointerEvent) => report(event, 'live');
    const up = (event: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      report(event, 'final');
      // The next drag sounds its first step, wherever it starts.
      endDragNotes();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
}

function Field({ label, value, onChange, wide }: { label: string; value: string; onChange: (v: string) => void; wide?: boolean }) {
  const [text, setText] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setText(value);
    }
  }, [value]);
  return (
    <label className={`u-color-field ${wide ? 'is-wide' : ''}`}>
      <input
        className="u-input u-color-field-input"
        value={text}
        spellCheck={false}
        onChange={(event) => {
          setText(event.target.value);
          onChange(event.target.value);
        }}
        onFocus={(event) => {
          focused.current = true;
          event.target.select();
        }}
        onBlur={() => {
          focused.current = false;
          setText(value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur();
            return;
          }
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
            return;
          }
          // Step numeric fields (R/G/B, H/S/L/B, A) by 1 (10 with Shift). A non-numeric
          // value like a hex string parses to NaN → left to the browser's default.
          const parsed = parseFloat(text);
          if (Number.isNaN(parsed)) {
            return;
          }
          event.preventDefault();
          const next = String(parsed + (event.shiftKey ? 10 : 1) * (event.key === 'ArrowUp' ? 1 : -1));
          setText(next);
          onChange(next);
        }}
        aria-label={label}
      />
    </label>
  );
}

const EYEDROPPER_ICON_PATH = 'M10.5 2.5a1.7 1.7 0 0 1 2.4 2.4l-1 1 1 1-1.2 1.2-1-1' + 'L6 12.8 3 13.5l.7-3 4.1-4.1-1-1L8 4.2l1 1 1-1a1.7 1.7 0 0 1 .5-.4Z';

const EyedropperIcon = () => (
  <svg viewBox="0 0 16 16" width="15" height="15" fill="none" aria-hidden="true">
    <path d={EYEDROPPER_ICON_PATH} stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
  </svg>
);

export default function ColorPicker({ value, anchor, trigger, onChange, onClose }: Props) {
  const initial = useRef<RGBA>(parseColor(value) ?? { r: 0, g: 0, b: 0, a: value.trim() ? 1 : 0 });
  const [hsva, setHsva] = useState<HSVA>(() => rgbaToHsva(initial.current));
  const notation = useNotation(value, hsva, onChange);
  const rootRef = useRef<HTMLDivElement>(null);
  const position = usePickerPosition(rootRef, anchor);
  const alpha = useAlphaChoice();

  const emit = (next: HSVA, phase: DragPhase) => {
    setHsva(next);
    onChange(formatColor(hsvaToRgba(next), notation.mode), phase === 'live');
  };
  const setFromColor = (input: string) => {
    const picked = parseColor(input);
    if (!picked) {
      return;
    }
    // A value typed or picked whole says what its own alpha is.
    alpha.choose();
    const next = rgbaToHsva(picked);
    // Preserve hue/sat when picking a greyscale value so the square doesn't jump.
    if (next.s === 0) {
      next.h = hsva.h;
    }
    if (next.v === 0 || next.s === 0) {
      next.s = next.s === 0 ? hsva.s : next.s;
    }
    setHsva(next);
    onChange(formatColor(picked, notation.mode), false);
  };
  const setNumber = (key: 'h' | 's' | 'v' | 'a', raw: string, max: number) => {
    const amount = parseFloat(raw);
    if (Number.isNaN(amount)) {
      return;
    }
    if (key === 'a') {
      alpha.choose();
    }
    const next = {
      ...hsva,
      [key]: key === 'a' ? clamp(amount / 100, 0, 1) : clamp(amount, 0, max),
    };
    emit(key === 'a' ? next : alpha.carry(next), 'final');
  };

  return (
    <Popup
      mode="popover"
      anchor={trigger}
      onClose={onClose}
      ref={rootRef}
      className="u-color-picker"
      style={position ? { top: position.top, left: position.left } : { visibility: 'hidden' }}
      role="dialog"
      label="Color picker"
    >
      <PickerSurfaces hsva={hsva} alpha={alpha} emit={emit} onPicked={setFromColor} />
      <PickerInputs hsva={hsva} channel={notation.channel} onColor={setFromColor} onNumber={setNumber} />
      <NotationRow notation={notation} />
    </Popup>
  );
}

type Notation = ReturnType<typeof useNotation>;
type AlphaChoice = ReturnType<typeof useAlphaChoice>;

// HEX is ALWAYS visible (its own field); the toggle only cycles the channel
// notation shown in the middle three fields (RGB → HSL → HSB). Output notation
// follows the active channel — hsb has no CSS form, so it emits rgb.
// What the picker WRITES. It opens on whatever notation the value is already
// in, so opening a picker on a colour never rewrites it.
//
// HSB used to be the third: it is what Figma and Photoshop show, but CSS has
// no `hsb()`, so choosing it wrote rgb() and the toggle looked broken — the
// numbers changed and the declaration didn't. The three here are the three
// CSS can actually spell.
// Two separate questions, because they have two separate buttons. `channel` is
// what the three number fields show — the pill under them toggles it. `asHex`
// is whether the colour is WRITTEN as hex — the HEX button turns that on, and
// pressing the pill turns it off, since the pill's letters then describe the
// notation as well as the numbers.
//
// Hex doesn't belong in the pill's cycle: it isn't a third kind of channel,
// it is R/G/B spelled differently, and it has a label of its own sitting right
// beside them.
function useNotation(value: string, hsva: HSVA, onChange: Props['onChange']) {
  const [channel, setChannel] = useState<'rgb' | 'hsl'>(() => (colorMode(value) === 'hsl' ? 'hsl' : 'rgb'));
  // Nothing set yet is no notation to preserve, and a colour written for the
  // first time should come out the way this panel has always written one.
  const [asHex, setAsHex] = useState(() => !!value.trim() && colorMode(value) === 'hex');
  // What a write is formatted as.
  const mode: ColorMode = asHex ? 'hex' : channel;
  // Choosing a notation rewrites the declaration in it. Without that the toggle
  // changed only the three fields, leaving the CSS as whatever it was last
  // written in: picking HSL showed H/S/L and left `rgb(224, 4, 4)` in the file,
  // which is the toggle appearing to do nothing to the thing it is about.
  //
  // Nothing to rewrite when nothing is set: a colour nobody has chosen should
  // not become one because a notation was picked.
  const writeAs = (next: ColorMode) => {
    if (value.trim()) {
      onChange(formatColor(hsvaToRgba(hsva), next), false);
    }
  };
  // The pill: rgb ↔ hsl. From hex it comes back to whichever of the two its
  // letters are already showing, rather than flipping to the other one — the
  // letters are what was pressed.
  const toggleChannel = () => {
    const next = asHex ? channel : channel === 'rgb' ? 'hsl' : 'rgb';
    setAsHex(false);
    setChannel(next);
    writeAs(next);
  };
  const chooseHex = () => {
    setAsHex(true);
    writeAs('hex');
  };
  return { channel, asHex, mode, toggleChannel, chooseHex };
}

// Position under the swatch, clamped to the viewport.
function usePickerPosition(rootRef: RefObject<HTMLDivElement>, anchor: DOMRect) {
  const [position, setPosition] = useState<{ top: number; left: number } | undefined>(undefined);
  useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element) {
      return;
    }
    const width = element.offsetWidth || 240;
    const height = element.offsetHeight || 300;
    const left = clamp(anchor.left, 8, window.innerWidth - width - 8);
    const below = anchor.bottom + 6;
    const top = below + height > window.innerHeight - 8 && anchor.top - height - 6 > 8 ? anchor.top - height - 6 : below;
    setPosition({ top, left });
  }, [rootRef, anchor]);
  return position;
}

// A colour nobody has set yet opens at alpha 0 — there is no colour, and
// `transparent` is the honest way to show that. But it makes the first drag
// useless: the square picks a hue that renders as nothing, so the field fills
// in and the page doesn't change. So while the alpha is 0 and nobody has said
// it should be, the first drag means "this colour, visible", and the alpha
// comes up with it.
//
// Keyed on the alpha rather than on whether the property was set, because the
// two are the same thing to look at: an unset colour and one set to
// `transparent` both read as "transparent" in the field, and a drag on either
// is somebody asking for a colour they can see.
//
// Only until the alpha is somebody's choice. Move the slider, type in A, paste
// a hex with alpha in it, and that is the opacity — including 0, which is then
// a decision rather than a starting point.
function useAlphaChoice() {
  const alphaChosen = useRef(false);
  return {
    choose: () => {
      alphaChosen.current = true;
    },
    // The alpha a drag on hue or saturation should carry.
    carry: (next: HSVA): HSVA => (alphaChosen.current || next.a > 0 ? next : { ...next, a: 1 }),
  };
}

function PickerSurfaces({
  hsva,
  alpha,
  emit,
  onPicked,
}: {
  hsva: HSVA;
  alpha: AlphaChoice;
  emit: (next: HSVA, phase: DragPhase) => void;
  onPicked: (color: string) => void;
}) {
  const rgba = hsvaToRgba(hsva);
  const hueColor = formatHex({ ...hsvaToRgba({ h: hsva.h, s: 100, v: 100, a: 1 }), a: 1 });
  const dragSB = useDrag({
    tall: true,
    onMove: (fx, fy, phase) => emit(alpha.carry({ ...hsva, s: Math.round(fx * 100), v: Math.round((1 - fy) * 100) }), phase),
  });
  const dragHue = useDrag({
    onMove: (fx, _fy, phase) => emit(alpha.carry({ ...hsva, h: Math.round(fx * 360) }), phase),
  });
  const dragAlpha = useDrag({
    onMove: (fx, _fy, phase) => {
      alpha.choose();
      emit({ ...hsva, a: Math.round(fx * 100) / 100 }, phase);
    },
  });
  return (
    <>
      <div
        className="u-color-sb"
        style={{
          background: 'linear-gradient(to top, #000, transparent), ' + `linear-gradient(to right, #fff, ${hueColor})`,
        }}
        onPointerDown={(event) => {
          event.preventDefault();
          dragSB(event.currentTarget, event);
        }}
      >
        <span className="u-color-sb-thumb" style={{ left: `${hsva.s}%`, top: `${100 - hsva.v}%`, background: formatHex(rgba) }} />
      </div>
      <PickerSliders hsva={hsva} dragHue={dragHue} dragAlpha={dragAlpha} onPicked={onPicked} />
    </>
  );
}

type DragStart = (element: HTMLElement, event: React.PointerEvent) => void;

function PickerSliders({ hsva, dragHue, dragAlpha, onPicked }: { hsva: HSVA; dragHue: DragStart; dragAlpha: DragStart; onPicked: (color: string) => void }) {
  const eyedrop = () => {
    const EyeDropper = readEyeDropper();
    if (!EyeDropper) {
      return;
    }
    new EyeDropper()
      .open()
      .then((result) => onPicked(result.sRGBHex))
      .catch(() => {
        // Escape dismisses the eyedropper by rejecting: nothing was picked, so there
        // is nothing to apply and nothing to report.
      });
  };
  return (
    <div className="u-color-sliders">
      <button
        type="button"
        className={`u-color-eyedrop ${readEyeDropper() ? '' : 'is-hidden'}`}
        onClick={eyedrop}
        title="Pick a color from the screen"
        aria-label="Eyedropper"
      >
        <EyedropperIcon />
      </button>
      <div className="u-color-slider-stack">
        <div
          className="u-color-slider"
          style={{ background: HUE_BAR }}
          onPointerDown={(event) => {
            event.preventDefault();
            dragHue(event.currentTarget, event);
          }}
        >
          <span className="u-color-slider-thumb" style={{ left: `${(hsva.h / 360) * 100}%` }} />
        </div>
        <div
          className="u-color-slider u-color-alpha"
          style={checkerStyle()}
          onPointerDown={(event) => {
            event.preventDefault();
            dragAlpha(event.currentTarget, event);
          }}
        >
          <span
            className="u-color-alpha-fill"
            style={{
              background: `linear-gradient(to right, transparent, ${hueColorWithSat(hsva)})`,
            }}
          />
          <span className="u-color-slider-thumb" style={{ left: `${Math.round(hsva.a * 100)}%` }} />
        </div>
      </div>
    </div>
  );
}

// The three middle channel fields. Hex is rgb in another spelling, so those two
// share R/G/B — what changes between them is how the value is written out, and
// the label row below says which.
function channelLabels(channel: 'rgb' | 'hsl'): string[] {
  return channel === 'hsl' ? ['H', 'S', 'L'] : ['R', 'G', 'B'];
}

function PickerInputs({
  hsva,
  channel,
  onColor,
  onNumber,
}: {
  hsva: HSVA;
  channel: 'rgb' | 'hsl';
  onColor: (color: string) => void;
  onNumber: (key: 'h' | 's' | 'v' | 'a', raw: string, max: number) => void;
}) {
  const rgba = hsvaToRgba(hsva);
  const hsl = rgbaToHsl(rgba);
  const asHsl = channel === 'hsl';
  const channelValues = asHsl ? [String(hsl.h), String(hsl.s), String(hsl.l)] : [String(rgba.r), String(rgba.g), String(rgba.b)];
  const setChannel = (i: number, value: string) => {
    if (asHsl) {
      onColor(`hsla(${i === 0 ? value : hsl.h}, ${i === 1 ? value : hsl.s}%, ` + `${i === 2 ? value : hsl.l}%, ${rgba.a})`);
    } else {
      onColor(`rgba(${i === 0 ? value : rgba.r}, ${i === 1 ? value : rgba.g}, ` + `${i === 2 ? value : rgba.b}, ${rgba.a})`);
    }
  };
  // HEX is always present; the middle three fields follow the channel notation.
  return (
    <div className="u-color-inputs">
      <Field label="HEX" wide value={formatHex(rgba)} onChange={onColor} />
      <div className="u-color-channels">
        {channelLabels(channel).map((lab, i) => (
          <Field key={i} label={lab} value={channelValues[i] ?? ''} onChange={(value) => setChannel(i, value)} />
        ))}
      </div>
      <Field label="A" value={String(Math.round(hsva.a * 100))} onChange={(value) => onNumber('a', value, 100)} />
    </div>
  );
}

// Column labels and the notation, in one row. The letters say what the numbers above
// them ARE; the highlight says how the colour is written into the CSS. Those are the
// same thing for RGB and HSL and not for HEX, where the numbers are still R/G/B — so
// in hex the HEX label lights and the letters stay honest. Two buttons, two jobs: HEX
// picks hex, the pill toggles rgb and hsl.
function NotationRow({ notation }: { notation: Notation }) {
  const { asHex, channel, mode } = notation;
  return (
    <div className="u-color-modes">
      <button
        type="button"
        className={`u-color-mode is-hex ${asHex ? 'is-on' : ''}`}
        onClick={notation.chooseHex}
        aria-pressed={asHex}
        title="Write this colour as hex"
      >
        HEX
      </button>
      <button
        type="button"
        className={`u-color-mode is-channel ${asHex ? 'is-off' : ''}`}
        onClick={notation.toggleChannel}
        aria-pressed={!asHex}
        aria-label={`Written as ${mode}. Press for ${channel === 'rgb' ? 'hsl' : 'rgb'}`}
        title="Toggle rgb() / hsl()"
      >
        {channelLabels(channel).map((lab, i) => (
          <span key={i}>{lab}</span>
        ))}
      </button>
      <span className="u-color-mode-static is-alpha">A</span>
    </div>
  );
}

function hueColorWithSat(hsva: HSVA): string {
  return formatHex({ ...hsvaToRgba({ ...hsva, a: 1 }), a: 1 });
}
