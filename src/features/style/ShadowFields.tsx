import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import DragSlider from './components/DragSlider';
import ColorSwatch from './components/ColorSwatch';
import useScrub from './components/useScrub';
import VariableConnect from './VariableConnect';
import { handleArrowStep } from './model/numberStep';
import { useLiveColor } from './model/liveColor';

// Shared building blocks for the shadow editors (text-shadow + box-shadow): a labelled
// length row (drag slider + number field) and the full-width popup modal. Both editors
// compose these so the two controls behave identically — only their per-layer field set
// differs (box-shadow adds Type + Size).

// Coarse drag ranges for the shadow sliders (px); the number field always allows a
// precise value outside the range.
export const SHADOW_RANGE: Record<string, { min: number; max: number }> = {
  X: { min: -50, max: 50 },
  Y: { min: -50, max: 50 },
  Blur: { min: 0, max: 50 },
  Size: { min: -50, max: 50 },
};

// Split "2px" → { amount: 2, unit: 'px' } (a bare number defaults to px); undefined
// when the value isn't a plain length (var()/calc()/…), so the slider is disabled.
function parseLength(value: string): { amount: number; unit: string } | undefined {
  const match = value.trim().match(/^(-?\d*\.?\d+)\s*([a-z%]*)$/i);
  if (!match) {
    return undefined;
  }
  return { amount: parseFloat(match[1] ?? ''), unit: match[2] || 'px' };
}

// A live text field for a shadow sub-value (length or color): live on type
// (debounced), commit on blur, arrow-step, and clear → a caller-defined value. Kept
// minimal — shadows never carry !important.
function ShadowTextInput({
  value,
  busy,
  ariaLabel,
  placeholder,
  className,
  prop,
  onCommit,
  onLive,
  onClear,
}: {
  value: string;
  busy: boolean;
  ariaLabel: string;
  placeholder: string;
  className: string;
  /** The CSS property this sub-value maps to — filters the variable picker
   *  (a length for X/Y/Blur/Size, `color` for the color row). */
  prop: string;
  onCommit: (value: string) => void;
  onLive: (value: string) => void;
  onClear: () => void;
}) {
  const field = useShadowDraft({ value, busy, onCommit, onLive, onClear });
  return (
    <VariableConnect
      code
      ariaLabel={`Connect ${ariaLabel} to a variable`}
      disabled={busy}
      className="is-fill"
      prop={prop}
      onPick={(binding) => onCommit(binding)}
    >
      <input
        {...field.scrub.input}
        className={className}
        value={field.draft}
        onChange={(event) => field.change(event.target.value)}
        onFocus={field.focus}
        onBlur={field.blur}
        onKeyDown={field.keyDown}
        disabled={busy}
        spellCheck={false}
        placeholder={placeholder}
        aria-label={ariaLabel}
      />
    </VariableConnect>
  );
}

// The text field's editing state: a draft that follows `value` while nobody is
// typing, live previews on a debounce while someone is, and the commit on blur.
function useShadowDraft({
  value,
  busy,
  onCommit,
  onLive,
  onClear,
}: {
  value: string;
  busy: boolean;
  onCommit: (value: string) => void;
  onLive: (value: string) => void;
  onClear: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setDraft(value);
    }
  }, [value]);
  const { cancel, liveNow, live } = useDebouncedLive(onLive);
  const commit = (text = draft) => {
    const trimmed = text.trim();
    if (!trimmed) {
      onClear();
      return;
    }
    onCommit(trimmed);
  };
  const scrub = useScrub({
    value: draft,
    disabled: busy,
    onPreview: setDraft,
    onInput: liveNow,
    onCommit: (text) => {
      setDraft(text);
      commit(text);
    },
  });
  return {
    draft,
    scrub,
    change: (text: string) => {
      setDraft(text);
      live(text);
    },
    focus: () => {
      focused.current = true;
    },
    blur: () => {
      focused.current = false;
      cancel();
      commit();
    },
    keyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      const stepped = stepShadowKey(event);
      if (stepped !== undefined) {
        setDraft(stepped);
        live(stepped);
      }
    },
  };
}

// Live previews of typed text: debounced while typing, immediate for a scrub.
// Blank text is never previewed.
function useDebouncedLive(onLive: (value: string) => void) {
  const timer = useRef<number | undefined>(undefined);
  const cancel = () => {
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
    }
  };
  useEffect(() => cancel, []);
  const liveNow = (text: string) => {
    const trimmed = text.trim();
    if (trimmed) {
      onLive(trimmed);
    }
  };
  const live = (text: string) => {
    cancel();
    timer.current = window.setTimeout(() => liveNow(text), 100);
  };
  return { cancel, liveNow, live };
}

// Enter commits by blurring; an arrow key steps the number under the caret and
// writes it straight into the input. Returns the stepped text, if any.
function stepShadowKey(event: KeyboardEvent<HTMLInputElement>): string | undefined {
  if (event.key === 'Enter') {
    event.currentTarget.blur();
    return undefined;
  }
  const stepped = handleArrowStep(event);
  if (!stepped) {
    return undefined;
  }
  event.preventDefault();
  const input = event.currentTarget;
  input.value = stepped.text;
  input.setSelectionRange(stepped.caret, stepped.caret);
  return stepped.text;
}

// One shadow length (X / Y / Blur / Size): a draggable slider (coarse) beside a
// number field (precise). The slider drives the numeric part and re-attaches the
// value's unit; a non-length value keeps the field but disables the slider.
export function ShadowLength({
  label,
  value,
  busy,
  onCommit,
  onLive,
  range,
  defaultUnit = 'px',
}: {
  label: string;
  value: string;
  busy: boolean;
  onCommit: (value: string) => void;
  onLive: (value: string) => void;
  /** Override the coarse slider range (defaults to the SHADOW_RANGE for `label`). */
  range?: { min: number; max: number };
  /** Unit shown/re-attached when there's no length yet, and on clear (defaults to px).
   *  The number field keeps whatever unit the value carries (em/rem/%/…). */
  defaultUnit?: string;
}) {
  const parsed = parseLength(value);
  const sliderRange = range ?? SHADOW_RANGE[label] ?? { min: -50, max: 50 };
  const unit = parsed?.unit ?? defaultUnit;
  // While the slider is dragged, show its live value in the number field (the model
  // `value` only catches up on commit). Cleared whenever `value` actually changes, so
  // after a commit the field falls back to the model with no flash.
  const [live, setLive] = useState<string | undefined>(undefined);
  useEffect(() => {
    setLive(undefined);
  }, [value]);
  // A bare typed number gets the current/default unit ("150" → "150%", "5" → "5px");
  // a value that already carries a unit (em/rem/%/var()/…) passes through untouched.
  const withUnit = (text: string): string => (/^-?[\d.]+$/.test(text.trim()) ? `${text.trim()}${unit}` : text);
  return (
    <div className="embed-editor_size-row">
      <span className="embed-editor_size-label embed-editor_bg-caption">{label}</span>
      <div className="embed-editor_shadow-field">
        <DragSlider
          value={parsed?.amount ?? 0}
          min={sliderRange.min}
          max={sliderRange.max}
          disabled={busy || !parsed}
          ariaLabel={label}
          onPreview={(amount) => setLive(`${amount}${unit}`)}
          onInput={(amount) => onLive(`${amount}${unit}`)}
          onCommit={(amount) => onCommit(`${amount}${unit}`)}
        />
        <ShadowTextInput
          value={live ?? value}
          busy={busy}
          ariaLabel={label}
          placeholder={`0${defaultUnit}`}
          className="u-input embed-editor_size-input embed-editor_shadow-num"
          prop="width"
          onCommit={(text) => onCommit(withUnit(text))}
          onLive={(text) => onLive(withUnit(text))}
          onClear={() => onCommit(`0${defaultUnit}`)}
        />
      </div>
    </div>
  );
}

// The Color row shared by both shadow editors: a swatch beside a live text field.
//
// A drag in the picker writes to the canvas, not to the model this row reads —
// the model is rebuilt from the stylesheets, and rebuilding it per pointer move
// would be absurd. So the row shows the colour it last emitted until the model
// catches up: otherwise the page moves under the pointer while the swatch and
// the number sit on the colour the drag started from (see liveColor.ts).
export function ShadowColorRow({ color, busy, onChange }: { color: string; busy: boolean; onChange: (color: string, live: boolean) => void }) {
  const [shown, noteLive] = useLiveColor(color);
  return (
    <div className="embed-editor_size-row">
      <span className="embed-editor_size-label embed-editor_bg-caption">Color</span>
      <div className="embed-editor_type-field">
        <ColorSwatch
          value={shown}
          busy={busy}
          ariaLabel="Shadow color"
          onChange={(next, live) => {
            noteLive(live ? next : undefined);
            onChange(next, live);
          }}
        />
        <ShadowTextInput
          value={shown}
          busy={busy}
          ariaLabel="Shadow color"
          placeholder="rgba(0, 0, 0, 0.2)"
          className="u-input embed-editor_size-input"
          prop="color"
          onCommit={(next) => {
            noteLive(undefined);
            onChange(next, false);
          }}
          onLive={(next) => onChange(next, true)}
          onClear={() => {
            noteLive(undefined);
            onChange('', false);
          }}
        />
      </div>
    </div>
  );
}
