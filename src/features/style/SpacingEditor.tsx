import { centralIcon } from '../../ui/central/CentralIcon';
import { more as centralMore } from '../../ui/central/centralGeometry';
import Popup from '../../ui/Popup';
// The popover that edits one side of the spacing box: its draft, its live and
// committed writes, the reset button, focus on open, arrow-key steps, and
// closing on a press outside unless it lands in a popup of its own
// (SpacingBox.tsx).

const MoreGlyph = centralIcon(centralMore, 12);

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import useScrub from './components/useScrub';
import { handleArrowStep } from './model/numberStep';
import { isNonNegative } from './model/cssProperties';
import { hasOwnedPopup, inOwnedPopup } from '../../ui/popupOwnership';
import ProvenanceList from './ProvenanceList';
import VariableConnect from './VariableConnect';
import { type ResolvedProp } from './model/resolved';
import { useDebouncedLive } from './model/fieldHooks';
import { parseImportant } from './model/styleDisplay';
import { type SetProp, type ClearProp, type LiveSetProp, type Read, type SelectSelector, type Side, displayOf } from './spacingTypes';
import { affectedSides, siblingProps } from './SpacingFill';
import { withImportant } from './spacingValue';
import { humanLabel } from './SpacingLabel';
import { useStyleHint } from './model/computedStyle';

// The editor shown inside the popover: a live text input (number + unit, with the
// same arrow-step / !important handling as before). Commits + closes on blur.
export function SpacingEditor(props: SpacingEditorProps) {
  const { prop, placeholder, read, onSelectSelector, onClose } = props;
  const editor = useSpacingEditor(props);
  const computed = useStyleHint(read(prop) === undefined ? prop : '');
  return (
    <Popup
      mode="popover"
      portal={false}
      onClose={editor.close}
      onEscape={editor.abandon}
      className="embed-editor_spacing-popover"
      ref={editor.rootRef}
      // Keep the input focused when pressing anywhere in the popover other than the
      // field itself, so an inside click never blurs → commits → closes. The field is
      // not always the <input>: a value with a variable in it draws the rich token
      // editor instead, and preventing that press left the value looking editable and
      // refusing the caret.
      onMouseDown={(event) => {
        const target = event.target;
        if (target === editor.inputRef.current) {
          return;
        }
        if (target instanceof Element && target.closest('.embed-editor_varconnect')) {
          return;
        }
        event.preventDefault();
      }}
      // Which sides the pending commit writes is decided HERE rather than on the
      // field: the rich editor answers Enter itself (it blurs, and that blur is what
      // commits), so the <input>'s own key handler never runs in code mode. Captured
      // so it is recorded before either field acts on the key.
      onKeyDownCapture={editor.keyDownCapture}
    >
      <div className="embed-editor_spacing-popover-row">
        <span className="embed-editor_spacing-popover-label" {...editor.scrub.label}>
          {humanLabel(prop)}
        </span>
        <VariableConnect
          code
          {...(isNonNegative(prop) ? { stepMin: 0 } : {})}
          ariaLabel={`Connect ${humanLabel(prop)} to a variable`}
          disabled={false}
          prop={prop}
          onPick={editor.pick}
        >
          <input
            {...editor.scrub.input}
            ref={editor.inputRef}
            className={`u-input embed-editor_spacing-editor`}
            value={editor.draft}
            placeholder={computed || placeholder}
            onChange={(event) => editor.change(event.target.value)}
            onBlur={editor.blur}
            onKeyDown={editor.keyDown}
            spellCheck={false}
            aria-label={prop}
          />
        </VariableConnect>
      </div>
      {/* Which selectors set this side and which one wins (the winner reads full
          strength, the rest dimmed). Each row jumps to that selector. */}
      <ProvenanceList
        contributors={read(prop)?.contributors ?? []}
        prop={prop}
        onSelect={(selector, selectorProp) => {
          onSelectSelector(selector, selectorProp);
          onClose();
        }}
      />
      <SpacingResetButton onReset={editor.reset} />
    </Popup>
  );
}

export type SpacingEditorProps = {
  prop: string;
  side: Side;
  placeholder: string;
  read: Read;
  setProp: SetProp;
  clearProp: ClearProp;
  liveSetProp: LiveSetProp;
  onSelectSelector: SelectSelector;
  onClose: () => void;
  /** Fired when the popover closes because its OWN side's label was pressed —
   *  lets the parent suppress that label's click from re-opening it (toggle). */
  onSameLabelPress: () => void;
};

// Reused Reset item — mousedown-preventDefault keeps input focus so the
// blur→commit path doesn't fire before the click clears the value.
export function SpacingResetButton({ onReset }: { onReset: () => void }) {
  return (
    <button
      type="button"
      className="u-field-label-menu-item embed-editor_spacing-reset"
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        event.preventDefault();
        onReset();
      }}
    >
      <MoreGlyph className="u-field-label-menu-icon" />
      <span>Reset</span>
      <span className="u-field-label-menu-shortcut">Option + click</span>
    </button>
  );
}

// The editor's state and handlers: the draft (seeded once, when the popover
// opens), live writes while typing, and the single commit when it closes.
export function useSpacingEditor({ prop, side, read, setProp, clearProp, liveSetProp, onClose }: SpacingEditorProps) {
  const external = spacingExternal(read(prop));
  const { draft, draftRef, setDraftValue } = useEditorDraft(external);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useEditorFocus(rootRef, inputRef);
  const { cancelLive, liveNow, scheduleLive } = useDebouncedLive((value, important) => liveSetProp(prop, value, important));
  const commit = useSpacingCommit({ prop, side, external, draftRef, setProp, clearProp });
  // Commit the latest draft and close — once, so blur + outside-click can't
  // double-fire.
  const close = () => {
    if (commit.close()) {
      cancelLive();
      onClose();
    }
  };
  const abandon = () => {
    cancelLive();
    commit.abandon();
    onClose();
  };
  // A scrub only moves the draft: this popover's authoritative write happens when it
  // closes (see `close`), which is also what typing in it does.
  const scrub = useScrub({
    value: draft,
    onPreview: setDraftValue,
    onInput: liveNow,
    onCommit: setDraftValue,
  });
  const handlers = spacingEditorHandlers({
    prop,
    commit,
    rootRef,
    setDraftValue,
    scheduleLive,
    cancelLive,
    close,
    abandon,
    setProp,
    clearProp,
    onClose,
  });
  return { draft, rootRef, inputRef, scrub, close, abandon, ...handlers };
}

// The editor's event handlers, over the state `useSpacingEditor` owns.
export function spacingEditorHandlers({
  prop,
  commit,
  rootRef,
  setDraftValue,
  scheduleLive,
  cancelLive,
  close,
  abandon,
  setProp,
  clearProp,
  onClose,
}: {
  prop: string;
  commit: ReturnType<typeof useSpacingCommit>;
  rootRef: React.RefObject<HTMLDivElement>;
  setDraftValue: (text: string) => void;
  scheduleLive: (text: string) => void;
  cancelLive: () => void;
  close: () => void;
  abandon: () => void;
  setProp: SetProp;
  clearProp: ClearProp;
  onClose: () => void;
}) {
  return {
    keyDownCapture: (event: ReactKeyboardEvent) => {
      if (commit.recordKey(event) === 'abandon') {
        abandon();
      }
    },
    keyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => {
      const recorded = commit.recordKey(event);
      if (recorded === 'commit') {
        event.preventDefault();
        // This field's blur closes the editor — Enter is done with it, so it
        // leaves rather than staying focused like a panel field.
        event.currentTarget.blur();
        return;
      }
      if (recorded === 'abandon') {
        abandon();
        return;
      }
      const stepped = stepSpacingKey(event, prop);
      if (stepped !== undefined) {
        setDraftValue(stepped);
        scheduleLive(stepped);
      }
    },
    change: (text: string) => {
      setDraftValue(text);
      scheduleLive(text);
    },
    pick: (binding: string) => {
      // The pick has to land in the field as well as on the element. This
      // popover seeds its draft once, when it opens, and does not follow the
      // model afterwards — so picking a variable styled the element while the
      // field it was picked in stayed empty, until the popover was closed and
      // opened again and the draft was seeded afresh.
      setDraftValue(binding);
      // And it must not be written a second time on the way out: `close()`
      // commits whenever the draft differs from what the popover opened with,
      // and the pick is already written by the setProp below.
      commit.rebase(binding);
      // The field's text carries its `!important` (insertBinding.ts keeps it
      // around a pick), so the flag is split off here rather than written into
      // the value.
      const parsed = parseImportant(binding);
      setProp(prop, parsed.value, parsed.important);
    },
    blur: () => closeUnlessInPopup(rootRef, close),
    reset: () => {
      // Skip the commit path; we're clearing, not committing.
      commit.abandon();
      cancelLive();
      clearProp(prop);
      onClose();
    },
  };
}

// Losing focus to a popup this field opened — the variable picker takes focus
// for its search box, the big value editor takes it outright — is not leaving
// the editor. Closing there took the popup down with it before anything could
// be chosen. Checked a tick later because during a blur the focus has left one
// element and not yet reached the next.
export function closeUnlessInPopup(rootRef: React.RefObject<HTMLDivElement>, close: () => void): void {
  window.setTimeout(() => {
    if (hasOwnedPopup(rootRef.current ?? undefined)) {
      return;
    }
    if (inOwnedPopup(document.activeElement ?? undefined, rootRef.current ?? undefined)) {
      return;
    }
    close();
  }, 0);
}

// The value the editor opens with: the side's own value, with its !important.
export function spacingExternal(resolved: ResolvedProp | undefined): string {
  const display = displayOf(resolved);
  return display.present ? withImportant(display) : '';
}

// The draft, mirrored into a ref so listeners registered once still read the
// latest text.
export function useEditorDraft(external: string) {
  const [draft, setDraft] = useState(external);
  const draftRef = useRef(draft);
  const setDraftValue = (text: string) => {
    draftRef.current = text;
    setDraft(text);
  };
  return { draft, draftRef, setDraftValue };
}

// When and what the editor writes. Only an explicit Enter or an actual edit is
// applied: opening the popover and clicking away (or blurring) must leave the
// side untouched — otherwise an inherited / other-selector value gets silently
// written onto the picked style.
export function useSpacingCommit({
  prop,
  side,
  external,
  draftRef,
  setProp,
  clearProp,
}: {
  prop: string;
  side: Side;
  external: string;
  draftRef: React.MutableRefObject<string>;
  setProp: SetProp;
  clearProp: ClearProp;
}) {
  const closed = useRef(false);
  // The value when the popover opened, and whether Enter explicitly confirmed it.
  const originalRef = useRef(external);
  const commitRequested = useRef(false);
  // Which sides the pending commit writes. Enter alone writes this one; the drag
  // modifiers mean the same here — Option/Alt adds the opposite side, Shift takes
  // all four. Reset on every keystroke so a modifier only counts on the Enter that
  // held it, and left at this side alone for a commit that comes from a blur.
  const commitProps = useRef<string[]>([prop]);
  return {
    // Writes the draft if it should be written. Returns whether this call is the
    // one that closes the editor; later calls do nothing.
    close: (): boolean => {
      if (closed.current) {
        return false;
      }
      closed.current = true;
      const trimmed = draftRef.current.trim();
      const changed = trimmed !== originalRef.current.trim();
      if (commitRequested.current || changed) {
        const props = commitProps.current;
        if (!trimmed) {
          clearProp(props);
        } else {
          const parsed = parseImportant(trimmed);
          props.forEach((target) => setProp(target, parsed.value, parsed.important));
        }
      }
      return true;
    },
    // Closing without the commit path: Escape, or Reset clearing the side.
    abandon: () => {
      closed.current = true;
    },
    rebase: (value: string) => {
      originalRef.current = value;
    },
    recordKey: (event: { key: string; shiftKey: boolean; altKey: boolean }): 'commit' | 'abandon' | 'none' => {
      if (event.key === 'Enter') {
        commitRequested.current = true;
        commitProps.current = siblingProps(prop, side, affectedSides(side, event));
        return 'commit';
      }
      if (event.key === 'Escape') {
        return 'abandon';
      }
      // A modifier only applies to the Enter that carries it.
      commitProps.current = [prop];
      return 'none';
    },
  };
}

// Opened to be typed in: focus the field it actually shows. With a variable in the
// value that is the rich editor, and focusing the <input> hidden behind it left the
// popup looking focused while the caret was nowhere.
export function useEditorFocus(rootRef: React.RefObject<HTMLDivElement>, inputRef: React.RefObject<HTMLInputElement>): void {
  useEffect(() => {
    const rich = rootRef.current?.querySelector<HTMLElement>('.embed-editor_varconnect-editor');
    if (rich) {
      rich.focus();
      const range = document.createRange();
      range.selectNodeContents(rich);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [rootRef, inputRef]);
}

// An arrow key steps the number under the caret and writes it straight into
// the input. Padding stops at 0; a margin or an inset is free to go negative,
// which is the whole point of pulling something out of its box. Returns the
// stepped text, if any.
export function stepSpacingKey(event: ReactKeyboardEvent<HTMLInputElement>, prop: string): string | undefined {
  const stepped = handleArrowStep(event, isNonNegative(prop) ? 0 : undefined);
  if (!stepped) {
    return undefined;
  }
  event.preventDefault();
  const input = event.currentTarget;
  input.value = stepped.text;
  input.setSelectionRange(stepped.caret, stepped.caret);
  return stepped.text;
}
