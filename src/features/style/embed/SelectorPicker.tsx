import { centralIcon } from '../../../ui/central/CentralIcon';
import { ENGLISH_TRANSLATE } from '../../../../shared/properties/i18n/englishTranslator';
import type { Translator } from '../../../../shared/properties/i18n/messageRef';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { add as centralAdd } from '../../../ui/central/centralGeometry';
import Popup from '../../../ui/Popup';
// The selector well: the chips a selection is styled by, picking and adding
// one, and filtering global selectors (EmbedEditor.tsx).

import { loadSelectorFilters, saveSelectorFilters, type SelectorFilters } from '../model/toolPreferences';
import { parentClassPrefix } from '../model/classPrefix';
import { findNode, getHost } from '../model/host';
import { typedSelectorText } from '../model/typedSelector';
import { assert } from '../../../../shared/core/assert';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import { useHoverTip } from '../components/CssPropertyTip';
import { type SegmentedOption } from '../components/SegmentedControl';
import { CodeInline } from '../../../ui/CodeBlock';
import { selectorKey, selectorsMatch } from '../model/resolved';
import { SpinnerIcon } from './EditorBasics';
import { InlineStyleChip } from './InlineStyleChip';
import type { InlineChip } from './useInlineTarget';
import { useHeldSelection } from './heldSelection';
import { loneTypedClass, usePseudoTarget } from './editorModel';
import { classRowMatch, classRows, classRowStep, fuzzySegments, isClassName, rankFuzzy, type ClassRow, type ClassRowList } from '../../../lib/fuzzyRank';
import { chipAtCaret, chipPart, createPressWatch, type PressWatch } from '../model/selectorCaret';
import { PLACEMENT_END } from '../../../editor/classAttr';
import {
  type SelectorSuggestion,
  useProjectClasses,
  PROJECT_CLASS_LIMIT,
  SUGGESTION_KIND_LABEL_KEY,
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
  settled,
  onSelect,
  onDeselect,
  onAdd,
  onVisibleSelectorsChange,
  inline,
}: SelectorPickerProps) {
  const translate = useTranslate();
  // Another element's chips land in stages; the well draws only the finished list,
  // keeping the last one until then (heldSelection.ts).
  const held = useHeldSelection({ selectors, activeSelector, activePicked }, { settled: settled ?? true });
  const view = useSelectorView({
    selectors: held.view.selectors,
    activeSelector: held.view.activeSelector,
    activePicked: held.view.activePicked,
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
    shown: view.shownSelectors,
  });
  const { add, showInput } = field;
  const removeChip = (entry: ClassifiedSelector) => {
    removeChipFromElement(entry, { activeSelector, onDeselect });
  };

  return (
    <>
      <div className="embed-editor_selectors">
        {/* One grey well wraps the selector tags; clicking empty space reveals the add
          input at its bottom (the input has no chrome of its own). A click in a gap
          between two chips is empty space too: the field has no caret between chips,
          because a selector is not a list the person orders (the Settings panel's
          class field is, ClassInput.tsx). */}
        <div className="embed-editor_selector-well" onMouseDown={field.onWellMouseDown}>
          {/* Nothing to show yet and the scan still running: the well would read as
            "this element has no selectors", which is a different (and wrong) answer
            than "not counted yet". A spinner where the first chip will land says
            which one it is, and holds the box's height so nothing jumps when the
            chips arrive. */}
          {loading && !view.shownSelectors.length ? (
            <div className="embed-editor_selector-loading" aria-live="polite">
              <SpinnerIcon />
              <span className="u-sr-only">{translate('styleModel.embed.picker.finding')}</span>
            </div>
          ) : undefined}
          {view.shownSelectors.length || showInput || inline !== undefined ? (
            <SelectorChips
              entries={view.shownSelectors}
              // The held chips are the previous element's; so would its inline chip be.
              inline={held.holding ? undefined : inline}
              activeSelector={held.view.activeSelector}
              busy={busy}
              // The held chips are the previous element's: a click on one would
              // pick its selector for the element now selected.
              onSelect={held.holding ? ignoreHeldPick : onSelect}
              onDeselect={held.holding ? ignoreHeldPick : onDeselect}
              onRemove={held.holding ? ignoreHeldPick : removeChip}
            >
              {showInput ? (
                <SelectorAddField
                  add={add}
                  inputRef={field.inputRef}
                  listRef={field.listRef}
                  busy={busy}
                  onFocus={field.onFocus}
                  onBlur={field.onBlur}
                  apply={field.apply}
                  onCaretKey={field.onCaretKey}
                />
              ) : undefined}
            </SelectorChips>
          ) : undefined}
        </div>
      </div>
      <SelectorFilterToggles view={view} />
    </>
  );
}

// A pick on a held chip: the chip belongs to the previous element, so nothing happens.
function ignoreHeldPick(): void {}

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

// Who answers a ⌘Enter: the mounted selector field. One at most, the Style panel's.
const selectorFocusListeners = new Set<() => void>();
const SELECTOR_FOCUS_LISTENERS_MAX = 8;

/** Opens the Style panel's selector field and focuses it. False when no field is mounted yet. */
export function requestSelectorFocus(): boolean {
  for (const listener of selectorFocusListeners) {
    listener();
  }
  return selectorFocusListeners.size > 0;
}

function onSelectorFocusRequest(listener: () => void): () => void {
  selectorFocusListeners.add(listener);
  assert(selectorFocusListeners.size <= SELECTOR_FOCUS_LISTENERS_MAX, 'onSelectorFocusRequest: listeners are released on unmount');
  return () => {
    selectorFocusListeners.delete(listener);
  };
}

// Takes the class or attribute a chip stands for off the element (selectorRemoval.ts
// decides whether that is safe; the host shows a refusal). A tag, a substring
// match like `[class*="text-"]` or a compound is part of a selector, not a thing
// written on the element, so Delete leaves it alone. Returns whether a removal
// was asked for.
export function removeChipFromElement(
  entry: ClassifiedSelector,
  panel: { readonly activeSelector: string; readonly onDeselect: () => void },
  onApplied: () => void = () => undefined,
): boolean {
  const part = chipPart(entry.selector.text, loneTypedClass(entry.selector.text));
  const host = getHost();
  const request = part.kind === 'class' ? host.removeClass?.(part.name) : part.kind === 'attribute' ? host.removeAttribute?.(part.name) : undefined;
  if (request === undefined) {
    return false;
  }
  const wasActive = selectorsMatch(entry.selector.text, panel.activeSelector);
  void request.then((outcome) => {
    // The removed chip can't stay the edit target: nothing it names is left.
    if (outcome.tag === 'refused') {
      return;
    }
    if (wasActive) {
      panel.onDeselect();
    }
    onApplied();
  });
  return true;
}

// The add-selector field's state: the draft, the suggestion list and its highlight,
// whether the input is revealed, and the selector to restore when the field is left without adding one.
export function useAddSelectorField({
  selectors,
  suggestions,
  activeSelector,
  busy,
  onSelect,
  onDeselect,
  onAdd,
  shown,
}: Pick<SelectorPickerProps, 'selectors' | 'suggestions' | 'activeSelector' | 'busy' | 'onSelect' | 'onDeselect' | 'onAdd'> & {
  readonly shown: readonly ClassifiedSelector[];
}) {
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  // -1 until an arrow or the pointer moves it: the list then says where it rests.
  const [moved, setHighlight] = useState(-1);
  // The text Enter last refused; the refusal shows until the text changes.
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const [inputOpen, setInputOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const wantFocus = useRef(false);
  // The selector that was active when the add input took focus — restored on blur
  // if no new selector was added (cleared once one is, or a chip is clicked instead).
  const restoreRef = useRef<string | undefined>(undefined);
  const pressWatch = useRef<PressWatch | undefined>(undefined);

  useEffect(() => {
    const watch = createPressWatch(window);
    pressWatch.current = watch;
    return watch.dispose;
  }, []);

  // The add input stays hidden until you click into the well (like Webflow's Style
  // selector) — including while selectors are still loading, so the empty box shows
  // as just the black well (with its min-height) rather than an add-selector field.
  const showInput = inputOpen;
  const filtered = useSelectorSuggestions({ selectors, suggestions, draft });
  const typed = typedDraft(draft, selectedElementTag());
  const list = selectorRows({ typed, filtered, selectors });
  const highlight = classRowStep(moved, list);
  const refusal = refused === draft.trim();
  const showList = open && (list.rows.length > 0 || refusal);

  // Keep the highlighted row visible while arrowing through a long list.
  useHighlightInView({ listRef, highlight, showList });

  // Focus the input once it's revealed by a well click (it may have just mounted).
  useEffect(() => {
    if (showInput && wantFocus.current) {
      wantFocus.current = false;
      inputRef.current?.focus();
    }
  }, [showInput]);

  // ⌘Enter (requestSelectorFocus): open the field and put the caret in it,
  // as clicking the empty well does. The input does not exist until then.
  useEffect(
    () =>
      onSelectorFocusRequest(() => {
        if (busy) {
          return;
        }
        if (inputRef.current) {
          inputRef.current.focus();
          return;
        }
        wantFocus.current = true;
        setInputOpen(true);
      }),
    [busy],
  );

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
    // The caret is always after the last chip, so a typed class goes last.
    onAdd(trimmed, PLACEMENT_END);
    setDraft('');
    setOpen(false);
    setHighlight(-1);
  };
  const onFocus = () => {
    pressWatch.current?.cancel();
    restoreRef.current = activeSelector || undefined;
    onDeselect();
    setOpen(true);
  };
  const onBlur = () => {
    setOpen(false);
    setDraft('');
    setHighlight(-1);
    // Taking the input's row away moves the panel under the pointer, so it waits
    // for the click that caused this blur to land on what was pressed.
    pressWatch.current?.whenPressEnds(() => setInputOpen(false));
    if (restoreRef.current) {
      onSelect(restoreRef.current);
      restoreRef.current = undefined;
    }
  };
  // Backspace with nothing typed takes off the last chip, the one before the
  // caret. ← and → are left to the input: there is no caret between chips.
  // Returns whether the key was used.
  const onCaretKey = (key: string): boolean => {
    if (draft !== '') {
      return false;
    }
    if (key !== 'Backspace') {
      return false;
    }
    const index = chipAtCaret(shown.length, shown.length, key);
    const entry = index === undefined ? undefined : shown[index];
    if (entry === undefined) {
      return false;
    }
    assert(index === shown.length - 1, 'onCaretKey: Backspace takes the last chip');
    return removeChipFromElement(entry, { activeSelector, onDeselect });
  };
  const add = { draft, setDraft, open, setOpen, highlight, setHighlight, typed, list, refusal, setRefused, showList };
  return { add, showInput, listRef, inputRef, onWellMouseDown, apply, onFocus, onBlur, onCaretKey };
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

// Broad selectors can be folded away behind category toggles (shown by default). A selector the user picked
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
  // Kept for the person, across projects and launches (toolPreferences.ts).
  const [filters, setFilters] = useState(loadSelectorFilters);
  const updateFilters = (next: SelectorFilters): void => {
    setFilters(next);
    saveSelectorFilters(next);
  };
  const showGlobals = !filters.hideGlobals;
  const showInherited = !filters.hideInherited;
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
    filters,
    setHideGlobals: (hideGlobals: boolean) => updateFilters({ ...filters, hideGlobals }),
    setHideInherited: (hideInherited: boolean) => updateFilters({ ...filters, hideInherited }),
  };
}

// The element's own tokens first — they're what you're usually reaching for — then,
// once you've typed something, every other class in the project (the Settings
// panel's list), so styling a class this element doesn't carry yet is a matter of
// typing a few of its letters. They're held back while the box is empty: a
// project's whole class list would bury the handful that describe this element.
// Selectors already in the well aren't suggestions — picking one would just be the
// chip that's already sitting above the input.
//
// Typed text is matched fuzzily (src/lib/fuzzyRank.ts, shared with the Settings
// panel's class box): `btnprim` finds `.button-primary`. A leading `.` is optional
// on both sides, so `.hero` and `hero` find the same classes.
export function useSelectorSuggestions({
  selectors,
  suggestions,
  draft,
}: Pick<SelectorPickerProps, 'selectors' | 'suggestions'> & { draft: string }): RankedSuggestion[] {
  const projectClasses = useProjectClasses();
  const query = draft.trim();
  const chipKeys = useMemo(() => new Set(selectors.map((entry) => selectorKey(entry.text))), [selectors]);
  return useMemo(() => rankedSuggestions({ query, own: suggestions, projectClasses, chipKeys }), [suggestions, projectClasses, query, chipKeys]);
}

/** What the text in the add field means, as far as making a class goes. */
export type TypedDraft =
  // One class, named validly: the row and Enter both write `.name`.
  | { readonly kind: 'class'; readonly name: string }
  // One name that cannot be a class: nothing is created from it.
  | { readonly kind: 'invalid' }
  // A tag, a state, a compound, a list, a nested rule, or nothing yet.
  | { readonly kind: 'selector' };

// A word with none of a selector's own punctuation, so bare `1col` is a bad class
// name rather than a selector being written.
const BARE_WORD = /^[^\s.:#[\]>+~,*&(){}|\\@]+$/;

// Read the way Enter reads it (typedSelectorText, then loneTypedClass), so a create
// row appears exactly where Enter would put a class on the element. The class must
// be the whole text: loneTypedClass also finds one inside `.a,.b` or `.a\:b`.
export function typedDraft(draft: string, elementTag: string | undefined): TypedDraft {
  const typed = typedSelectorText(draft, elementTag);
  if (typed.includes('{')) {
    return { kind: 'selector' };
  }
  const lone = loneTypedClass(typed);
  if (lone !== undefined && typed === `.${lone}`) {
    return isClassName(lone) ? { kind: 'class', name: lone } : { kind: 'invalid' };
  }
  if (BARE_WORD.test(typed)) {
    return isClassName(typed) ? { kind: 'selector' } : { kind: 'invalid' };
  }
  return { kind: 'selector' };
}

// The list the add field draws. It rests on no row unless one is the class typed,
// because free text here is usually a selector, which Enter takes as written.
function selectorRows(inputs: {
  readonly typed: TypedDraft;
  readonly filtered: readonly RankedSuggestion[];
  readonly selectors: SelectorPickerProps['selectors'];
}): ClassRowList<RankedSuggestion> {
  const { typed, filtered, selectors } = inputs;
  const name = typed.kind === 'class' ? typed.name : undefined;
  return classRows({
    name,
    matches: filtered,
    nameOf: (suggestion) => (suggestion.selector.startsWith('.') ? suggestion.selector.slice(1) : undefined),
    carried: name === undefined ? false : hasClassChip(selectors, name),
    restPlain: -1,
  });
}

function hasClassChip(selectors: SelectorPickerProps['selectors'], name: string): boolean {
  const key = selectorKey(`.${name}`);
  return selectors.some((entry) => selectorKey(entry.text) === key);
}

/** A suggestion row, with the positions in its selector the query matched. */
export type RankedSuggestion = SelectorSuggestion & { readonly hits: readonly number[] };

// The suggestion list for a query: pure, so it is tested without React.
export function rankedSuggestions(inputs: {
  readonly query: string;
  readonly own: readonly SelectorSuggestion[];
  readonly projectClasses: readonly string[];
  readonly chipKeys: ReadonlySet<string>;
}): RankedSuggestion[] {
  const { query, chipKeys } = inputs;
  const needle = query.startsWith('.') ? query.slice(1) : query;
  const ownFree = inputs.own.filter((suggestion) => !chipKeys.has(selectorKey(suggestion.selector)));
  if (!query) {
    return ownFree.map((suggestion) => ({ ...suggestion, hits: [] }));
  }
  const own = needle
    ? rankFuzzy(needle, ownFree, { limit: ownFree.length }, dotless).map(({ item, hit }) => withHits(item, hit.indexes))
    : ownFree.map((item) => withHits(item, []));
  const taken = new Set(own.map((suggestion) => suggestion.selector));
  const candidates = inputs.projectClasses.filter((name) => {
    const selector = `.${name}`;
    return !taken.has(selector) && !chipKeys.has(selectorKey(selector));
  });
  const extra = needle
    ? rankFuzzy(needle, candidates, { limit: PROJECT_CLASS_LIMIT }, (name) => name).map(({ item, hit }) =>
        withHits({ selector: `.${item}`, kind: 'class' }, hit.indexes),
      )
    : candidates.slice(0, PROJECT_CLASS_LIMIT).map((name) => withHits({ selector: `.${name}`, kind: 'class' }, []));
  assert(extra.length <= PROJECT_CLASS_LIMIT, 'rankedSuggestions: project classes are capped');
  return [...own, ...extra];
}

// A selector without its class dot, which the query need not type.
function dotless(suggestion: SelectorSuggestion): string {
  return suggestion.selector.startsWith('.') ? suggestion.selector.slice(1) : suggestion.selector;
}

// Matched positions are in the dotless text; the row shows the dot, so they shift by one.
function withHits(suggestion: SelectorSuggestion, indexes: readonly number[]): RankedSuggestion {
  const offset = suggestion.selector.startsWith('.') ? 1 : 0;
  return { ...suggestion, hits: indexes.map((index) => index + offset) };
}

// The chips, with the add field (children) after the last one, on a row of its
// own. It never stands between two chips: see SelectorPicker.
export function SelectorChips({
  entries,
  activeSelector,
  busy,
  onSelect,
  onDeselect,
  onRemove,
  inline,
  children,
}: {
  entries: readonly ClassifiedSelector[];
  /** The style attribute's chip, after every selector: it outranks them all. */
  inline?: InlineChip | undefined;
  activeSelector: string;
  busy: boolean;
  onSelect: (selector: string) => void;
  onDeselect: () => void;
  /** Delete or Backspace on a chip: take what it stands for off the element. */
  onRemove?: (entry: ClassifiedSelector) => void;
  children?: React.ReactNode;
}) {
  // A ::before or ::after row keeps its pick (useTypedSelector), so its chip has no
  // deselect to offer.
  const deselectable = usePseudoTarget() === undefined;
  return (
    <div className="embed-editor_selector-chips">
      {entries.map((entry) => (
        <SelectorChip
          key={entry.selector.key}
          entry={entry}
          activeSelector={activeSelector}
          busy={busy}
          deselectable={deselectable}
          onSelect={onSelect}
          onDeselect={onDeselect}
          onRemove={onRemove}
        />
      ))}
      {inline === undefined ? undefined : <InlineStyleChip chip={inline} busy={busy} />}
      {children === undefined ? undefined : <div className="embed-editor_selector-caret-slot">{children}</div>}
    </div>
  );
}

// One chip. A chip whose text the well cuts off shows the whole selector in the app's
// tooltip after the panel's usual rest (useHoverTip, which also drops it on a press, a
// key, a scroll or the pointer moving off). A chip showing all its text keeps the
// native title: there is nothing more to read, only the hint.
function SelectorChip({
  entry,
  activeSelector,
  busy,
  deselectable,
  onSelect,
  onDeselect,
  onRemove,
}: {
  readonly entry: ClassifiedSelector;
  readonly activeSelector: string;
  readonly busy: boolean;
  readonly deselectable: boolean;
  readonly onSelect: (selector: string) => void;
  readonly onDeselect: () => void;
  readonly onRemove: ((entry: ClassifiedSelector) => void) | undefined;
}) {
  const translate = useTranslate();
  const selectorText = entry.selector;
  const active = selectorsMatch(selectorText.text, activeSelector);
  const state: ChipState = { active, dimmed: selectorText.inContext === false, deselectable };
  // Nested rules show their nesting (`.hero { .title }`); selection/matching
  // still uses the resolved selector (sel.text).
  const label = selectorText.display ?? selectorText.text;
  const [truncated, setTruncated] = useState(false);
  const { ref, hoverProps, hide, tip } = useHoverTip<HTMLButtonElement>(<SelectorChipTip label={label} hint={chipHint(entry, state, translate)} />);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={chipClassName(entry, state)}
        disabled={busy}
        aria-pressed={active}
        aria-label={selectorAccessibleLabel(entry, label)}
        onMouseEnter={(event) => {
          // Measured here: the well's width and the chip's text both change under it.
          // The text's own box is what cuts it (embedEditor.css).
          const text = event.currentTarget.firstElementChild;
          const cut = text !== null && chipTruncated(text);
          setTruncated(cut);
          if (cut) {
            hoverProps.onMouseEnter?.();
          }
        }}
        onMouseLeave={hoverProps.onMouseLeave}
        // Click the active chip again to deselect (show all winners read-only).
        onClick={() => {
          // Also stops a rest still running: its tip would open over the new pick.
          hide();
          if (!active) {
            onSelect(selectorText.text);
          } else if (deselectable) {
            onDeselect();
          }
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Delete' && event.key !== 'Backspace') {
            return;
          }
          // Kept from the app's Delete shortcut, which would delete the element.
          event.preventDefault();
          event.stopPropagation();
          onRemove?.(entry);
        }}
        title={truncated ? undefined : chipTitle(label, entry, state, translate)}
      >
        {/* The chip cuts from the start, so chips sharing a long prefix differ where
            they can be read. The whole selector stays here as text; embedEditor.css says how. */}
        <span className="embed-editor_selector-chip-text">
          <bdi dir="ltr">{label}</bdi>
        </span>
      </button>
      {tip}
    </>
  );
}

/** Whether a chip's text runs past its box, where the ellipsis cuts it. */
export function chipTruncated(text: Pick<Element, 'scrollWidth' | 'clientWidth'>): boolean {
  return text.scrollWidth > text.clientWidth;
}

// The whole selector as code, and what a click does on a line of its own.
function SelectorChipTip({ label, hint }: { readonly label: string; readonly hint: string | undefined }): ReactNode {
  return (
    <>
      <CodeInline text={label} language="css" className="embed-editor_selector-tip-code" />
      {hint === undefined ? undefined : <div className="u-prop-tip-note">{hint}</div>}
    </>
  );
}

export interface ChipState {
  readonly active: boolean;
  readonly dimmed: boolean;
  /** False where a click on the active chip keeps the pick. */
  readonly deselectable?: boolean;
}

export function chipClassName(entry: ClassifiedSelector, state: ChipState): string {
  return [
    'embed-editor_selector-chip',
    `is-${entry.kind}`,
    state.active && 'is-active',
    entry.selector.pending && 'is-pending',
    entry.selector.inComponentMarkup === true && 'is-component',
    entry.selector.fromInstance === true && 'is-instance',
    entry.global && 'is-global',
    entry.inherited && 'is-inherited',
    state.dimmed && 'is-dimmed',
  ]
    .filter(Boolean)
    .join(' ');
}

export function chipTitle(label: string, entry: ClassifiedSelector, state: ChipState, translate: Translator = ENGLISH_TRANSLATE): string {
  const hint = chipHint(entry, state, translate);
  return hint === undefined ? label : `${label} — ${hint}`;
}

/** What a chip says beyond its selector: what a click does, or why it reads as it does. */
export function chipHint(entry: ClassifiedSelector, state: ChipState, translate: Translator = ENGLISH_TRANSLATE): string | undefined {
  if (state.active) {
    return state.deselectable === false ? undefined : translate('styleModel.embed.picker.chipDeselect');
  }
  if (state.dimmed) {
    return translate('styleModel.embed.picker.chipOtherQuery');
  }
  // A class the instance passed in says so: it is the page's class, and its rule
  // is written there rather than into the component (model/instanceClasses.ts).
  if (entry.selector.fromInstance === true) {
    return entry.selector.pending ? translate('styleModel.embed.picker.chipInstancePending') : translate('styleModel.embed.picker.chipInstance');
  }
  return entry.selector.pending ? translate('styleModel.embed.picker.chipPending') : undefined;
}

export interface AddSelectorState {
  draft: string;
  setDraft: (draft: string) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  highlight: number;
  setHighlight: (index: number) => void;
  typed: TypedDraft;
  list: ClassRowList<RankedSuggestion>;
  /** Whether Enter refused the text now in the field. */
  refusal: boolean;
  setRefused: (text: string) => void;
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
  onCaretKey,
}: {
  add: AddSelectorState;
  inputRef: React.RefObject<HTMLInputElement>;
  listRef: React.RefObject<HTMLDivElement>;
  busy: boolean;
  onFocus: () => void;
  onBlur: () => void;
  apply: (text: string) => void;
  onCaretKey?: (key: string) => boolean;
}) {
  const translate = useTranslate();
  const { draft, setHighlight, showList } = add;
  return (
    <div className="embed-editor_selector-field">
      <input
        ref={inputRef}
        className="u-input embed-editor_selector-add"
        value={draft}
        placeholder={translate('styleModel.embed.picker.addPlaceholder', { example: '.card:hover' })}
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
        onKeyDown={(event) => {
          if (onCaretKey?.(event.key) === true) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          selectorKeyDown(event, add, apply);
        }}
        aria-label={translate('styleModel.embed.picker.addLabel')}
      />
      {showList ? <SelectorSuggestions add={add} listRef={listRef} apply={apply} /> : undefined}
    </div>
  );
}

// The add input's keys: ↓/↑ move the highlight (opening the list), Enter adds the
// selected row or the typed text and refuses a name that cannot be a class, Tab
// fills the highlighted (or first) suggestion in to keep editing, Escape closes
// the list, and → in the empty box fills in the start of the parent's class.
export function selectorKeyDown(event: ReactKeyboardEvent<HTMLInputElement>, add: AddSelectorState, apply: (text: string) => void) {
  const { highlight, list, showList } = add;
  if (event.key === 'ArrowRight' && add.draft === '') {
    // → in the empty box starts a class in the parent's naming scheme:
    // `.stat_card_` from a parent's `stat_card_title` (classPrefix.ts).
    const host = getHost();
    const prefix = parentClassPrefix(host.nodes, host.selectedId);
    if (prefix !== undefined) {
      event.preventDefault();
      add.setDraft(prefix);
      add.setOpen(true);
      add.setHighlight(-1);
    }
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    add.setOpen(true);
    add.setHighlight(classRowStep(highlight + 1, list));
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    add.setHighlight(classRowStep(highlight - 1, list));
  } else if (event.key === 'Enter') {
    event.preventDefault();
    const row = showList ? list.rows[highlight] : undefined;
    if (row !== undefined) {
      apply(selectorRowText(row));
    } else if (add.typed.kind === 'invalid') {
      add.setRefused(add.draft.trim());
      add.setOpen(true);
    } else {
      // Typed text is read the way people mean it, a bare name as a class
      // (typedSelector.ts).
      apply(typedSelectorText(add.draft, selectedElementTag()));
    }
  } else if (event.key === 'Tab') {
    // Fill the highlighted (or first) suggestion into the input to keep editing.
    const pick = classRowMatch(list, highlight);
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
// It is never disabled: the choice is remembered, so it can be set before there
// is anything to hide, and greyed out it read as broken.
export function SelectorFilterToggles({ view }: { view: SelectorView }) {
  const translate = useTranslate();
  const { globals, inherited } = view;
  return (
    <>
      <label className="embed-editor_check embed-editor_selector-filter" title={translate('styleModel.embed.picker.hideGlobalsTip')}>
        <input type="checkbox" checked={view.filters.hideGlobals} onChange={(event) => view.setHideGlobals(event.target.checked)} />
        <span>{translate('styleModel.embed.picker.hideGlobals', { count: globals.length })}</span>
      </label>
      <label className="embed-editor_check embed-editor_selector-filter" title={translate('styleModel.embed.picker.hideInheritedTip')}>
        <input type="checkbox" checked={view.filters.hideInherited} onChange={(event) => view.setHideInherited(event.target.checked)} />
        <span>{translate('styleModel.embed.picker.hideInherited', { count: inherited.length })}</span>
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

export const PlusIcon = centralIcon(centralAdd, 12);

export const queryModes = (translate: Translator): SegmentedOption<'wrap' | 'nest'>[] => [
  {
    value: 'wrap',
    label: translate('styleModel.embed.query.wrap'),
    tooltip: translate('styleModel.embed.query.wrapTip', { code: '@query { selector { … } }' }),
  },
  {
    value: 'nest',
    label: translate('styleModel.embed.query.nest'),
    tooltip: translate('styleModel.embed.query.nestTip', { code: 'selector { @query { … } }' }),
  },
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
  const translate = useTranslate();
  const { list, highlight, setHighlight, refusal } = add;
  return (
    <Popup
      mode="popover"
      portal={false}
      onClose={() => add.setOpen(false)}
      className="embed-editor_selector-suggest"
      ref={listRef}
      role="listbox"
      label={translate('styleModel.embed.picker.suggestions')}
    >
      {list.rows.map((row, i) => (
        <button
          key={row.kind === 'create' ? `create:${row.name}` : `${row.item.kind}:${row.item.selector}`}
          type="button"
          role="option"
          aria-selected={i === highlight}
          className={`embed-editor_suggest-item ${i === highlight ? 'is-active' : ''}`}
          // Keep the input focused so its blur doesn't close the list before the click.
          onMouseDown={(event) => event.preventDefault()}
          onMouseMove={() => setHighlight(i)}
          onClick={() => apply(selectorRowText(row))}
        >
          <SelectorRowLabel row={row} />
        </button>
      ))}
      {/* Last, so a row's place among the children stays its index in the list. */}
      {refusal ? (
        <div className="embed-editor_suggest-note" role="status">
          {translate('styleModel.embed.picker.classRefusal')}
        </div>
      ) : undefined}
    </Popup>
  );
}

// A suggestion row is the exact selector it shows; a create row is the class it names.
function selectorRowText(row: ClassRow<RankedSuggestion>): string {
  return row.kind === 'create' ? `.${row.name}` : row.item.selector;
}

function SelectorRowLabel({ row }: { readonly row: ClassRow<RankedSuggestion> }) {
  const translate = useTranslate();
  if (row.kind === 'create') {
    return (
      <>
        <span className="embed-editor_suggest-sel">{translate('styleModel.embed.picker.create', { name: row.name })}</span>
        <span className="embed-editor_suggest-kind">{translate(SUGGESTION_KIND_LABEL_KEY.class)}</span>
      </>
    );
  }
  const suggestion = row.item;
  return (
    <>
      <span className="embed-editor_suggest-sel">
        {fuzzySegments(suggestion.selector, suggestion.hits).map((segment, index) =>
          segment.hit ? (
            <mark key={index} className="embed-editor_suggest-hit">
              {segment.text}
            </mark>
          ) : (
            segment.text
          ),
        )}
      </span>
      <span className="embed-editor_suggest-kind">{translate(SUGGESTION_KIND_LABEL_KEY[suggestion.kind])}</span>
    </>
  );
}

// The selected element's tag, so typing its own name (a custom element's
// included) still means the tag rather than a class.
function selectedElementTag(): string | undefined {
  const host = getHost();
  if (host.selectedId === undefined) {
    return undefined;
  }
  const node = findNode(host.nodes, host.selectedId);
  return node?.kind === 'element' ? node.name : undefined;
}
