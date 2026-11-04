import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, RefObject } from 'react';
import { menuPlacement, menuWidthMaxPx, panelBounds } from '../model/panelBox';
import { assert } from '../../../../shared/core/assert';
import { isHTMLElementInDocument } from '../model/dom';
import { endDragNotes, hoverNote } from '../../../ui/sound';
import { type SelectOption, type Props } from './selectTypes';
import { SelectTrigger, SelectList } from './SelectViews';

export { type SelectOption } from './selectTypes';

/**
 * Custom listbox dropdown modeled on the clip-path preset picker: a pill button
 * showing the current value (optional icon + label + chevron) that opens a
 * floating, rounded option list. Full keyboard support (arrows / Home / End /
 * Enter / Escape / Tab / type-ahead), click-outside to close, and auto flip-up
 * when there isn't room below. Reusable across tools. Optionally searchable.
 */
export default function Select<T extends string>(props: Props<T>) {
  const select = useSelectState(props);
  const { open, refs } = select;
  const keys = selectKeyHandlers(select);
  const toggle = () => (open ? select.cancelMenu() : select.openMenu());
  return (
    <div ref={refs.root} className={selectClass(props, { open })}>
      <SelectTrigger
        props={props}
        selectedOption={select.selectedOption}
        open={open}
        buttonRef={refs.button}
        onToggle={toggle}
        onKeyDown={keys.onButtonKeyDown}
      />
      {open ? (
        <SelectList
          props={props}
          listRef={refs.list}
          searchRef={refs.search}
          dropUp={select.dropUp}
          baseId={select.baseId}
          displayed={select.displayed}
          activeIndex={select.activeIndex}
          query={select.query}
          onQuery={select.setQuery}
          onListKeyDown={keys.onListKeyDown}
          onSearchKeyDown={keys.onSearchKeyDown}
          onActivate={select.setActiveIndex}
          onLeave={select.pausePreview}
          onChoose={select.choose}
          onCancel={select.cancelMenu}
        />
      ) : undefined}
    </div>
  );
}

// Everything the control tracks: whether it is open, the filter, the highlight, the
// hover preview, and the handlers that move between them.
function useSelectState<T extends string>(props: Props<T>) {
  const { value, options, searchable = false, variant = 'default' } = props;
  const baseId = useId();
  const refs = useSelectRefs();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const optionsState = useSelectOptions({ options, value, query, searchable });
  const { selectedOption, displayed, firstSelectable, lastSelectable, selectedIndex } = optionsState;
  const highlight = usePreviewHighlight(selectedIndex);
  const { activeIndex, activity: previewActivity, activateIndex } = highlight;

  const preview = useHoverPreview({
    open,
    activity: previewActivity,
    activeIndex,
    displayed,
    value,
    props,
  });
  // Close without picking — Escape, Tab, click-outside, or toggling the trigger — puts
  // the original value back.
  const { cancelPreview } = preview;
  const { cancelMenu, pausePreview } = usePreviewDismiss({
    setOpen,
    pausePreviewActivity: highlight.pause,
    cancelPreview,
  });
  useHighlightSound({ open, activeIndex, displayed });
  const menu = useMenuActions({
    props,
    refs,
    displayed,
    selectedIndex,
    setActiveIndex: activateIndex,
    setOpen,
  });
  const choose = (index: number) => menu.choose(index, preview.commit);
  const runTypeahead = useTypeahead(activeIndex, displayed, activateIndex);
  useMenuResets({
    open,
    query,
    searchable,
    selectedIndex,
    firstSelectable,
    setActiveIndex: activateIndex,
    setQuery,
  });
  const dropUp = useListPlacement({ open, activeIndex, query, variant, refs });
  return {
    open,
    setOpen,
    refs,
    baseId,
    searchable,
    selectedOption,
    displayed,
    firstSelectable,
    lastSelectable,
    activeIndex,
    setActiveIndex: activateIndex,
    query,
    setQuery,
    dropUp,
    choose,
    cancelMenu,
    pausePreview,
    openMenu: menu.openMenu,
    move: menu.move,
    runTypeahead,
  };
}

type PreviewActivity = 'active' | 'paused';

function usePreviewDismiss({
  setOpen,
  pausePreviewActivity,
  cancelPreview,
}: {
  readonly setOpen: (open: boolean) => void;
  readonly pausePreviewActivity: () => void;
  readonly cancelPreview: () => void;
}) {
  const cancelMenu = useCallback(() => {
    setOpen(false);
    cancelPreview();
  }, [cancelPreview, setOpen]);
  const pausePreview = useCallback(() => {
    pausePreviewActivity();
    cancelPreview();
  }, [cancelPreview, pausePreviewActivity]);
  return { cancelMenu, pausePreview };
}

function usePreviewHighlight(selectedIndex: number) {
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const [activity, setActivity] = useState<PreviewActivity>('active');
  const activateIndex = useCallback((index: number) => {
    setActivity('active');
    setActiveIndex(index);
  }, []);
  const pause = useCallback(() => setActivity('paused'), []);
  return { activeIndex, activity, activateIndex, pause };
}

function useSelectOptions<T extends string>({
  options,
  value,
  query,
  searchable,
}: {
  readonly options: SelectOption<T>[];
  readonly value: T;
  readonly query: string;
  readonly searchable: boolean;
}) {
  // The trigger always reflects the real selected value, independent of any filter.
  const selectedOption = useMemo(
    () => options.find((option) => !option.heading && option.value === value) ?? options.find((option) => !option.heading),
    [options, value],
  );
  const displayed = useMemo(() => filterOptions(options, query, { searchable }), [options, query, searchable]);
  const { firstSelectable, lastSelectable } = selectableBounds(displayed);
  const found = displayed.findIndex((option) => !option.heading && option.value === value);
  const selectedIndex = found >= 0 ? found : firstSelectable;
  return { selectedOption, displayed, firstSelectable, lastSelectable, selectedIndex };
}

function useSelectRefs(): SelectRefs {
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  return useMemo(() => ({ root, button, list, search }), []);
}

type SelectRefs = {
  readonly root: RefObject<HTMLDivElement>;
  readonly button: RefObject<HTMLButtonElement>;
  readonly list: RefObject<HTMLDivElement>;
  readonly search: RefObject<HTMLInputElement>;
};

function selectClass<T extends string>(props: Props<T>, state: { readonly open: boolean }) {
  return ['u-select', props.variant === 'link' ? 'is-link' : '', state.open ? 'is-open' : '', props.disabled ? 'is-disabled' : '', props.className]
    .filter(Boolean)
    .join(' ');
}

// The rows shown in the open list — filtered while searching. A row shows when the
// query matches its GROUP HEADING (e.g. the component name) — in which case the
// whole group shows — or the row's own label. The heading is included whenever any
// of its rows show. This lets you search by component name even when every embed
// in a group has the same label ("Embed", "Embed #1", …).
function filterOptions<T extends string>(options: SelectOption<T>[], query: string, mode: { readonly searchable: boolean }): SelectOption<T>[] {
  if (!mode.searchable || !query.trim()) {
    return options;
  }
  const normalized = query.trim().toLowerCase();
  const out: SelectOption<T>[] = [];
  let heading: SelectOption<T> | undefined;
  let headingMatches = false;
  let headingPushed = false;
  for (const option of options) {
    if (option.heading) {
      heading = option;
      headingMatches = option.label.toLowerCase().includes(normalized);
      headingPushed = false;
      if (headingMatches) {
        out.push(option);
        headingPushed = true;
      }
      continue;
    }
    if (headingMatches || option.label.toLowerCase().includes(normalized)) {
      if (heading && !headingPushed) {
        out.push(heading);
        headingPushed = true;
      }
      out.push(option);
    }
  }
  return out;
}

// Headings are non-selectable — resolve the first/last real rows.
function selectableBounds<T extends string>(displayed: SelectOption<T>[]) {
  const firstSelectable = Math.max(
    0,
    displayed.findIndex((option) => !option.heading),
  );
  let lastSelectable = 0;
  for (let i = displayed.length - 1; i >= 0; i -= 1) {
    if (!displayed[i]?.heading) {
      lastSelectable = i;
      break;
    }
  }
  return { firstSelectable, lastSelectable };
}

// ── Hover preview ──────────────────────────────────────────────────────────
function useHoverPreview<T extends string>({
  open,
  activity,
  activeIndex,
  displayed,
  value,
  props,
}: {
  open: boolean;
  activity: PreviewActivity;
  activeIndex: number;
  displayed: SelectOption<T>[];
  value: T;
  props: Props<T>;
}) {
  // Read the callback through a ref: consumers pass an inline arrow, so depending on
  // its identity would re-run the emit effect (and re-emit) on every render.
  const onPreviewRef = useRef(props.onPreview);
  onPreviewRef.current = props.onPreview;
  // The value the preview last emitted — seeded with the committed value on open, so the
  // first emit only happens once the highlight moves off the selected row.
  const shownRef = useRef<T | undefined>(undefined);
  // Whether anything was previewed this session. The revert is driven off THIS, not off a
  // comparison with `value`: a live preview write can be picked up by the panel's periodic
  // rescan, which moves `value` onto the previewed value — and then a comparison would
  // conclude there was nothing to undo and leave the preview applied. The consumer knows
  // what the preview overwrote, so asking it to restore is always safe.
  const emittedRef = useRef(false);
  const cancelPreview = useCallback(() => {
    shownRef.current = undefined;
    if (!emittedRef.current) {
      return;
    }
    emittedRef.current = false;
    onPreviewRef.current?.(undefined);
  }, []);
  // A pick replaces the preview: nothing to revert.
  const commit = useCallback(() => {
    shownRef.current = undefined;
    emittedRef.current = false;
  }, []);

  // Emit as the highlight moves. Headings can't be highlighted, so anything landed on
  // is a real option; re-emitting the committed value is exactly how scrubbing back to
  // the selected row undoes the preview.
  useEffect(() => {
    if (!open || activity === 'paused' || !onPreviewRef.current) {
      return;
    }
    const option = displayed[activeIndex];
    if (!option || option.heading) {
      return;
    }
    if (shownRef.current === undefined) {
      shownRef.current = value;
    } // baseline for this session
    if (option.value === shownRef.current) {
      return;
    }
    shownRef.current = option.value;
    emittedRef.current = true;
    onPreviewRef.current(option.value);
  }, [open, activity, activeIndex, displayed, value]);

  // A preview must never outlive the menu: revert if this control unmounts (the section
  // collapsed, the selection changed) while one is showing.
  useEffect(
    () => () => {
      if (emittedRef.current) {
        onPreviewRef.current?.(undefined);
      }
    },
    [],
  );
  return { cancelPreview, commit };
}

// The highlight moving is a sound, pitched by how far down the list it is: the
// first row is the top of the scale, the last is the bottom. Driven off the
// highlight rather than off the pointer, so arrowing through a menu sounds
// the same as running down it with the mouse — it is the same movement.
//
// Not on the way in: opening a menu already parks the highlight on the
// selected row, and a note for a highlight nobody moved would sound like the
// menu answering a question that hadn't been asked.
function useHighlightSound<T extends string>({
  open,
  activeIndex,
  displayed,
}: {
  readonly open: boolean;
  readonly activeIndex: number;
  readonly displayed: SelectOption<T>[];
}): void {
  const placedRef = useRef(false);
  useEffect(() => {
    if (!open) {
      // Only on the way closed, never merely WHILE closed. `displayed` is a new
      // array each render, so this effect runs on every render of every Select
      // in the panel — and the panel is full of them. Resetting from here
      // unconditionally meant a closed dropdown wiped the note the open one had
      // just played, and the open one then played the same row again: two notes
      // for one row, from a control nobody was touching.
      if (placedRef.current) {
        placedRef.current = false;
        endDragNotes(); // the next menu sounds its first row, wherever it opens
      }
      return;
    }
    if (!placedRef.current) {
      placedRef.current = true;
      return;
    }
    if (displayed[activeIndex]) {
      hoverNote(activeIndex, displayed.length);
    }
  }, [open, activeIndex, displayed]);
}

type MenuActionsInput<T extends string> = {
  readonly props: Props<T>;
  readonly refs: SelectRefs;
  readonly displayed: SelectOption<T>[];
  readonly selectedIndex: number;
  readonly setActiveIndex: (index: number) => void;
  readonly setOpen: (open: boolean) => void;
};

function useMenuActions<T extends string>(input: MenuActionsInput<T>) {
  const { props, refs, displayed, selectedIndex, setActiveIndex, setOpen } = input;
  const { disabled, searchable = false, onChange } = props;
  const openMenu = useCallback(
    (index = selectedIndex) => {
      if (disabled) {
        return;
      }
      setActiveIndex(firstRealRow(displayed, clampIndex(index, displayed.length)));
      setOpen(true);
      window.requestAnimationFrame(() => (searchable ? refs.search.current : refs.list.current)?.focus({ preventScroll: true }));
    },
    [disabled, displayed, selectedIndex, searchable, refs, setActiveIndex, setOpen],
  );

  const choose = useCallback(
    (index: number, commitPreview: () => void) => {
      const option = displayed[index];
      if (!option || option.heading) {
        return;
      }
      commitPreview(); // committed — the pick replaces the preview, no revert
      onChange(option.value);
      setOpen(false);
      window.requestAnimationFrame(() => refs.button.current?.focus({ preventScroll: true }));
    },
    [displayed, onChange, refs, setOpen],
  );

  // Move the highlight `direction` steps, skipping heading rows and wrapping around.
  const move = useCallback(
    (from: number, direction: number) => {
      const count = displayed.length;
      if (count === 0) {
        return;
      }
      for (let step = 1; step <= count; step += 1) {
        const i = (((from + direction * step) % count) + count) % count;
        if (!displayed[i]?.heading) {
          setActiveIndex(i);
          return;
        }
      }
    },
    [displayed, setActiveIndex],
  );
  return { openMenu, choose, move };
}

// Never park the highlight on a heading — hop to the next real option.
function firstRealRow<T extends string>(displayed: SelectOption<T>[], start: number): number {
  if (!displayed[start]?.heading) {
    return start;
  }
  for (let step = 1; step <= displayed.length; step += 1) {
    const i = (start + step) % displayed.length;
    if (!displayed[i]?.heading) {
      return i;
    }
  }
  return start;
}

function useTypeahead<T extends string>(activeIndex: number, displayed: SelectOption<T>[], setActiveIndex: (index: number) => void) {
  const typeahead = useRef('');
  const typeaheadTimer = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      if (typeaheadTimer.current !== undefined) {
        window.clearTimeout(typeaheadTimer.current);
      }
    },
    [],
  );
  return useCallback(
    (key: string): boolean => {
      if (key.length !== 1 || !/\S/.test(key)) {
        return false;
      }
      if (typeaheadTimer.current !== undefined) {
        window.clearTimeout(typeaheadTimer.current);
      }
      const typed = `${typeahead.current}${key}`.toLowerCase();
      typeahead.current = typed;
      typeaheadTimer.current = window.setTimeout(() => {
        typeahead.current = '';
        typeaheadTimer.current = undefined;
      }, 500);
      // On the first keystroke, start searching after the active option so
      // repeated presses cycle; while a query is building, match from it.
      const start = (activeIndex + (typed.length === 1 ? 1 : 0)) % displayed.length;
      for (let i = 0; i < displayed.length; i += 1) {
        const index = (start + i) % displayed.length;
        const option = displayed[index];
        if (option && !option.heading && option.label.toLowerCase().startsWith(typed)) {
          setActiveIndex(index);
          return true;
        }
      }
      return false;
    },
    [activeIndex, displayed, setActiveIndex],
  );
}

function useMenuResets({
  open,
  query,
  searchable,
  selectedIndex,
  firstSelectable,
  setActiveIndex,
  setQuery,
}: {
  readonly open: boolean;
  readonly query: string;
  readonly searchable: boolean;
  readonly selectedIndex: number;
  readonly firstSelectable: number;
  readonly setActiveIndex: (index: number) => void;
  readonly setQuery: (query: string) => void;
}): void {
  // Keep the highlighted option in sync with the selected value while closed.
  useEffect(() => {
    if (!open) {
      setActiveIndex(selectedIndex);
    }
  }, [selectedIndex, open, setActiveIndex]);

  // Reset the filter when the menu closes so the next open shows the full list.
  useEffect(() => {
    if (!open) {
      setQuery('');
    }
  }, [open, setQuery]);

  // Re-highlight the first match whenever the query changes (deps intentionally just
  // `query`: firstSelectable is read from this render's filtered list).
  useEffect(() => {
    if (open && searchable) {
      setActiveIndex(firstSelectable);
    }
    // Only a new query re-highlights: opening, or the options changing, keeps the highlight.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a stale firstSelectable is intended.
  }, [query]);
}

// Close when clicking outside the control.
// Flip above the button when there isn't room below; keep the active option
// visible; and clamp horizontally so the menu never overflows the panel.
function useListPlacement({
  open,
  activeIndex,
  query,
  variant,
  refs,
}: {
  readonly open: boolean;
  readonly activeIndex: number;
  readonly query: string;
  readonly variant: 'default' | 'link';
  readonly refs: SelectRefs;
}): boolean {
  const [dropUp, setDropUp] = useState(false);
  // Distinguishes the open transition from in-list navigation (drives the one-time
  // "scroll the selected option near the top" on open).
  const wasOpenRef = useRef(false);
  const { root: rootRef, list: listRef } = refs;
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    const trigger = rootRef.current;
    const opening = !wasOpenRef.current; // true only on the open→(measure) transition
    wasOpenRef.current = true;
    if (trigger && list) {
      const rect = trigger.getBoundingClientRect();
      const listHeight = list.offsetHeight;
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      setDropUp(spaceBelow < listHeight + 8 && spaceAbove > spaceBelow);
      if (variant === 'link') {
        clampLinkMenu(trigger, list);
      }
    }
    if (list) {
      scrollActiveIntoList(list, { opening });
    }
    // `activeIndex` and `query` are what move the active row; the effect reads it
    // from the DOM rather than from them.
  }, [open, activeIndex, query, variant, rootRef, listRef]);
  return dropUp;
}

// Clamp horizontally ONLY for the link variant — its menu is fixed-width and
// anchored to the trigger's left, so it can run off the panel edge. The default
// variant stretches to the trigger's own width (left:0/right:0) and is already
// inside the panel, so it must NOT be nudged. Applied imperatively — a state-driven
// transform paints the menu at its natural position for a frame first (a jump). x is
// derived from the TRIGGER (stable) + the menu's width, not the just-mounted list's
// rect (which measured wrong on the first open). Bounds = the app's scroll container
// (the panel can be a sub-region of a wider Designer window).
//
// The shift is written to `translate`, never `transform`. The list is a popup
// surface whose open motion is a transform it transitions (popup.css); an inline
// transform replaced that motion, so the menu opened at its natural spot and slid
// sideways to the clamped one. `translate` composes with the transform instead, so
// the menu opens in place with the standard rise and scale.
function clampLinkMenu(trigger: HTMLDivElement, listElement: HTMLDivElement): void {
  const bounds = panelBounds(trigger);
  // Cap the width before measuring it: the measured width is what the shift is for.
  listElement.style.maxWidth = `${menuWidthMaxPx(bounds)}px`;
  const rect = trigger.getBoundingClientRect();
  const { shiftPx } = menuPlacement({
    anchorLeftPx: rect.left, // the menu is anchored left:0 to the trigger
    menuWidthPx: listElement.offsetWidth,
    boundsLeftPx: bounds.left,
    boundsRightPx: bounds.right,
  });
  listElement.style.translate = shiftPx === 0 ? '' : `${shiftPx}px 0`;
  assert(listElement.style.transform === '', 'clampLinkMenu: the open motion owns transform');
}

// Vertical scroll — only the LIST's own overflow (never scrollIntoView, whose inline
// axis would slide the whole panel sideways). On OPEN, bring the selected option's
// group heading right under the (sticky) search so the selection sits near the top;
// while navigating, just keep the active option in view.
function scrollActiveIntoList(listElement: HTMLDivElement, moment: { readonly opening: boolean }): void {
  const active = listElement.querySelector<HTMLElement>('[data-active="true"]');
  if (!active) {
    return;
  }
  const searchHeight = listElement.querySelector<HTMLElement>('.u-select-search')?.offsetHeight ?? 0;
  if (moment.opening) {
    let node = active.previousElementSibling;
    while (isHTMLElementInDocument(node, active.ownerDocument) && !node.classList.contains('u-select-heading')) {
      node = node.previousElementSibling;
    }
    const heading = isHTMLElementInDocument(node, active.ownerDocument) ? node : undefined;
    const anchor = heading ?? active;
    listElement.scrollTop = Math.max(0, anchor.offsetTop - searchHeight);
    return;
  }
  const listRect = listElement.getBoundingClientRect();
  const activeRect = active.getBoundingClientRect();
  if (activeRect.top < listRect.top + searchHeight) {
    listElement.scrollTop -= listRect.top + searchHeight - activeRect.top;
  } else if (activeRect.bottom > listRect.bottom) {
    listElement.scrollTop += activeRect.bottom - listRect.bottom;
  }
}

type KeyInput = {
  readonly searchable: boolean;
  readonly activeIndex: number;
  readonly firstSelectable: number;
  readonly lastSelectable: number;
  readonly openMenu: (index?: number) => void;
  readonly move: (from: number, direction: number) => void;
  readonly choose: (index: number) => void;
  readonly cancelMenu: () => void;
  readonly runTypeahead: (key: string) => boolean;
  readonly setActiveIndex: (index: number) => void;
  readonly setOpen: (open: boolean) => void;
  readonly refs: SelectRefs;
};

function selectKeyHandlers(input: KeyInput) {
  const onButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
      case 'Enter':
      case ' ':
        event.preventDefault();
        input.openMenu();
        return;
      case 'ArrowUp':
      case 'End':
        event.preventDefault();
        input.openMenu(input.lastSelectable);
        return;
      case 'Home':
        event.preventDefault();
        input.openMenu(input.firstSelectable);
        return;
      default:
        if (!input.searchable && input.runTypeahead(event.key)) {
          event.preventDefault();
          input.setOpen(true);
          window.requestAnimationFrame(() => input.refs.list.current?.focus({ preventScroll: true }));
        }
    }
  };
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === ' ') {
      event.preventDefault();
      input.choose(input.activeIndex);
      return;
    } // list has no text input
    if (navigateByKey(event, input)) {
      return;
    }
    if (input.runTypeahead(event.key)) {
      event.preventDefault();
    }
  };
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Enter/Space handling: Space types into the input, so only Enter selects.
    if (event.key === ' ') {
      return;
    }
    navigateByKey(event, input);
  };
  return { onButtonKeyDown, onListKeyDown, onSearchKeyDown };
}

// Nav keys shared by the list (non-searchable) and the search input (searchable).
function navigateByKey(event: KeyboardEvent<HTMLElement>, input: KeyInput): boolean {
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      input.move(input.activeIndex, 1);
      return true;
    case 'ArrowUp':
      event.preventDefault();
      input.move(input.activeIndex, -1);
      return true;
    case 'Home':
      event.preventDefault();
      input.setActiveIndex(input.firstSelectable);
      return true;
    case 'End':
      event.preventDefault();
      input.setActiveIndex(input.lastSelectable);
      return true;
    case 'Enter':
    case ' ':
      event.preventDefault();
      input.choose(input.activeIndex);
      return true;
    case 'Escape':
      event.preventDefault();
      input.cancelMenu();
      input.refs.button.current?.focus({ preventScroll: true });
      return true;
    case 'Tab':
      input.cancelMenu();
      return true;
    default:
      return false;
  }
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) {
    return 0;
  }
  return Math.min(length - 1, Math.max(0, index));
}
