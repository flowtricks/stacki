import { useTranslate } from '../../../lib/i18n/useTranslate';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import VariableConnect from '../VariableConnect';
import { handleArrowStep } from '../model/numberStep';
import { commitInPlace } from '../model/commitInPlace';
import useScrub from './useScrub';

// The panel's value field.
//
// Every row that takes a typed value works the same way: it shows the value as
// code (so a `var(--x)` reads as one), writes as you type and again on blur,
// steps numbers with the arrow keys, and offers the variable picker for the
// property it edits. That behaviour was written out per section, and the copies
// drifted — the one in the position popup ended up on smaller type and tighter
// padding than the field two rows above it. This is the one of them.
//
// Numbers in the field can also be dragged (components/useScrub): Alt or Shift
// drag on the input grabs the number under the pointer. Living here means every
// row that uses this field has it, rather than each section wiring its own — the
// LABEL drag is separate, and stays with the section that renders the label.
//
// A field can carry a `suffix` (a unit that is part of the field rather than
// part of the value: `%`, `DEG`). The focus ring then belongs to the box around
// both, not to the input alone — a ring drawn around the input cuts the unit
// out of the field it belongs to.

type LiveInputProps = {
  value: string;
  busy: boolean;
  readOnly?: boolean;
  ariaLabel: string;
  placeholder?: string;
  /** The CSS property being edited — filters the variable picker (a colour
   *  property offers Color variables; a length offers sizes). */
  prop: string;
  /** A unit shown inside the field, after the value (`%`, `deg`). */
  suffix?: ReactNode;
  /** A floor the arrow keys stop at, for a property that refuses to go below it. */
  min?: number;
  /** The box the field lives in — sections that lay their fields out differently
   *  pass their own. It owns the focus ring. */
  wrapClassName?: string;
  onLive: (value: string) => void;
  onCommit: (value: string) => void;
  onVariablePick?: (binding: string) => void;
};

export default function LiveInput({
  value,
  busy,
  readOnly = false,
  ariaLabel,
  placeholder,
  prop,
  suffix,
  min,
  wrapClassName = 'embed-editor_field',
  onLive,
  onCommit,
  onVariablePick,
}: LiveInputProps) {
  const translate = useTranslate();
  const { draft, setDraft, focused, cancelLive, scheduleLive, settleLive } = useLiveDraft(value, onLive);
  const commitScrub = (text: string) => {
    setDraft(text);
    settleLive();
    onCommit(text);
  };
  const scrub = useScrub({
    value: draft,
    disabled: busy || readOnly,
    onPreview: setDraft,
    onInput: onLive,
    onCommit: commitScrub,
  });
  return (
    <div className={wrapClassName}>
      <VariableConnect
        code
        className="is-fill"
        ariaLabel={translate('styleModel.shared.connectVariable', { label: ariaLabel })}
        disabled={busy}
        prop={prop}
        onPick={(binding) => {
          // The pick is the edit: a live preview still waiting for its timer must not land after it.
          cancelLive();
          settleLive();
          // The field shows the pick even when it is the value already saved (no prop change follows then).
          setDraft(binding);
          (onVariablePick ?? onCommit)(binding);
        }}
      >
        <input
          {...scrub.input}
          className="u-input embed-editor_size-input"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            scheduleLive(event.target.value);
          }}
          onFocus={() => {
            focused.current = true;
          }}
          onBlur={() => {
            focused.current = false;
            cancelLive();
            settleLive();
            onCommit(draft);
          }}
          onKeyDown={(event) => {
            const stepped = keyDownStep(event, min);
            if (stepped !== undefined) {
              setDraft(stepped);
              scheduleLive(stepped);
            }
          }}
          disabled={busy}
          readOnly={readOnly}
          spellCheck={false}
          placeholder={placeholder ?? '0'}
          aria-label={ariaLabel}
        />
      </VariableConnect>
      {suffixSpan(suffix)}
    </div>
  );
}

// The unit after the value. A ReactNode suffix may arrive as null from a caller;
// either way there is none.
function suffixSpan(suffix: ReactNode): ReactNode {
  const shown = suffix ?? undefined;
  return shown !== undefined ? <span className="embed-editor_field-suffix">{shown}</span> : undefined;
}

// Enter commits in place; an arrow key steps the number under the caret and returns
// the stepped text (already written into the field), or undefined when nothing stepped.
function keyDownStep(event: KeyboardEvent<HTMLInputElement>, min: number | undefined): string | undefined {
  if (event.key === 'Enter') {
    commitInPlace(event.currentTarget);
    return undefined;
  }
  const stepped = handleArrowStep(event, min);
  if (!stepped) {
    return undefined;
  }
  event.preventDefault();
  const element = event.currentTarget;
  element.value = stepped.text;
  element.setSelectionRange(stepped.caret, stepped.caret);
  return stepped.text;
}

// The typed draft, re-synced from `value` while the field isn't focused, and a
// debounced live write of what is typed.
function useLiveDraft(value: string, onLive: (value: string) => void) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  const liveTimer = useRef<number | undefined>(undefined);
  // The text the pending timer will send, and the latest committed value and sender, for the unmount below.
  const pendingText = useRef<string | undefined>(undefined);
  // The last text sent live and not committed since: what the canvas may be showing that no save holds.
  const liveSent = useRef<string | undefined>(undefined);
  const latest = useRef({ value, onLive });
  latest.current = { value, onLive };
  useEffect(() => {
    if (!focused.current) {
      setDraft(value);
    }
  }, [value]);
  const cancelLive = useCallback(() => {
    if (liveTimer.current !== undefined) {
      window.clearTimeout(liveTimer.current);
      liveTimer.current = undefined;
    }
    pendingText.current = undefined;
  }, []);
  // Leaving with a live edit still waiting is dropped, EXCEPT when it is the committed value itself: that
  // edit puts back what an earlier live edit already showed (a variable previewed from the picker and
  // restored), and dropping it would leave the canvas on the preview with nothing to take it back.
  useEffect(
    () => () => {
      const text = pendingText.current;
      const settled = text !== undefined && text === latest.current.value;
      cancelLive();
      if (settled) {
        latest.current.onLive(text);
      } else if (liveSent.current !== undefined && liveSent.current !== latest.current.value) {
        // Gone with a live edit shown and never committed: the canvas goes back to the saved value.
        latest.current.onLive(latest.current.value);
      }
      liveSent.current = undefined;
    },
    [cancelLive],
  );
  // A commit, or a pick, makes what the canvas shows the saved value's business again.
  const settleLive = useCallback(() => {
    liveSent.current = undefined;
  }, []);
  const scheduleLive = (text: string) => {
    cancelLive();
    pendingText.current = text;
    liveTimer.current = window.setTimeout(() => {
      liveTimer.current = undefined;
      pendingText.current = undefined;
      liveSent.current = text;
      onLive(text);
    }, 100);
  };
  return { draft, setDraft, focused, cancelLive, scheduleLive, settleLive };
}
