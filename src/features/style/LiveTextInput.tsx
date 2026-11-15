// The live text input the style panel's fields type into: it writes while
// typing (debounced), commits on Enter or blur, and steps a number with the
// arrow keys (TypographyKit.tsx).

import { useEffect, useRef, useState } from 'react';
import useScrub from './components/useScrub';
import { handleArrowStep } from './model/numberStep';
import { followWhileRendering } from './model/fieldHooks';
import VariableConnect from './VariableConnect';
import { commitInPlace } from './model/commitInPlace';
import { pickerPreviewKind, useFieldPreview, type FieldPreview } from './connectFieldHelpers';
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
  // The picker's hover preview goes to the canvas alone, for the property this field edits; a field with no
  // property has nowhere to show it but in itself.
  const fieldPreview = useFieldPreview(prop ?? dataProp, value);
  const field = useLiveInputEditing({ value, busy, onCommit, onLiveCommit, onClear, fieldPreview });
  // A computed value is a hint, never a draft that blur could write into CSS.
  const computed = useStyleHint(value.trim() ? '' : (prop ?? ''));
  return (
    <VariableConnect
      code
      ariaLabel={translate('style.liveTextInput.connect', { name: ariaLabel || translate('style.liveTextInput.value') })}
      disabled={busy}
      {...(prop === undefined ? {} : { prop })}
      onPick={(binding) => {
        fieldPreview.picked(binding);
        onCommit(binding, false);
      }}
    >
      <input
        {...field.scrub.input}
        ref={inputRef}
        className={className}
        data-prop={dataProp}
        value={field.draft}
        onChange={(event) => field.change(event.target.value, { source: pickerPreviewKind(event) ?? 'typed' })}
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
// The picker's preview is neither: it is shown through `fieldPreview` (the canvas
// alone) and taken back through it, and it never reaches a live write.
export function useLiveInputEditing({
  value,
  busy,
  onCommit,
  onLiveCommit,
  onClear,
  fieldPreview,
}: Pick<LiveInputProps, 'value' | 'busy' | 'onCommit' | 'onClear'> & {
  onLiveCommit: LiveInputProps['onLiveCommit'] | undefined;
  /** Shows the picker's previewed text on the canvas, and takes it away: never a write. */
  fieldPreview?: FieldPreview | undefined;
}) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  // A new value reaches the draft while rendering, not in an effect (fieldHooks.ts
  // followWhileRendering). A field being typed in keeps its draft, as before.
  followWhileRendering(useState(value), value, () => {
    if (!focused.current) {
      setDraft(value);
    }
  });
  // Whether a live write went out that no commit or clear has settled, and whether the person has edited the
  // text since the last commit. A blur commits only after an edit or a live write: a field that shows its
  // default (or the picker's preview, put back) was never edited, and writing what it shows would turn an
  // unset property into a set one.
  const wrote = useRef(false);
  const edited = useRef(false);
  const trackedLive =
    onLiveCommit === undefined
      ? undefined
      : (...written: Parameters<NonNullable<LiveInputProps['onLiveCommit']>>): void => {
          wrote.current = true;
          onLiveCommit(...written);
        };
  const { cancelLive, liveNow, scheduleLive } = useDebouncedLive(trackedLive);
  const commit = (text = draft) => {
    const trimmed = text.trim();
    if (!trimmed) {
      onClear();
      return;
    }
    const parsed = parseImportant(trimmed);
    onCommit(parsed.value, parsed.important);
  };
  const settle = (): void => {
    wrote.current = false;
    edited.current = false;
  };
  const scrub = useScrub({
    value: draft,
    disabled: busy,
    onPreview: setDraft,
    onInput: liveNow,
    onCommit: (text) => {
      setDraft(text);
      settle();
      commit(text);
    },
  });
  return {
    draft,
    scrub,
    change: (text: string, { source }: { readonly source: 'typed' | 'preview' | 'restore' }) => {
      setDraft(text);
      if (source === 'typed') {
        edited.current = true;
        scheduleLive(text);
        return;
      }
      // The picker previewing a variable is shown, never written: a live write here put every hovered
      // variable into the stylesheet (and the original back on the way out), each one a save, a history
      // entry and a file the dev server reloaded. The canvas shows it through the preview channel alone.
      if (source === 'preview') {
        fieldPreview?.show(text);
        return;
      }
      // Putting the text the chooser opened on back takes the canvas preview away at once (no timer a blur or
      // an unmount could cancel). A live write of typing that went out before the chooser opened is still the
      // person's edit, so it is put back as before; for an unset property that clears the live draft instead
      // of writing the displayed default. It compares with nothing the panel reports: a live write can be
      // read back as the value, so only the picker knows what the original was.
      fieldPreview?.takeBack();
      cancelLive();
      if (!wrote.current) {
        return;
      }
      wrote.current = false;
      if (text.trim() === '') {
        onClear();
        return;
      }
      liveNow(text);
      wrote.current = false;
    },
    focus: () => {
      focused.current = true;
    },
    blur: () => {
      focused.current = false;
      cancelLive();
      if (!edited.current && !wrote.current) {
        return;
      }
      settle();
      commit();
    },
    keyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
      const stepped = stepLiveKey(event);
      if (stepped !== undefined) {
        edited.current = true;
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
