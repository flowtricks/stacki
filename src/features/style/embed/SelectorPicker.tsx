import Popup from '../../../ui/Popup';
// The selector well: the chips a selection is styled by, picking and adding
// one, and filtering global selectors (EmbedEditor.tsx).

import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import { type SegmentedOption } from '../components/SegmentedControl';
import { selectorKey, selectorsMatch } from '../model/resolved';
import { SpinnerIcon } from './EditorBasics';
import {
  type SelectorSuggestion,
  useProjectClasses,
  PROJECT_CLASS_LIMIT,
  SUGGESTION_KIND_LABEL,
  type ClassifiedSelector,
  classifySelector,
  selectorAccessibleLabel,
  type SelectorPickerProps,
} from './LayoutRows';

export function SelectorPicker({
  selectors,
  suggestions,
  activeSelector,
  activePicked,
  busy,
  loading,
  onSelect,
  onDeselect,
  onAdd,
  onVisibleSelectorsChange,
}: SelectorPickerProps) {
  const view = useSelectorView({
    selectors,
    activeSelector,
    activePicked,
    onVisibleSelectorsChange,
  });
  const field = useAddSelectorField({
    selectors,
    suggestions,
    activeSelector,
    busy,
    onSelect,
    onDeselect,
    onAdd,
  });
  const { add, showInput } = field;

  return (
    <>
      <div className="embed-editor_selectors">
        {/* One grey well wraps the selector tags; clicking empty space reveals the add
          input at its bottom (the input has no chrome of its own). */}
        <div className="embed-editor_selector-well" onMouseDown={field.onWellMouseDown}>
          {/* Nothing to show yet and the scan still running: the well would read as
            "this element has no selectors", which is a different (and wrong) answer
            than "not counted yet". A spinner where the first chip will land says
            which one it is, and holds the box's height so nothing jumps when the
            chips arrive. */}
          {loading && !view.shownSelectors.length ? (
            <div className="embed-editor_selector-loading" aria-live="polite">
              <SpinnerIcon />
              <span className="u-sr-only">Finding the selectors that style this element…</span>
            </div>
          ) : undefined}
          {view.shownSelectors.length ? (
            <SelectorChips entries={view.shownSelectors} activeSelector={activeSelector} busy={busy} onSelect={onSelect} onDeselect={onDeselect} />
          ) : undefined}
          {showInput ? (
            <SelectorAddField
              add={add}
              inputRef={field.inputRef}
              listRef={field.listRef}
              busy={busy}
              onFocus={field.onFocus}
              onBlur={field.onBlur}
              apply={field.apply}
            />
          ) : undefined}
        </div>
      </div>
      <SelectorFilterToggles view={view} busy={busy} />
    </>
  );
}

// Keep the highlighted row visible while arrowing through a long list.
export function useHighlightInView({ listRef, highlight, showList }: { listRef: React.RefObject<HTMLDivElement>; highlight: number; showList: boolean }) {
  useEffect(() => {
    if (!showList || highlight < 0) {
      return;
    }
    const element = listRef.current?.children[highlight];
    if (element instanceof HTMLElement) {
      element.scrollIntoView({ block: 'nearest' });
    }
  }, [highlight, showList, listRef]);
}

// The add-selector field's state: the draft, the suggestion list and its highlight,
// whether the input is revealed, and the selector to restore when the field is left
// without adding one.
export function useAddSelectorField({
  selectors,
  suggestions,
  activeSelector,
  busy,
  onSelect,
  onDeselect,
  onAdd,
}: Pick<SelectorPickerProps, 'selectors' | 'suggestions' | 'activeSelector' | 'busy' | 'onSelect' | 'onDeselect' | 'onAdd'>) {
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [inputOpen, setInputOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const wantFocus = useRef(false);
  // The selector that was active when the add input took focus — restored on blur
  // if no new selector was added (cleared once one is, or a chip is clicked instead).
  const restoreRef = useRef<string | undefined>(undefined);

  // The add input stays hidden until you click into the well (like Webflow's Style
  // selector) — including while selectors are still loading, so the empty box shows
  // as just the black well (with its min-height) rather than an add-selector field.
  const showInput = inputOpen;
  const filtered = useSelectorSuggestions({ selectors, suggestions, draft });
  const showList = open && filtered.length > 0;

  // Keep the highlighted row visible while arrowing through a long list.
  useHighlightInView({ listRef, highlight, showList });

  // Focus the input once it's revealed by a well click (it may have just mounted).
  useEffect(() => {
    if (showInput && wantFocus.current) {
      wantFocus.current = false;
      inputRef.current?.focus();
    }
  }, [showInput]);

  const onWellMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!wellMouseDown(event, { busy, inputRef }, restoreRef)) {
      return;
    }
    if (showInput) {
      inputRef.current?.focus();
    } else {
      wantFocus.current = true;
      setInputOpen(true);
    }
  };
  const apply = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    restoreRef.current = undefined; // a new selector is now the active one — nothing to restore
    onAdd(trimmed);
    setDraft('');
    setOpen(false);
    setHighlight(-1);
  };
  const onFocus = () => {
    restoreRef.current = activeSelector || undefined;
    onDeselect();
    setOpen(true);
  };
  const onBlur = () => {
    setOpen(false);
    setDraft('');
    setHighlight(-1);
    setInputOpen(false);
    if (restoreRef.current) {
      onSelect(restoreRef.current);
      restoreRef.current = undefined;
    }
  };
  const add = { draft, setDraft, open, setOpen, highlight, setHighlight, filtered, showList };
  return { add, showInput, listRef, inputRef, onWellMouseDown, apply, onFocus, onBlur };
}

// Clicking empty space in the well reveals + focuses the add input; clicks on a chip
// (select/deselect), the input, or the suggestion list are left alone. Returns whether
// the add input should be revealed.
export function wellMouseDown(
  event: ReactMouseEvent<HTMLDivElement>,
  well: { busy: boolean; inputRef: React.RefObject<HTMLInputElement> },
  restoreRef: React.MutableRefObject<string | undefined>,
): boolean {
  if (well.busy) {
    return false;
  }
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  // Clicking a chip selects/deselects it — don't let the input's blur restore the
  // previously-active selector over that choice.
  if (target.closest('.embed-editor_selector-chip')) {
    restoreRef.current = undefined;
    return false;
  }
  if (target.closest('.embed-editor_selector-suggest')) {
    return false;
  }
  const input = well.inputRef.current;
  if (input && target === input) {
    return false;
  }
  event.preventDefault(); // keep focus on the input rather than blurring it
  return true;
}

export type SelectorView = ReturnType<typeof useSelectorView>;

// Broad selectors are folded away behind category toggles. A selector the user picked
// stays visible so the editor below always has an understandable target. The texts
// shown are reported to `onVisibleSelectorsChange`.
export function useSelectorView({
  selectors,
  activeSelector,
  activePicked,
  onVisibleSelectorsChange,
}: Pick<SelectorPickerProps, 'selectors' | 'activeSelector' | 'activePicked'> & {
  onVisibleSelectorsChange: SelectorPickerProps['onVisibleSelectorsChange'] | undefined;
}) {
  const [showGlobals, setShowGlobals] = useState(false);
  const [showInherited, setShowInherited] = useState(false);
  const classified = useMemo(() => selectors.map(classifySelector), [selectors]);
  const globals = useMemo(() => classified.filter((entry) => entry.global), [classified]);
  const inherited = useMemo(() => classified.filter((entry) => entry.inherited), [classified]);
  const shownSelectors = useMemo(
    () =>
      classified.filter((entry) => {
        const picked = activePicked && selectorsMatch(entry.selector.text, activeSelector);
        const globalVisible = !entry.global || showGlobals;
        const inheritedVisible = !entry.inherited || showInherited;
        return picked || (globalVisible && inheritedVisible);
      }),
    [classified, showGlobals, showInherited, activeSelector, activePicked],
  );
  const visibleSelectorTexts = useMemo(() => shownSelectors.map((entry) => entry.selector.text), [shownSelectors]);
  useEffect(() => {
    onVisibleSelectorsChange?.(visibleSelectorTexts);
  }, [onVisibleSelectorsChange, visibleSelectorTexts]);
  return {
    globals,
    inherited,
    shownSelectors,
    showGlobals,
    setShowGlobals,
    showInherited,
    setShowInherited,
  };
}

// The element's own tokens first — they're what you're usually reaching for — then,
// once you've typed something, every other class in the project (the Settings panel's
// list), so styling a class this element doesn't carry yet is a matter of typing its
// first letters. They're held back while the box is empty: a project's whole class
// list would bury the handful that describe this element. Selectors already in the
// well aren't suggestions — picking one would just be the chip that's already sitting
// above the input.
export function useSelectorSuggestions({ selectors, suggestions, draft }: Pick<SelectorPickerProps, 'selectors' | 'suggestions'> & { draft: string }) {
  const projectClasses = useProjectClasses();
  const query = draft.trim().toLowerCase();
  const chipKeys = useMemo(() => new Set(selectors.map((entry) => selectorKey(entry.text))), [selectors]);
  return useMemo(() => {
    const own = suggestions.filter(
      (suggestion) => (!query || suggestion.selector.toLowerCase().includes(query)) && !chipKeys.has(selectorKey(suggestion.selector)),
    );
    if (!query) {
      return own;
    }
    const taken = new Set(own.map((suggestion) => suggestion.selector));
    const extra: SelectorSuggestion[] = [];
    for (const cls of projectClasses) {
      const selector = `.${cls}`;
      if (taken.has(selector) || chipKeys.has(selectorKey(selector))) {
        continue;
      }
      if (!cls.toLowerCase().includes(query.replace(/^\./, ''))) {
        continue;
      }
      taken.add(selector);
      extra.push({ selector, kind: 'class' });
      if (extra.length >= PROJECT_CLASS_LIMIT) {
        break;
      }
    }
    return [...own, ...extra];
  }, [suggestions, projectClasses, query, chipKeys]);
}

export function SelectorChips({
  entries,
  activeSelector,
  busy,
  onSelect,
  onDeselect,
}: {
  entries: ClassifiedSelector[];
  activeSelector: string;
  busy: boolean;
  onSelect: (selector: string) => void;
  onDeselect: () => void;
}) {
  return (
    <div className="embed-editor_selector-chips">
      {entries.map((entry) => {
        const selectorText = entry.selector;
        const active = selectorsMatch(selectorText.text, activeSelector);
        const dimmed = selectorText.inContext === false;
        // Nested rules show their nesting (`.hero { .title }`); selection/matching
        // still uses the resolved selector (sel.text).
        const label = selectorText.display ?? selectorText.text;
        return (
          <button
            key={selectorText.key}
            type="button"
            className={chipClassName(entry, { active, dimmed })}
            disabled={busy}
            aria-pressed={active}
            aria-label={selectorAccessibleLabel(entry, label)}
            // Click the active chip again to deselect (show all winners read-only).
            onClick={() => (active ? onDeselect() : onSelect(selectorText.text))}
            title={chipTitle(label, entry, { active, dimmed })}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

export interface ChipState {
  readonly active: boolean;
  readonly dimmed: boolean;
}

export function chipClassName(entry: ClassifiedSelector, state: ChipState): string {
  return [
    'embed-editor_selector-chip',
    state.active && 'is-active',
    entry.selector.pending && 'is-pending',
    entry.selector.fromComponent && 'is-component',
    entry.global && 'is-global',
    entry.inherited && 'is-inherited',
    state.dimmed && 'is-dimmed',
  ]
    .filter(Boolean)
    .join(' ');
}

export function chipTitle(label: string, entry: ClassifiedSelector, state: ChipState): string {
  if (state.active) {
    return `${label} — click to deselect`;
  }
  if (state.dimmed) {
    return `${label} — styled in another query`;
  }
  return entry.selector.pending ? `${label} — no styles yet` : label;
}

export interface AddSelectorState {
  draft: string;
  setDraft: (draft: string) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  highlight: number;
  setHighlight: React.Dispatch<React.SetStateAction<number>>;
  filtered: SelectorSuggestion[];
  showList: boolean;
}

// The add input and its suggestion list.
export function SelectorAddField({
  add,
  inputRef,
  listRef,
  busy,
  onFocus,
  onBlur,
  apply,
}: {
  add: AddSelectorState;
  inputRef: React.RefObject<HTMLInputElement>;
  listRef: React.RefObject<HTMLDivElement>;
  busy: boolean;
  onFocus: () => void;
  onBlur: () => void;
  apply: (text: string) => void;
}) {
  const { draft, setHighlight, showList } = add;
  return (
    <div className="embed-editor_selector-field">
      <input
        ref={inputRef}
        className="u-input embed-editor_selector-add"
        value={draft}
        placeholder="Add a selector (e.g. .card:hover)"
        spellCheck={false}
        disabled={busy}
        role="combobox"
        aria-expanded={showList}
        aria-autocomplete="list"
        // Focusing the add field clears the active pick — you're composing a new
        // selector, so the panel drops back to showing all winners read-only. Stash
        // the previously-active selector to restore if you leave without adding one.
        onFocus={onFocus}
        // On blur the half-typed selector is abandoned: clicking away from it is
        // not a way of adding one (Enter and the suggestion list are), and text
        // left sitting in a collapsed-looking field reads as applied. Clear it,
        // collapse the input, and re-select whatever was active before focus.
        onBlur={onBlur}
        onChange={(event) => {
          add.setDraft(event.target.value);
          add.setOpen(true);
          setHighlight(-1);
        }}
        onKeyDown={(event) => selectorKeyDown(event, add, apply)}
        aria-label="Add a selector"
      />
      {showList ? <SelectorSuggestions add={add} listRef={listRef} apply={apply} /> : undefined}
    </div>
  );
}

// The add input's keys: ↓/↑ move the highlight (opening the list), Enter adds the
// highlighted suggestion or the typed text, Tab fills the highlighted (or first)
// suggestion in to keep editing, Escape closes the list.
export function selectorKeyDown(event: ReactKeyboardEvent<HTMLInputElement>, add: AddSelectorState, apply: (text: string) => void) {
  const { highlight, filtered, showList } = add;
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    add.setOpen(true);
    add.setHighlight((previous) => Math.min(previous + 1, filtered.length - 1));
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    add.setHighlight((previous) => Math.max(previous - 1, -1));
  } else if (event.key === 'Enter') {
    event.preventDefault();
    const highlighted = showList && highlight >= 0 ? filtered[highlight] : undefined;
    apply(highlighted ? highlighted.selector : add.draft);
  } else if (event.key === 'Tab') {
    // Fill the highlighted (or first) suggestion into the input to keep editing.
    const pick = highlight >= 0 ? filtered[highlight] : filtered[0];
    if (showList && pick) {
      event.preventDefault();
      add.setDraft(pick.selector);
      add.setHighlight(-1);
    }
  } else if (event.key === 'Escape' && add.open) {
    event.preventDefault();
    add.setOpen(false);
    add.setHighlight(-1);
  }
}

// Outside the well's box — a view option, not one of the selectors. Always here, even
// with none to show: appearing when the scan lands moved everything under it down a
// row, so the panel rearranged itself under the pointer just as it became usable.
// With nothing to reveal it sits inert instead.
export function SelectorFilterToggles({ view, busy }: { view: SelectorView; busy: boolean }) {
  const { globals, inherited } = view;
  return (
    <>
      <label
        className={'embed-editor_check embed-editor_selector-filter ' + (globals.length ? '' : 'is-empty')}
        title="Tags, universal selectors, and broad states can match many elements"
      >
        <input
          type="checkbox"
          checked={view.showGlobals && globals.length > 0}
          disabled={busy || !globals.length}
          onChange={(event) => view.setShowGlobals(event.target.checked)}
        />
        <span>Show global selectors ({globals.length})</span>
      </label>
      <label
        className={'embed-editor_check embed-editor_selector-filter ' + (inherited.length ? '' : 'is-empty')}
        title="Selectors that apply because this element is inside a matching parent or ancestor"
      >
        <input
          type="checkbox"
          checked={view.showInherited && inherited.length > 0}
          disabled={busy || !inherited.length}
          onChange={(event) => view.setShowInherited(event.target.checked)}
        />
        <span>Show inherited styles ({inherited.length})</span>
      </label>
    </>
  );
}

// What somebody typed, as a query. A bare condition is the common shorthand and
// means @media — `(width < 40em)` and `width < 40em` both do.
export function asQuery(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('@')) {
    return trimmed;
  }
  return trimmed.startsWith('(') ? `@media ${trimmed}` : `@media (${trimmed})`;
}

// Sentinel option value for the "Add query" row in the context dropdown — a real
// context key is '' or an `@…` / `bp:…` string, so this can't collide.
export const ADD_QUERY = '\0add-query';

export function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export const QUERY_MODES: SegmentedOption<'wrap' | 'nest'>[] = [
  { value: 'wrap', label: 'Wrap', tooltip: 'New block — @query { selector { … } }' },
  { value: 'nest', label: 'Nest', tooltip: 'Inside the selector — selector { @query { … } }' },
];

export type QuerySuggestion = { query: string; kind: string };

// Common queries offered after any already used in the project — user-preference,
// interaction, orientation/aspect-ratio, container, and feature queries.
export const COMMON_QUERIES: QuerySuggestion[] = [
  { query: '@media (hover: hover)', kind: 'hover' },
  { query: '@media (pointer: coarse)', kind: 'touch' },
  { query: '@media (pointer: fine)', kind: 'pointer' },
  { query: '@media (prefers-color-scheme: dark)', kind: 'dark mode' },
  { query: '@media (prefers-color-scheme: light)', kind: 'light mode' },
  { query: '@media (prefers-reduced-motion: reduce)', kind: 'reduced motion' },
  { query: '@media (prefers-contrast: more)', kind: 'contrast' },
  { query: '@media (orientation: landscape)', kind: 'orientation' },
  { query: '@media (orientation: portrait)', kind: 'orientation' },
  { query: '@media (min-aspect-ratio: 16 / 9)', kind: 'aspect ratio' },
  { query: '@container (width < 50em)', kind: 'container' },
  { query: '@container (width > 30em)', kind: 'container' },
  { query: '@media (min-width: 48em)', kind: 'width' },
  { query: '@media (max-width: 47.99em)', kind: 'width' },
  { query: '@supports (display: grid)', kind: 'supports' },
];

// A query field: type anything, with every query in the project (and a curated set
// of common ones) offered underneath. Free text is the point — the list is a
// shortcut, never a menu of the only allowed answers — so submitting takes what
// is typed unless a suggestion is explicitly highlighted.
export interface QueryComboProps {
  draft: string;
  setDraft: (next: string) => void;
  onSubmit: (query: string) => void;
  onCancel: () => void;
  suggestions: QuerySuggestion[];
  ariaLabel: string;
  /** The query the field opened on, if it opened on one — a whole query rather
   *  than the start of one being typed. */
  initial?: string;
  /** Select the whole value on mount (editing) instead of parking the caret at
   *  the end of it (adding, where the value so far is just `@`). */
  selectOnFocus?: boolean;
}

function SelectorSuggestions({
  add,
  listRef,
  apply,
}: {
  readonly add: AddSelectorState;
  readonly listRef: React.RefObject<HTMLDivElement>;
  readonly apply: (text: string) => void;
}) {
  const { filtered, highlight, setHighlight } = add;
  return (
    <Popup
      mode="popover"
      portal={false}
      onClose={() => add.setOpen(false)}
      className="embed-editor_selector-suggest"
      ref={listRef}
      role="listbox"
      label="Selector suggestions"
    >
      {filtered.map((suggestion, i) => (
        <button
          key={`${suggestion.kind}:${suggestion.selector}`}
          type="button"
          role="option"
          aria-selected={i === highlight}
          className={`embed-editor_suggest-item ${i === highlight ? 'is-active' : ''}`}
          // Keep the input focused so its blur doesn't close the list before the click.
          onMouseDown={(event) => event.preventDefault()}
          onMouseMove={() => setHighlight(i)}
          onClick={() => apply(suggestion.selector)}
        >
          <span className="embed-editor_suggest-sel">{suggestion.selector}</span>
          <span className="embed-editor_suggest-kind">{SUGGESTION_KIND_LABEL[suggestion.kind]}</span>
        </button>
      ))}
    </Popup>
  );
}
