// Opacity: a normalized number by default, preserving an explicitly authored percent.

import DragSlider from './components/DragSlider';
import useScrub from './components/useScrub';
import { useComputedValue } from './model/computedStyle';
import { handleArrowStep } from './model/numberStep';
import VariableConnect from './VariableConnect';
import { useExternalDraft } from './model/fieldHooks';
import { displayOf } from './model/styleDisplay';
import { type SetProp, type Props, stepInPlace, EffLabel } from './EffectsKit';

// ─────────────────────────── Rows ───────────────────────────

export type OpacityUnit = 'number' | 'percent';

export interface OpacityValue {
  readonly value: number;
  readonly unit: OpacityUnit;
}

const OPACITY_PATTERN = /^[-+]?(?:\d+\.?\d*|\.\d+)(%)?$/;

export const clampOpacity = (value: number) => Math.min(1, Math.max(0, value));

/** A CSS opacity number or percentage, normalized to the slider's zero-to-one range. */
export function parseOpacity(value: string): OpacityValue | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const match = trimmed.match(OPACITY_PATTERN);
  if (!match) {
    return undefined;
  }
  const amount = Number.parseFloat(trimmed);
  if (!Number.isFinite(amount)) {
    return undefined;
  }
  const unit: OpacityUnit = match[1] === '%' ? 'percent' : 'number';
  const normalized = unit === 'percent' ? amount / 100 : amount;
  return { value: clampOpacity(normalized), unit };
}

function opacityAmount(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** The field and CSS retain percent only when that unit was explicitly authored. */
export function opacityText(opacity: OpacityValue): string {
  const value = clampOpacity(opacity.value);
  if (opacity.unit === 'percent') {
    return `${opacityAmount(value * 100)}%`;
  }
  return String(opacityAmount(value));
}

export function OpacityRow({ props }: { props: Props }) {
  const { read, busy, setProp, liveSetProp } = props;
  const display = displayOf(read('opacity'));
  const raw = display.present ? display.value.trim() : '';
  const authored = parseOpacity(raw);
  // `opacity: var(--fade)` is a number the panel can't read — but the page can, and
  // a slider parked at 100% while the element is half faded is just wrong. Ask for
  // the computed value in that case (only then: a plain `0.4` needs no round trip).
  const computed = parseOpacity(useComputedValue(authored === undefined && raw ? 'opacity' : ''));
  const opacity: OpacityValue = authored ?? computed ?? { value: 1, unit: 'number' };
  const unit = authored?.unit ?? 'number';
  // A value the panel can't express as a number stays in the field as it was
  // written, so the variable chip shows and editing around it doesn't flatten it.
  const asNumber = authored !== undefined || !raw;
  // Drag previews live (DragSlider already throttles the writes); release commits.
  const live = (next: OpacityValue) => liveSetProp('opacity', opacityText(next), false);
  const commit = (next: OpacityValue) => setProp('opacity', opacityText(next), false);

  // The number field's local draft: typing previews live; blur / Enter commits.
  const fieldText = asNumber ? opacityText({ value: opacity.value, unit }) : raw;
  const field = useExternalDraft(fieldText);

  return (
    <div className="embed-editor_size-row">
      <EffLabel label="Opacity" prop="opacity" props={props} />
      <div className="embed-editor_shadow-field">
        <DragSlider
          value={opacity.value}
          min={0}
          max={1}
          step={0.01}
          disabled={busy}
          ariaLabel="Opacity"
          onPreview={(value) => {
            if (!field.focused.current) {
              field.setDraft(opacityText({ value, unit }));
            }
          }}
          onInput={(value) => live({ value, unit })}
          onCommit={(value) => {
            if (!field.focused.current) {
              field.setDraft(opacityText({ value, unit }));
            }
            commit({ value, unit });
          }}
        />
        <OpacityNumberField
          text={field.draft}
          setText={field.setDraft}
          focusedRef={field.focused}
          fieldText={fieldText}
          opacity={{ value: opacity.value, unit }}
          busy={busy}
          live={live}
          commit={commit}
          setProp={setProp}
        />
      </div>
    </div>
  );
}

// The opacity value as text: typing and stepping preview live; blur commits a
// number as an opacity and anything else (a var(), a calc()) as written.
export interface OpacityFieldProps {
  text: string;
  setText: (text: string) => void;
  focusedRef: React.MutableRefObject<boolean>;
  fieldText: string;
  opacity: OpacityValue;
  busy: boolean;
  live: (value: OpacityValue) => void;
  commit: (value: OpacityValue) => void;
  setProp: SetProp;
}

export function OpacityNumberField(props: OpacityFieldProps) {
  const { text, setText, focusedRef, busy, live, setProp } = props;
  const { scrub, commitTyped } = useOpacityField(props);
  return (
    <div className="embed-editor_field embed-editor_grad-num embed-editor_opacity-num">
      <VariableConnect
        className="is-fill"
        ariaLabel="Connect Opacity to a variable"
        disabled={busy}
        prop="opacity"
        onPick={(binding) => setProp('opacity', binding, false)}
      >
        <input
          {...scrub.input}
          className="u-input embed-editor_size-input"
          value={text}
          inputMode="decimal"
          spellCheck={false}
          disabled={busy}
          aria-label="Opacity"
          onFocus={() => {
            focusedRef.current = true;
          }}
          onChange={(event) => {
            setText(event.target.value);
            const value = parseOpacity(event.target.value);
            if (value !== undefined) {
              live(value);
            }
          }}
          onBlur={() => {
            focusedRef.current = false;
            commitTyped();
          }}
          onKeyDown={(event) => {
            const stepped = stepOpacityInPlace(event);
            if (stepped === undefined) {
              return;
            }
            setText(stepped);
            const value = parseOpacity(stepped);
            if (value !== undefined) {
              live(value);
            }
          }}
        />
      </VariableConnect>
    </div>
  );
}

// The field's scrub (a scrub commits a number, or puts the percent back) and its
// commit on blur.
export function useOpacityField({ text, setText, fieldText, opacity, busy, live, commit, setProp }: OpacityFieldProps) {
  const commitScrub = (next: string) => {
    setText(next);
    const value = parseOpacity(next);
    if (value !== undefined) {
      commit(value);
    } else {
      setText(opacityText(opacity));
    }
  };
  const scrub = useScrub({
    value: text,
    disabled: busy,
    stepScale: opacity.unit === 'percent' ? 1 : 0.01,
    onPreview: setText,
    onInput: (next) => {
      const value = parseOpacity(next);
      if (value !== undefined) {
        live(value);
      }
    },
    onCommit: commitScrub,
  });
  const commitTyped = () => {
    const trimmed = text.trim();
    // Untouched — a var()/expression stays as it is.
    if (trimmed === fieldText) {
      return;
    }
    const value = parseOpacity(trimmed);
    // A number becomes an opacity; anything else (a var(), a calc()) is
    // written as it stands, so a variable typed in here survives.
    if (value !== undefined) {
      commit(value);
      setText(opacityText(value));
    } else if (trimmed) {
      setProp('opacity', trimmed, false);
    } else {
      setText(fieldText);
    }
  };
  return { scrub, commitTyped };
}

function stepOpacityInPlace(event: React.KeyboardEvent<HTMLInputElement>): string | undefined {
  if (event.key === 'Enter') {
    stepInPlace(event);
    return undefined;
  }
  const scale = event.currentTarget.value.trim().endsWith('%') ? 1 : 0.01;
  const stepped = handleArrowStep(event, 0, scale);
  if (stepped === undefined) {
    return undefined;
  }
  const opacity = parseOpacity(stepped.text);
  if (opacity === undefined) {
    return undefined;
  }
  event.preventDefault();
  const text = opacityText(opacity);
  const input = event.currentTarget;
  input.value = text;
  input.setSelectionRange(text.length, text.length);
  return text;
}
