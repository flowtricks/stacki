// Opacity: a normalized number by default, preserving an explicitly authored percent.

import DragSlider from './components/DragSlider';
import useScrub from './components/useScrub';
import { useComputedValue } from './model/computedStyle';
import { handleArrowStep } from './model/numberStep';
import VariableConnect from './VariableConnect';
import { useExternalDraft } from './model/fieldHooks';
import { displayOf, keepImportant, parseImportant, withImportant } from './model/styleDisplay';
import { assert } from '../../../shared/core/assert';
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

/** One opacity write: the amount, and whether it is `!important`. The slider
 *  keeps the flag the property has; the field takes it from its own text. */
export interface OpacityWrite {
  readonly opacity: OpacityValue;
  readonly important: boolean;
}

/** The field's text, split into the opacity it names (if it names a number)
 *  and its flag — the field shows `0.5 !important` like any other field. */
export function parseOpacityField(text: string): { readonly opacity: OpacityValue | undefined; readonly value: string; readonly important: boolean } {
  const typed = parseImportant(text);
  const opacity = parseOpacity(typed.value);
  assert(!/!\s*important/i.test(typed.value), 'parseOpacityField: the flag is split off the value');
  return { opacity, value: typed.value, important: typed.important };
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
  const live = (next: OpacityWrite) => liveSetProp('opacity', opacityText(next.opacity), next.important);
  const commit = (next: OpacityWrite) => setProp('opacity', opacityText(next.opacity), next.important);
  // The slider has no text to delete the flag from, so it keeps the one shown.
  const { important } = display;
  const sliderText = (value: number) => withImportant({ value: opacityText({ value, unit }), important });

  // The number field's local draft: typing previews live; blur / Enter commits.
  const fieldText = withImportant({ value: asNumber ? opacityText({ value: opacity.value, unit }) : raw, important });
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
              field.setDraft(sliderText(value));
            }
          }}
          onInput={(value) => live({ opacity: { value, unit }, important })}
          onCommit={(value) => {
            if (!field.focused.current) {
              field.setDraft(sliderText(value));
            }
            commit({ opacity: { value, unit }, important });
          }}
        />
        <OpacityNumberField
          text={field.draft}
          setText={field.setDraft}
          focusedRef={field.focused}
          fieldText={fieldText}
          opacity={{ value: opacity.value, unit }}
          important={important}
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
  /** Whether the property is `!important` now — a variable pick keeps it. */
  important: boolean;
  busy: boolean;
  live: (value: OpacityWrite) => void;
  commit: (value: OpacityWrite) => void;
  setProp: SetProp;
}

export function OpacityNumberField(props: OpacityFieldProps) {
  const { text, setText, focusedRef, busy, live, setProp, important } = props;
  // Typing and stepping preview what the text names, flag and all.
  const liveText = (next: string) => {
    const typed = parseOpacityField(next);
    if (typed.opacity !== undefined) {
      live({ opacity: typed.opacity, important: typed.important });
    }
  };
  const { scrub, commitTyped } = useOpacityField(props);
  return (
    <div className="embed-editor_field embed-editor_grad-num embed-editor_opacity-num">
      <VariableConnect
        className="is-fill"
        ariaLabel="Connect Opacity to a variable"
        disabled={busy}
        prop="opacity"
        onPick={(binding) => {
          const kept = keepImportant(binding, { important });
          setProp('opacity', kept.value, kept.important);
        }}
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
            liveText(event.target.value);
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
            liveText(stepped);
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
    const typed = parseOpacityField(next);
    if (typed.opacity !== undefined) {
      commit({ opacity: typed.opacity, important: typed.important });
    } else {
      setText(fieldText);
    }
  };
  const scrub = useScrub({
    value: text,
    disabled: busy,
    stepScale: opacity.unit === 'percent' ? 1 : 0.01,
    onPreview: setText,
    onInput: (next) => {
      const typed = parseOpacityField(next);
      if (typed.opacity !== undefined) {
        live({ opacity: typed.opacity, important: typed.important });
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
    // A number becomes an opacity; anything else (a var(), a calc()) is
    // written as it stands, so a variable typed in here survives. The flag is
    // whatever the text says: deleting `!important` from it removes it.
    const typed = parseOpacityField(trimmed);
    if (typed.opacity !== undefined) {
      commit({ opacity: typed.opacity, important: typed.important });
      setText(withImportant({ value: opacityText(typed.opacity), important: typed.important }));
    } else if (typed.value) {
      setProp('opacity', typed.value, typed.important);
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
  const scale = parseImportant(event.currentTarget.value).value.endsWith('%') ? 1 : 0.01;
  const stepped = handleArrowStep(event, 0, scale);
  if (stepped === undefined) {
    return undefined;
  }
  // The step changes the number; the flag after it stays in the text.
  const typed = parseOpacityField(stepped.text);
  if (typed.opacity === undefined) {
    return undefined;
  }
  event.preventDefault();
  const amount = opacityText(typed.opacity);
  const text = withImportant({ value: amount, important: typed.important });
  const input = event.currentTarget;
  input.value = text;
  // The caret stays at the end of the number, before any flag, ready for the next step.
  input.setSelectionRange(amount.length, amount.length);
  return text;
}
