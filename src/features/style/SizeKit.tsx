// What the size section's fields share: the writers they are handed, the
// label, the live text field and its draft, and arrow-key steps
// (SizeSection.tsx).

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import FieldLabel from './components/FieldLabel';
import { PropTip, ProvenanceLabel } from './components/CssPropertyTip';
import useScrub, { type ScrubHandlers } from './components/useScrub';
import { handleArrowStep } from './model/numberStep';
import { useFieldDraft } from './model/fieldDraft';
import ProvenanceList from './ProvenanceList';
import VariableConnect from './VariableConnect';
import type { Contributor, ResolvedProp } from './model/resolved';
import { commitInPlace } from './model/commitInPlace';
import { useDebouncedLive } from './model/fieldHooks';
import { displayOf, displayText, keepImportant, parseImportant, withImportant, type Display } from './model/styleDisplay';
import { useStyleHint } from './model/computedStyle';

export type SetProp = (prop: string, value: string, important: boolean) => void;
export type ClearProp = (prop: string | string[]) => void;
export type LiveSetProp = (prop: string, value: string | undefined, important: boolean) => void;
export type Read = (prop: string) => ResolvedProp | undefined;

export type Props = {
  read: Read;
  busy: boolean;
  setProp: SetProp;
  clearProp: ClearProp;
  liveSetProp: LiveSetProp;
  onProvenance: (prop: string, anchor: DOMRect) => void;
  /** Switch the panel's pick to the given selector (click the override note tag). */
  onSelectSelector: (selector: string, prop?: string) => void;
};

// A size control's label: blue (picked selector sets it) → FieldLabel with a
// clear menu; orange (another selector) → a button opening provenance; unset →
// a dim caption. When the picked selector sets it but a more specific selector
// wins, the label goes red + struck through and its menu names the winner.
export function SizeLabel({
  label,
  prop,
  display,
  contributors,
  busy,
  scrubProps,
  onClear,
  onProvenance,
  onSelectSelector,
}: {
  label: string;
  prop: string;
  display: Display;
  contributors: Contributor[];
  busy: boolean;
  scrubProps?: ScrubHandlers;
  onClear: () => void;
  onProvenance: (prop: string, anchor: DOMRect) => void;
  onSelectSelector: (selector: string, prop?: string) => void;
}) {
  if (display.present && !display.isSelected) {
    return <ProvenanceLabel label={label} props={[prop]} busy={busy} onProvenance={onProvenance} />;
  }
  return (
    <FieldLabel
      className={`embed-editor_size-label ${display.overridden ? 'is-overridden' : ''}`}
      active={display.isSelected}
      {...(display.present ? {} : { inheritedProp: prop })}
      disabled={busy}
      onReset={onClear}
      resetLabel="Clear"
      tooltip={<PropTip props={[prop]} />}
      {...(display.overridden ? { title: `Overridden by ${display.winnerSelector}` } : {})}
      menuNote={(close) => (
        <ProvenanceList
          contributors={contributors}
          prop={prop}
          onSelect={(selector, selectorProp) => {
            onSelectSelector(selector, selectorProp);
            close();
          }}
        />
      )}
      {...(scrubProps === undefined ? {} : { scrubProps })}
    >
      {label}
    </FieldLabel>
  );
}

// ─────────────────── Live text field (plain input) ───────────────────

export function LivePropField({
  prop,
  label,
  placeholder,
  read,
  busy,
  setProp,
  clearProp,
  liveSetProp,
  onProvenance,
  onSelectSelector,
}: {
  prop: string;
  label: string;
  placeholder: string;
} & Props) {
  const display = displayOf(read(prop));
  const field = useLivePropEditing({ prop, display, busy, setProp, clearProp, liveSetProp });
  const computed = useStyleHint(display.present ? '' : prop);
  return (
    <>
      <SizeLabel
        label={label}
        prop={prop}
        display={display}
        contributors={read(prop)?.contributors ?? []}
        busy={busy}
        scrubProps={field.scrub.label}
        onClear={field.clear}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      <VariableConnect
        code
        ariaLabel={`Connect ${label} to a variable`}
        disabled={busy}
        prop={prop}
        onPick={(binding) => {
          const kept = keepImportant(binding, display);
          setProp(prop, kept.value, kept.important);
        }}
      >
        <input
          {...field.scrub.input}
          className="u-input embed-editor_size-input"
          data-prop={prop}
          value={field.draft}
          onChange={(event) => field.change(event.target.value)}
          onFocus={field.focus}
          onBlur={field.blur}
          onKeyDown={field.keyDown}
          disabled={busy}
          spellCheck={false}
          placeholder={prop === 'width' || prop === 'height' ? 'auto' : computed || placeholder}
          aria-label={label}
        />
      </VariableConnect>
    </>
  );
}

// The length field's editing state: the draft that follows the model while
// nobody is typing, live writes while someone is, and the commit on blur.
export function useLivePropEditing({
  prop,
  display,
  busy,
  setProp,
  clearProp,
  liveSetProp,
}: {
  prop: string;
  display: Display;
  busy: boolean;
  setProp: SetProp;
  clearProp: ClearProp;
  liveSetProp: LiveSetProp;
}) {
  const external = displayText(display);
  const { draft, setDraft, focused, cleared } = useFieldDraft(external, { busy });
  const { cancelLive, liveNow, scheduleLive } = useDebouncedLive((value, important) => liveSetProp(prop, value, important));
  const commit = (text = draft) => {
    const trimmed = text.trim();
    if (!trimmed) {
      clearProp(prop);
      return;
    }
    const parsed = parseImportant(trimmed);
    setProp(prop, parsed.value, parsed.important);
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
    clear: () => {
      cleared();
      clearProp(prop);
    },
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
    keyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => {
      const stepped = stepSizeKey(event);
      if (stepped !== undefined) {
        setDraft(stepped);
        scheduleLive(stepped);
      }
    },
  };
}

// ─────────────────── Shared field plumbing ───────────────────

// The join every field shares (model/styleDisplay.ts), re-exported for the size rows.
export { withImportant };

// A draft that follows `value` while the field is not focused, so an edit made
// elsewhere shows up without overwriting what someone is typing.
export function useFollowingDraft(value: string) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setDraft(value);
    }
  }, [value]);
  return { draft, setDraft, focused };
}

// Enter commits in place; an arrow key steps the number under the caret and
// writes it straight into the input. Returns the stepped text, if any.
export function stepSizeKey(event: ReactKeyboardEvent<HTMLInputElement>): string | undefined {
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

export const LENGTH_FIELDS: ReadonlyArray<{ prop: string; label: string; placeholder: string }> = [
  { prop: 'width', label: 'Width', placeholder: 'Auto' },
  { prop: 'height', label: 'Height', placeholder: 'Auto' },
  { prop: 'min-width', label: 'Min W', placeholder: '0px' },
  { prop: 'min-height', label: 'Min H', placeholder: '0px' },
  { prop: 'max-width', label: 'Max W', placeholder: 'None' },
  { prop: 'max-height', label: 'Max H', placeholder: 'None' },
];
