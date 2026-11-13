// The live text input the style panel's fields type into: it writes while
// typing (debounced), commits on Enter or blur, and steps a number with the
// arrow keys (TypographyKit.tsx).

import { useEffect, useRef, useState } from 'react';
import useScrub from './components/useScrub';
import { handleArrowStep } from './model/numberStep';
import VariableConnect from './VariableConnect';
import { commitInPlace } from './model/commitInPlace';
import { parseImportant } from './model/styleDisplay';
import { useStyleHint } from './model/computedStyle';
import { useTranslate } from '../../lib/i18n/useTranslate';

// ─────────────────────────── Live text input ───────────────────────────

// Shared draft/live/commit input. Live-updates the canvas ~100ms after a keystroke
// (when onLiveCommit is given) and runs the authoritative commit on blur/Enter.
export function LiveInput({
  value,
  busy,
  placeholder,
  ariaLabel,
  className,
  dataProp,
  prop,
  inputRef,
  autoFocus,
  onCommit,
  onLiveCommit,
  onClear,
}: LiveInputProps) {
  const translate = useTranslate();
  const field = useLiveInputEditing({ value, busy, onCommit, onLiveCommit, onClear });
  // A computed value is a hint, never a draft that blur could write into CSS.
  const computed = useStyleHint(value.trim() ? '' : (prop ?? ''));
  return (
    <VariableConnect
      code
      ariaLabel={translate('style.liveTextInput.connect', { name: ariaLabel || translate('style.liveTextInput.value') })}
      disabled={busy}
      {...(prop === undefined ? {} : { prop })}
      onPick={(binding) => onCommit(binding, false)}
    >
      <input
        {...field.scrub.input}
        ref={inputRef}
        className={className}
        data-prop={dataProp}
        value={field.draft}
        onChange={(event) => field.change(event.target.value)}
        onFocus={field.focus}
        onBlur={field.blur}
        onKeyDown={field.keyDown}
        disabled={busy}
        spellCheck={false}
        placeholder={computed || placeholder}
        aria-label={ariaLabel}
        autoFocus={autoFocus}
      />
    </VariableConnect>
  );
}

export type LiveInputProps = {
  value: string;
  busy: boolean;
  placeholder?: string;
  ariaLabel: string;
  className: string;
  dataProp?: string;
  /** The CSS property being edited — filters the variable picker to types that fit
   *  it (color props → Color only; font-family → FontFamily; else no color/font). */
  prop?: string;
  inputRef?: React.RefObject<HTMLInputElement>;
  autoFocus?: boolean;
  onCommit: (value: string, important: boolean) => void;
  onLiveCommit?: (value: string, important: boolean) => void;
  onClear: () => void;
};

// The input's editing state: a draft that follows `value` while nobody is
// typing, live writes while someone is, and the commit (or clear) on blur.
export function useLiveInputEditing({
  value,
  busy,
  onCommit,
  onLiveCommit,
  onClear,
}: Pick<LiveInputProps, 'value' | 'busy' | 'onCommit' | 'onClear'> & {
  onLiveCommit: LiveInputProps['onLiveCommit'] | undefined;
}) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setDraft(value);
    }
  }, [value]);
  const { cancelLive, liveNow, scheduleLive } = useDebouncedLive(onLiveCommit);
  const commit = (text = draft) => {
    const trimmed = text.trim();
    if (!trimmed) {
      onClear();
      return;
    }
    const parsed = parseImportant(trimmed);
    onCommit(parsed.value, parsed.important);
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
      scheduleLive(text);
    },
    focus: () => {
      focused.current = true;
    },
    blur: () => {
      focused.current = false;
      cancelLive();
      commit();
    },
    keyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
      const stepped = stepLiveKey(event);
      if (stepped !== undefined) {
        setDraft(stepped);
        scheduleLive(stepped);
      }
    },
  };
}

// Live writes of typed text, split into value and `!important` — none at all
// without a writer. `scheduleLive` debounces typing; `liveNow` is the undelayed
// write for the scrub, which throttles its own — see useScrub.
export function useDebouncedLive(write: ((value: string, important: boolean) => void) | undefined) {
  const liveTimer = useRef<number | undefined>(undefined);
  const cancelLive = () => {
    if (liveTimer.current !== undefined) {
      window.clearTimeout(liveTimer.current);
      liveTimer.current = undefined;
    }
  };
  useEffect(() => cancelLive, []);
  const liveNow = (text: string) => {
    if (!write) {
      return;
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    const parsed = parseImportant(trimmed);
    write(parsed.value, parsed.important);
  };
  const scheduleLive = (text: string) => {
    if (!write) {
      return;
    }
    cancelLive();
    liveTimer.current = window.setTimeout(() => {
      liveTimer.current = undefined;
      liveNow(text);
    }, 100);
  };
  return { cancelLive, liveNow, scheduleLive };
}

// Enter commits in place; an arrow key steps the number under the caret and
// writes it straight into the input. Returns the stepped text, if any.
export function stepLiveKey(event: React.KeyboardEvent<HTMLInputElement>): string | undefined {
  if (event.key === 'Enter') {
    commitInPlace(event.currentTarget);
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
