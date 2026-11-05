// A declaration's value field, and the row that adds a property: its
// combobox, suggestions, custom properties and the new value's input
// (EmbedEditor.tsx).

import { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Popup from '../../../ui/Popup';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react';
import useScrub from '../components/useScrub';
import { handleArrowStep } from '../model/numberStep';
import { filterCssProperties } from '../model/cssProperties';
import { panelSpan } from '../model/panelBox';
import { useSharedVars } from '../VariableConnect';
import { useExternalDraft } from '../model/fieldHooks';
import { parseImportant, withImportant } from '../model/styleDisplay';

// ─────────────────────────── Declaration row ───────────────────────────

// The value reads as a single scrollable line when idle. Once focused, it
// expands to a full-width, auto-height field the moment its content is too long
// to sit on one line — so long values wrap and grow tall instead of scrolling.
export const ValueField = forwardRef<
  HTMLTextAreaElement,
  {
    value: string;
    important: boolean;
    busy: boolean;
    /** Marks the field with [data-prop] so it can be focused programmatically. */
    dataProp?: string;
    onCommit: (value: string, important: boolean) => void;
    /** Fires (debounced) on every keystroke/step to push the value to the embed live. */
    onLiveCommit: (value: string, important: boolean) => void;
  }
>(function ValueField({ value, important, busy, dataProp, onCommit, onLiveCommit }, forwardedRef) {
  const external = withImportant({ value, important });
  // Mirror external edits, but never clobber what the user is typing.
  const { draft, setDraft, focused } = useExternalDraft(external);
  const ref = useRef<HTMLTextAreaElement>(null);
  // Keep the local ref (used for sizing/caret work) and hand the same node to
  // whoever wrapped us.
  const attachRef = mergedRef(ref, forwardedRef);

  // Undelayed live write for the scrub, which throttles its own — see useScrub.
  const liveNow = (text: string) => {
    const parsed = parseImportant(text);
    if (parsed.value) {
      onLiveCommit(parsed.value, parsed.important);
    }
  };
  // Push the current draft to the embed as you type/scrub — debounced so the
  // canvas updates in near-real-time without a write per keystroke.
  const { scheduleLive, cancelLive } = useLiveTimer(liveNow);
  const { expanded, setExpanded, maybeExpand } = useAutoExpand({ ref, focused, draft });

  const commit = (text = draft) => {
    const parsed = parseImportant(text);
    if (parsed.value && (parsed.value !== value || parsed.important !== important)) {
      onCommit(parsed.value, parsed.important);
    }
  };
  const commitScrub = (text: string) => {
    setDraft(text);
    commit(text);
  };
  const scrub = useScrub({
    value: draft,
    disabled: busy,
    onPreview: setDraft,
    onInput: liveNow,
    onCommit: commitScrub,
  });
  const edited = (text: string) => {
    setDraft(text);
    maybeExpand();
    scheduleLive(text);
  };

  return (
    <textarea
      {...scrub.input}
      ref={attachRef}
      data-prop={dataProp}
      className={`u-input embed-editor_value-input ${expanded ? 'is-expanded' : 'is-collapsed'}`}
      rows={1}
      value={draft}
      onChange={(event) => edited(event.target.value)}
      onFocus={() => {
        focused.current = true;
        maybeExpand();
      }}
      // Blur is the authoritative commit — cancel any pending live write first.
      onBlur={() => {
        focused.current = false;
        setExpanded(false);
        cancelLive();
        commit();
      }}
      // Enter commits — a CSS value is one line, so we never insert a hard break.
      // Up/Down scrub the number under the caret (Shift = ×10, Alt = per-px).
      onKeyDown={(event) => {
        const stepped = stepValueField(event);
        if (stepped !== undefined) {
          edited(stepped);
        }
      }}
      disabled={busy}
      spellCheck={false}
      aria-label="Value"
    />
  );
});

// One ref callback that sets both a local ref and whatever ref the caller forwarded.
export function mergedRef<T>(localRef: React.RefObject<T>, forwardedRef: React.ForwardedRef<T>): React.RefCallback<T> {
  return (node) => {
    Reflect.set(localRef, 'current', node);
    if (typeof forwardedRef === 'function') {
      forwardedRef(node);
    } else if (forwardedRef) {
      Reflect.set(forwardedRef, 'current', node);
    }
  };
}

// Debounces live writes while typing: the text reaches `liveNow` 100ms after the last
// keystroke; `cancelLive` drops a pending one.
export function useLiveTimer(liveNow: (text: string) => void) {
  const liveTimer = useRef<number | undefined>(undefined);
  const cancelLive = () => {
    if (liveTimer.current !== undefined) {
      window.clearTimeout(liveTimer.current);
      liveTimer.current = undefined;
    }
  };
  const scheduleLive = (text: string) => {
    cancelLive();
    liveTimer.current = window.setTimeout(() => {
      liveTimer.current = undefined;
      liveNow(text);
    }, 100);
  };
  useEffect(() => cancelLive, []);
  return { scheduleLive, cancelLive };
}

// The value field's expansion: it expands the instant the collapsed single line can no
// longer hold the content, and grows to fit it (no inner scroll); collapsing resets it.
export function useAutoExpand({ ref, focused, draft }: { ref: React.RefObject<HTMLTextAreaElement>; focused: React.MutableRefObject<boolean>; draft: string }) {
  const [expanded, setExpanded] = useState(false);
  const maybeExpand = () => {
    const field = ref.current;
    if (!field || !focused.current || expanded) {
      return;
    }
    if (field.scrollWidth > field.clientWidth + 1) {
      setExpanded(true);
    }
  };
  useLayoutEffect(() => {
    const field = ref.current;
    if (!field) {
      return;
    }
    if (expanded) {
      field.style.height = 'auto';
      field.style.height = `${field.scrollHeight}px`;
    } else {
      field.style.height = '';
    }
  }, [expanded, draft, ref]);
  return { expanded, setExpanded, maybeExpand };
}

// Enter blurs (the commit); ↑/↓ step the number under the caret in place. Returns the
// stepped text, or undefined when the key did not step.
export function stepValueField(event: React.KeyboardEvent<HTMLTextAreaElement>): string | undefined {
  const field = event.currentTarget;
  if (event.key === 'Enter') {
    event.preventDefault();
    field.blur();
    return undefined;
  }
  const stepped = handleArrowStep(event);
  if (!stepped) {
    return undefined;
  }
  event.preventDefault();
  field.value = stepped.text;
  field.setSelectionRange(stepped.caret, stepped.caret);
  return stepped.text;
}

// ─────────────────────────── Add-property row ───────────────────────────

// The property-name field with an autocomplete of every CSS property. The suggestion
// list is portaled to <body> and positioned above the input (the add row sits at the
// panel bottom), flipping below only when there's more room there. Arrow keys move the
// highlight, Enter/Tab/click pick it; Enter with nothing highlighted submits the row and
// Escape closes the list (a second Escape cancels the row).
export interface PropertyComboboxProps {
  value: string;
  /** This project's own custom properties, offered beside the standard ones. */
  custom: readonly string[];
  busy: boolean;
  onChange: (value: string) => void;
  onPick: (prop: string) => void;
  onEnter: () => void;
  onEscape: () => void;
}
export function PropertyCombobox(props: PropertyComboboxProps) {
  const { value, custom, busy, onChange, onPick, onEnter, onEscape } = props;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const matches = useMemo(() => filterCssProperties(value, custom), [value, custom]);
  const position = useSuggestPosition({ open, inputRef, matchCount: matches.length, value });

  // Reset the highlight to the top whenever the query (and so the list) changes.
  useEffect(() => {
    setActive(0);
  }, [value]);

  // Keep the highlighted option scrolled into view during keyboard nav.
  useEffect(() => {
    if (!open) {
      return;
    }
    const element = listRef.current?.children[active];
    if (element instanceof HTMLElement) {
      element.scrollIntoView({ block: 'nearest' });
    }
  }, [active, open]);

  const choose = (prop: string) => {
    onPick(prop);
    setOpen(false);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) =>
    comboKeyDown(event, { open, active, matches, setOpen, setActive, choose, onEnter, onEscape });

  return (
    <div className="embed-editor_propcombo">
      <input
        ref={inputRef}
        className="u-input embed-editor_prop-input"
        value={value}
        autoFocus
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        disabled={busy}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        placeholder="property"
        spellCheck={false}
        aria-label="New property name"
      />
      {open && matches.length ? (
        <PropertySuggestions
          onClose={() => setOpen(false)}
          listRef={listRef}
          position={position}
          matches={matches}
          active={active}
          setActive={setActive}
          choose={choose}
        />
      ) : undefined}
    </div>
  );
}

// The suggestion list, portaled to <body>.
export function PropertySuggestions({
  onClose,
  listRef,
  position,
  matches,
  active,
  setActive,
  choose,
}: {
  readonly onClose: () => void;
  listRef: React.RefObject<HTMLDivElement>;
  position: CSSProperties;
  matches: readonly string[];
  active: number;
  setActive: (index: number) => void;
  choose: (prop: string) => void;
}) {
  return (
    <Popup mode="popover" onClose={onClose} ref={listRef} className="embed-editor_propsuggest" style={position} role="listbox" label="CSS properties">
      {matches.map((prop, i) => (
        <button
          key={prop}
          type="button"
          role="option"
          aria-selected={i === active}
          className={`embed-editor_propsuggest-item${i === active ? ' is-active' : ''}`}
          onMouseEnter={() => setActive(i)}
          // A mousedown (not click) + preventDefault, so the input never blurs first.
          onMouseDown={(event) => {
            event.preventDefault();
            choose(prop);
          }}
        >
          {prop}
        </button>
      ))}
    </Popup>
  );
}

// Position the list vertically against the input (above it, flipping below only when
// there's more room there); span the full panel width, like the variable picker, so
// long property names aren't truncated in the input's narrow column. The panel is
// measured — it's a column of the window here, not the window itself. Re-measured
// whenever the list opens or its contents change.
export function useSuggestPosition({
  open,
  inputRef,
  matchCount,
  value,
}: {
  open: boolean;
  inputRef: React.RefObject<HTMLInputElement>;
  matchCount: number;
  value: string;
}): CSSProperties {
  const [position, setPosition] = useState<CSSProperties>({
    position: 'fixed',
    visibility: 'hidden',
  });
  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    const input = inputRef.current;
    if (!input) {
      return;
    }
    const rect = input.getBoundingClientRect();
    const span = panelSpan(input);
    const margin = 8;
    const gap = 4;
    const spaceAbove = rect.top - margin;
    const spaceBelow = window.innerHeight - rect.bottom - margin;
    const up = spaceAbove >= spaceBelow;
    const heightMax = Math.max(120, Math.min(340, (up ? spaceAbove : spaceBelow) - gap));
    const box = {
      position: 'fixed',
      left: span.left,
      width: span.width,
      visibility: 'visible',
    } as const;
    setPosition(up ? { ...box, bottom: window.innerHeight - rect.top + gap, maxHeight: heightMax } : { ...box, top: rect.bottom + gap, maxHeight: heightMax });
  }, [open, matchCount, value, inputRef]);
  return position;
}

// The combobox's keys: ↓/↑ open the list and move the highlight, Enter/Tab pick the
// highlighted property (Enter with none submits the row), Escape closes the list and
// then cancels the row.
export function comboKeyDown(
  event: ReactKeyboardEvent<HTMLInputElement>,
  combo: {
    open: boolean;
    active: number;
    matches: readonly string[];
    setOpen: (open: boolean) => void;
    setActive: React.Dispatch<React.SetStateAction<number>>;
    choose: (prop: string) => void;
    onEnter: () => void;
    onEscape: () => void;
  },
) {
  const { open, matches, setActive } = combo;
  const highlighted = open ? matches[combo.active] : undefined;
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      if (!open) {
        combo.setOpen(true);
        return;
      }
      setActive((previous) => Math.min(previous + 1, matches.length - 1));
      return;
    case 'ArrowUp':
      event.preventDefault();
      if (open) {
        setActive((previous) => Math.max(previous - 1, 0));
      }
      return;
    case 'Enter':
      if (highlighted) {
        event.preventDefault();
        combo.choose(highlighted);
      } else {
        combo.onEnter();
      }
      return;
    case 'Tab':
      if (highlighted) {
        event.preventDefault();
        combo.choose(highlighted);
      }
      return;
    case 'Escape':
      if (open) {
        event.preventDefault();
        event.stopPropagation();
        combo.setOpen(false);
      } else {
        combo.onEscape();
      }
      return;
    default:
      return;
  }
}

export function AddPropertyRow({ busy, onAdd }: { busy: boolean; onAdd: (prop: string, value: string, important: boolean) => void }) {
  const row = useAddProperty(onAdd);
  const { expanded, prop, setProp, value, setValue, valueRef, ready, cancel, submit } = row;
  // The project's own custom properties are properties here too — this row is
  // where one gets set, and `--brand-500` is not in any list of standard CSS.
  // Only asked for while the row is open.
  const { vars } = useSharedVars({ active: expanded });
  const custom = useMemo(() => customPropertyNames(vars), [vars]);

  if (!expanded) {
    return <AddPropertyButton busy={busy} onOpen={() => row.setExpanded(true)} />;
  }

  return (
    <div className="embed-editor_decl is-add">
      <CancelAddButton onCancel={cancel} />
      <PropertyCombobox
        value={prop}
        custom={custom}
        busy={busy}
        onChange={setProp}
        onPick={(picked) => {
          setProp(picked);
          valueRef.current?.focus();
        }}
        onEnter={row.enterName}
        onEscape={cancel}
      />
      <NewValueInput valueRef={valueRef} value={value} setValue={setValue} submit={submit} cancel={cancel} />
      <button className="embed-editor_icon-btn" type="button" onClick={submit} disabled={busy || !ready} title="Add property" aria-label="Add property">
        +
      </button>
    </div>
  );
}

// The add row's state: whether it is open, the name and value being typed, and what
// cancel, submit, and Enter on the name do.
export function useAddProperty(onAdd: (prop: string, value: string, important: boolean) => void) {
  const [expanded, setExpanded] = useState(false);
  const [prop, setProp] = useState('');
  const [value, setValue] = useState('');
  const valueRef = useRef<HTMLInputElement>(null);
  const ready = prop.trim() !== '' && value.trim() !== '';

  const cancel = () => {
    setProp('');
    setValue('');
    setExpanded(false);
  };
  const submit = () => {
    if (!ready) {
      return;
    }
    const parsed = parseImportant(value);
    onAdd(prop.trim(), parsed.value, parsed.important);
    setProp(''); // keep the row open + cleared so several can be added in a row
    setValue('');
  };
  // Enter on a name is done with the name, not done with the row: a property with no
  // value is not a declaration, and submit had nothing to write, so the key did
  // nothing at all. It goes where the rest of the answer has to be typed.
  const enterName = () => {
    if (prop.trim() && !value.trim()) {
      valueRef.current?.focus();
      return;
    }
    submit();
  };

  return {
    expanded,
    setExpanded,
    prop,
    setProp,
    value,
    setValue,
    valueRef,
    ready,
    cancel,
    submit,
    enterName,
  };
}

export function CancelAddButton({ onCancel }: { onCancel: () => void }) {
  return (
    <button className="embed-editor_icon-btn" type="button" onClick={onCancel} title="Cancel" aria-label="Cancel adding property">
      ✕
    </button>
  );
}

// The project's custom properties as property names (`--name`), sorted.
export function customPropertyNames(vars: ReadonlyArray<{ name: string }>): string[] {
  return [...new Set(vars.map((variable) => `--${variable.name}`))].sort();
}

// The new declaration's value: Enter submits the row, Escape cancels it.
export function NewValueInput({
  valueRef,
  value,
  setValue,
  submit,
  cancel,
}: {
  valueRef: React.RefObject<HTMLInputElement>;
  value: string;
  setValue: (value: string) => void;
  submit: () => void;
  cancel: () => void;
}) {
  return (
    <input
      ref={valueRef}
      className="u-input embed-editor_value-input"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          submit();
        }
        if (event.key === 'Escape') {
          cancel();
        }
      }}
      placeholder="value"
      spellCheck={false}
      aria-label="New value"
    />
  );
}

export function AddPropertyButton({ busy, onOpen }: { busy: boolean; onOpen: () => void }) {
  return (
    <button className="embed-editor_add-btn" type="button" onClick={onOpen} disabled={busy}>
      <span className="embed-editor_add-plus" aria-hidden="true">
        +
      </span>{' '}
      Add property
    </button>
  );
}

// ─────────────────────────── Section block ───────────────────────────

export type SectionToggleRequest = {
  readonly id: string;
  readonly ids: readonly string[];
  readonly next: 'open' | 'closed';
  readonly scope: 'one' | 'all';
};

export function useSectionVisibility(): readonly [ReadonlySet<string>, (request: SectionToggleRequest) => void] {
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set(['flex-child']));
  const toggle = useCallback((request: SectionToggleRequest) => {
    setClosed((previous) => {
      if (request.scope === 'all') {
        return request.next === 'open' ? new Set() : new Set(request.ids);
      }
      const next = new Set(previous);
      if (request.next === 'open') {
        next.delete(request.id);
      } else {
        next.add(request.id);
      }
      return next;
    });
  }, []);
  return [closed, toggle];
}
