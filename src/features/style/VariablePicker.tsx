// The variable picker: its collections, items and search, where it opens and
// how it closes, and keeping the panel still while it is open
// (VariableConnect.tsx).

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, MutableRefObject, RefCallback } from 'react';
import Popup from '../../ui/Popup';
import { type ProjectVariable } from './model/webflow';
import { panelBox, panelSpan } from './model/panelBox';
import { CheckIcon, VariableTypeIcon, ChevronRightIcon } from './VariableIcons';
import { varTypeAllowed, byCollection } from './sharedVars';
import { useResolvedColor } from './model/computedColor';
import { getHost } from './model/host';
import { hasCanvas, queryCanvas } from '../../editor/canvasQuery';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';

// Where the picker sits horizontally.
//
// Inside the style panel it spans the panel, flush with both edges — Webflow's shape,
// and what the panel's own fields are drawn around. It's portaled to <body>, so it has
// to measure the panel itself (panelSpan, in lib/panel-box).
//
// Anywhere else — the Variables view, whose rows are their own panel — there is no such
// column to span, and panelSpan's last resort is the style panel's published box. That
// put the menu across the app, on top of a panel the click had nothing to do with. With
// no panel around the anchor, the picker belongs under the thing that opened it.
export const FREE_MIN_WIDTH = 280;
export const FREE_MAX_WIDTH = 420;
export function pickerSpan(anchor: HTMLElement): { left: number; width: number } {
  if (panelBox(anchor)) {
    return panelSpan(anchor);
  }
  const margin = 8;
  const row = (anchor.parentElement ?? anchor).getBoundingClientRect();
  // At least readable, at most not a curtain — and never wider than the window.
  const width = Math.min(Math.max(row.width, FREE_MIN_WIDTH), FREE_MAX_WIDTH, window.innerWidth - margin * 2);
  // Left-aligned with the row, pushed back in if that would hang off the edge.
  const left = Math.max(margin, Math.min(row.left, window.innerWidth - width - margin));
  return { left, width };
}

// The picker popup: search field + grouped variable list (name + value). Portaled to
// <body>, anchored to the dot and clamped into the viewport.
export function VariablePicker({
  anchor,
  vars,
  loading,
  prop,
  selectedBinding,
  typing,
  onPreview,
  onPick,
  onClose,
}: {
  anchor: HTMLElement;
  vars: ProjectVariable[];
  loading: boolean;
  prop?: string;
  /** The currently-applied binding — highlighted and scrolled into view on open. */
  selectedBinding?: string;
  /**
   * Set while a reference is being typed in the field: the list follows the
   * typed name instead of its own search, focus stays in the field, and the
   * field's keys drive the list through `navigationRef`.
   */
  typing?: { readonly query: string; readonly navigationRef: MutableRefObject<PickerNavigation | undefined> };
  /**
   * The arrows moved the mark in the chooser's own search box: show this
   * variable in the value for now. Enter or a click makes it so; closing any
   * other way is the caller's cue to put the original back.
   */
  onPreview?: (binding: string) => void;
  onPick: (binding: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [ownSearch, setSearch] = useState('');
  const search = typing === undefined ? ownSearch : typing.query;
  // Held here rather than in the list, which unmounts while a search matches
  // nothing: what was collapsed, and whether the selection was scrolled to, both
  // outlive that.
  const selectedItemRef = useScrollToSelected();
  const [collapsed, toggleCollapse] = useCollapsedSet();
  const style = usePickerPosition(ref, anchor);
  usePickerFocus(searchRef);
  const query = search.trim().toLowerCase();
  const defined = useDefinedVariables(vars);
  const filtered = pickerVariables(vars, prop, query).filter((variable) => defined === undefined || defined.has(customPropertyOf(variable.binding) ?? ''));
  const { activeBinding, navigation } = usePickerNavigation(ref, filtered, { typing, search }, onPreview, onPick);
  // With its own search box the arrows move the purple mark itself, from the
  // applied variable to the one being previewed. Following typing, the mark
  // stays on the applied variable and the keyboard row is tinted instead.
  const markedBinding = typing === undefined ? (activeBinding ?? selectedBinding) : selectedBinding;

  return (
    <Popup
      mode="popover"
      onClose={onClose}
      anchor={anchor}
      ref={ref}
      className="embed-editor_varpicker"
      role="dialog"
      label="Connect to variable"
      style={style}
    >
      {typing === undefined ? (
        <input
          ref={searchRef}
          className="u-input embed-editor_varpicker-search"
          value={search}
          placeholder="Search variables, functions"
          spellCheck={false}
          autoFocus
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => searchKeyDown(event, navigation)}
          aria-label="Search variables"
        />
      ) : undefined}
      <div className="embed-editor_varpicker-list">
        {loading && !vars.length ? (
          <p className="embed-editor_varpicker-empty">Loading variables…</p>
        ) : !filtered.length ? (
          <p className="embed-editor_varpicker-empty">No variables found.</p>
        ) : (
          <PickerCollections
            variables={filtered}
            query={query}
            collapsed={collapsed}
            selectedBinding={markedBinding}
            activeBinding={typing === undefined ? undefined : activeBinding}
            selectedItemRef={selectedItemRef}
            onToggleCollapse={toggleCollapse}
            onPick={onPick}
          />
        )}
      </div>
    </Popup>
  );
}

// Which collections are collapsed, and the toggle for one.
export function useCollapsedSet(): [ReadonlySet<string>, (name: string) => void] {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (name: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  return [collapsed, toggle];
}

// Type-filter for the property being edited, then sort for a stable Collection →
// Group → name view, then keep what the search matches.
export function pickerVariables(vars: ProjectVariable[], prop: string | undefined, query: string): ProjectVariable[] {
  const typed = vars.filter((variable) => varTypeAllowed(prop, variable.type));
  const sorted = [...typed].sort(
    (left, right) => left.collection.localeCompare(right.collection) || left.group.localeCompare(right.group) || left.name.localeCompare(right.name),
  );
  if (!query) {
    return sorted;
  }
  return sorted.filter((variable) => `${variable.collection}/${variable.group}/${variable.name} ${variable.value}`.toLowerCase().includes(query));
}

// The list: one collapsible head per collection, its groups beneath.
export function PickerCollections({
  variables,
  query,
  collapsed,
  selectedBinding,
  activeBinding,
  selectedItemRef,
  onToggleCollapse,
  onPick,
}: {
  variables: ProjectVariable[];
  query: string;
  collapsed: ReadonlySet<string>;
  selectedBinding: string | undefined;
  /** The row the keyboard is on while a reference is typed, if any. */
  activeBinding?: string | undefined;
  selectedItemRef: RefCallback<HTMLButtonElement>;
  onToggleCollapse: (name: string) => void;
  onPick: (binding: string) => void;
}) {
  return byCollection(variables).map(({ collection, groups }) => {
    // A search always expands (so matches aren't hidden behind a collapsed head).
    const open = !!query || !collapsed.has(collection);
    return (
      <div key={collection} className="embed-editor_varpicker-collection">
        <button type="button" className="embed-editor_varpicker-collection-head" aria-expanded={open} onClick={() => onToggleCollapse(collection)}>
          <span className="embed-editor_varpicker-collection-name">{collection}</span>
          <span className={`embed-editor_varpicker-collection-arrow ${open ? 'is-open' : ''}`}>
            <ChevronRightIcon />
          </span>
        </button>
        {open
          ? groups.map(({ group, items }) => (
              <div key={group || '_'} className="embed-editor_varpicker-group">
                {group ? <div className="embed-editor_varpicker-group-name">{group}</div> : undefined}
                {items.map((variable) => (
                  <PickerItem
                    key={variable.binding}
                    variable={variable}
                    collection={collection}
                    group={group}
                    selected={sameVariable(variable.binding, selectedBinding)}
                    active={variable.binding === activeBinding}
                    selectedItemRef={selectedItemRef}
                    onPick={onPick}
                  />
                ))}
              </div>
            ))
          : undefined}
      </div>
    );
  });
}

// One variable: its type glyph, name and value, checked when it is the one applied.
export function PickerItem({
  variable,
  collection,
  group,
  selected,
  active,
  selectedItemRef,
  onPick,
}: {
  variable: ProjectVariable;
  collection: string;
  group: string;
  selected: boolean;
  active?: boolean;
  selectedItemRef: RefCallback<HTMLButtonElement>;
  onPick: (binding: string) => void;
}) {
  const selectedClassName = `${selected ? 'is-selected' : ''}${active === true ? ' is-active' : ''}`;
  const groupPrefix = group ? `${group} / ` : '';
  const valueSuffix = variable.value ? ` — ${variable.value}` : '';
  return (
    <button
      ref={selected ? selectedItemRef : undefined}
      type="button"
      className={`embed-editor_varpicker-item ${selectedClassName}`}
      aria-current={selected || undefined}
      data-binding={variable.binding}
      // A press must not take focus from the field being typed in: the pick
      // puts the caret back after the variable, and a focus change would commit
      // the half-typed value first.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onPick(variable.binding)}
      title={`${collection} / ${groupPrefix}${variable.name}${valueSuffix}`}
    >
      {variable.type === 'Color' ? (
        <VariableSwatch binding={variable.binding} />
      ) : (
        <span className="embed-editor_varpicker-item-icon" aria-hidden="true">
          <VariableTypeIcon type={variable.type} />
        </span>
      )}
      <span className="embed-editor_varpicker-item-name">{variable.name}</span>
      <span className="embed-editor_varpicker-item-value">{variable.value}</span>
      {selected ? (
        <span className="embed-editor_varpicker-item-check" aria-hidden="true">
          <CheckIcon />
        </span>
      ) : undefined}
    </button>
  );
}

// The custom property a binding names: `--dark-900` from `var(--dark-900)` or itself.
export function customPropertyOf(binding: string): string | undefined {
  return /--[\w-]+/.exec(binding)?.[0];
}

// The variables that exist on the selected element: declared on `:root`, or on
// a selector it or one of its parents matches. A variable declared on
// `.pricing_wrap` is listed in the styles, but on an element outside that
// wrapper it resolves to nothing (and its swatch to black), so it is not
// offered there. Asked of the page once per opening, since only the page
// knows which rules reach the element; undefined until it answers, or when
// there is no canvas or selection to ask, which shows every variable.
function useDefinedVariables(vars: readonly ProjectVariable[]): ReadonlySet<string> | undefined {
  const names = [...new Set(vars.flatMap((variable) => customPropertyOf(variable.binding) ?? []))].sort();
  const key = names.join(' ');
  const [defined, setDefined] = useState<{ readonly key: string; readonly names: ReadonlySet<string> } | undefined>(undefined);
  useEffect(() => {
    const host = getHost();
    const path = host.selectedId ? host.pathOf?.(host.selectedId) : undefined;
    const asked = key === '' ? [] : key.split(' ');
    // Past what one canvas question may hold, every variable is shown, unasked.
    if (path === undefined || !hasCanvas() || asked.length === 0 || asked.length > LIMITS.scanEntriesMax) {
      return undefined;
    }
    let live = true;
    assert(
      asked.every((name) => name.startsWith('--')),
      'Only custom properties are asked about',
    );
    void queryCanvas(path, [], [], asked).then((answer) => {
      if (live && answer !== undefined) {
        setDefined({ key, names: new Set(asked.filter((name) => (answer.computedProps[name] ?? '').trim() !== '')) });
      }
    });
    return () => {
      live = false;
    };
  }, [key]);
  return defined?.key === key ? defined.names : undefined;
}

// A colour variable's swatch: what it resolves to on the selected element,
// asked of the page (computedColor.ts), since a variable means nothing in the
// panel's own document and can differ by element (a theme class, a scheme).
// The checkerboard behind shows through a transparent or translucent value.
function VariableSwatch({ binding }: { binding: string }) {
  const reference = binding.trim().startsWith('--') ? `var(${binding.trim()})` : binding;
  const fill = useResolvedColor(reference);
  return (
    <span className="embed-editor_varpicker-item-swatch" aria-hidden="true">
      <span style={{ background: fill.trim() || 'transparent' }} />
    </span>
  );
}

// Scroll the selected item to the middle of the list, once, when it first mounts.
// A callback ref: React calls it with the element on mount (and `null`, its own
// protocol, on unmount).
export function useScrollToSelected(): RefCallback<HTMLButtonElement> {
  const scrolledToSelected = useRef(false);
  return (element) => {
    if (!element || scrolledToSelected.current) {
      return;
    }
    scrolledToSelected.current = true;
    // The picker mounts hidden and unsized, and is given its place and height
    // in a layout effect that runs after this ref. Centred now, the row was
    // centred in a list that then changed height under it; wait for the frame
    // that shows the list at the size it will have.
    requestAnimationFrame(() => centreInList(element));
  };
}

// Scroll the list so `element` sits in its vertical middle.
export function centreInList(element: HTMLElement): void {
  const list = element.closest<HTMLElement>('.embed-editor_varpicker-list');
  if (!list) {
    return;
  }
  const listRect = list.getBoundingClientRect();
  const itemRect = element.getBoundingClientRect();
  list.scrollTop += Math.round(itemRect.top - listRect.top - (list.clientHeight - element.clientHeight) / 2);
}

// Scroll the list just enough to show `element`. The list's own scroll, never
// scrollIntoView, which would also scroll the panels behind the portalled picker.
export function revealInList(element: HTMLElement): void {
  const list = element.closest<HTMLElement>('.embed-editor_varpicker-list');
  if (!list) {
    return;
  }
  const listRect = list.getBoundingClientRect();
  const itemRect = element.getBoundingClientRect();
  if (itemRect.top < listRect.top) {
    list.scrollTop -= Math.ceil(listRect.top - itemRect.top);
  } else if (itemRect.bottom > listRect.bottom) {
    list.scrollTop += Math.ceil(itemRect.bottom - listRect.bottom);
  }
}

// Is `binding` the same variable as `selected`? Compared by custom property, so
// `var(--h3)` and `var(--h3, 4.5rem)` are one variable.
export function sameVariable(binding: string, selected: string | undefined): boolean {
  if (selected === undefined || selected === '') {
    return false;
  }
  const property = customPropertyOf(binding);
  if (property === undefined) {
    return binding === selected;
  }
  return property === customPropertyOf(selected);
}

/** What the field's keys do to the list while a reference is typed. */
export interface PickerNavigation {
  /** Move the marked row up (-1) or down (1), wrapping at the ends. */
  readonly move: (step: 1 | -1) => void;
  /** Pick the marked row; false when there is none to pick. */
  readonly pick: () => boolean;
}

// The keyboard's row in the list. Moved by the arrows over the rows on screen,
// in the order they are drawn, so a collapsed collection is stepped over.
//
// While a reference is typed in the field the first match is marked from the
// start, since Enter there means "take it"; the keys land on the field and reach
// this through the caller's `navigationRef`. With the chooser's own search box,
// nothing is marked until an arrow is pressed, and the first press starts from
// the variable already applied, so its neighbours are one key away; Enter with
// nothing marked takes the first match of the search.
function usePickerNavigation(
  ref: React.RefObject<HTMLDivElement>,
  variables: readonly ProjectVariable[],
  {
    typing,
    search,
  }: {
    readonly typing: { readonly query: string; readonly navigationRef: MutableRefObject<PickerNavigation | undefined> } | undefined;
    readonly search: string;
  },
  onPreview: ((binding: string) => void) | undefined,
  onPick: (binding: string) => void,
): { readonly activeBinding: string | undefined; readonly navigation: PickerNavigation } {
  const [marked, setMarked] = useState<string | undefined>(undefined);
  useEffect(() => setMarked(undefined), [search]);
  const fallback = typing === undefined ? undefined : variables[0]?.binding;
  const visible = marked !== undefined && variables.some((variable) => variable.binding === marked) ? marked : undefined;
  const activeBinding = visible ?? fallback;
  const rows = (): HTMLElement[] => [...(ref.current?.querySelectorAll<HTMLElement>('.embed-editor_varpicker-item') ?? [])];
  const navigation: PickerNavigation = {
    move: (step) => {
      const list = rows();
      if (list.length === 0) {
        return;
      }
      const from = startingRow(list, activeBinding);
      const next = from < 0 ? (step === 1 ? 0 : list.length - 1) : (from + step + list.length) % list.length;
      assert(next >= 0, 'usePickerNavigation: the next row is on the list');
      assert(next < list.length, 'usePickerNavigation: the next row is on the list');
      const binding = list[next]?.dataset['binding'];
      setMarked(binding);
      if (typing === undefined && binding !== undefined) {
        onPreview?.(binding);
      }
    },
    pick: () => {
      const binding = activeBinding ?? variables[0]?.binding;
      if (binding === undefined) {
        return false;
      }
      onPick(binding);
      return true;
    },
  };
  const navigationRef = typing?.navigationRef;
  useEffect(() => {
    if (navigationRef === undefined) {
      return undefined;
    }
    navigationRef.current = navigation;
    return () => {
      navigationRef.current = undefined;
    };
  });
  // Keep the marked row in sight as the arrows move it.
  useEffect(() => {
    if (activeBinding === undefined) {
      return;
    }
    const row = [...(ref.current?.querySelectorAll<HTMLElement>('.embed-editor_varpicker-item') ?? [])].find(
      (item) => item.dataset['binding'] === activeBinding,
    );
    if (row !== undefined) {
      revealInList(row);
    }
  }, [activeBinding, ref]);
  return { activeBinding, navigation };
}

// Where the arrows start: the marked row, else the applied variable's row, else none (-1).
function startingRow(rows: readonly HTMLElement[], activeBinding: string | undefined): number {
  if (activeBinding !== undefined) {
    const index = rows.findIndex((row) => row.dataset['binding'] === activeBinding);
    if (index >= 0) {
      return index;
    }
  }
  return rows.findIndex((row) => row.classList.contains('is-selected'));
}

// The chooser's own search box: ↑ and ↓ move through the list, Enter takes the
// marked row (or the first match).
function searchKeyDown(event: React.KeyboardEvent<HTMLInputElement>, navigation: PickerNavigation): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    navigation.move(event.key === 'ArrowDown' ? 1 : -1);
  } else if (event.key === 'Enter') {
    if (navigation.pick()) {
      event.preventDefault();
    }
  }
}

// Autofocus the search on open. React's `autoFocus` no-ops because the picker mounts
// with `visibility: hidden` (a hidden element can't take focus); focus it on the next
// frame, once the positioning effect has made it visible.
export function usePickerFocus(searchRef: React.RefObject<HTMLInputElement>): void {
  useEffect(() => {
    // No search box while a reference is typed: focus stays in the field.
    const id = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [searchRef]);
}

// Drops below the row that owns the anchor (the dot's wrapper, or the chip's cell),
// flipping above only if it would overflow the bottom. Its width and left edge come
// from pickerSpan: the style panel's span inside the panel, the row's own otherwise.
export function usePickerPosition(ref: React.RefObject<HTMLDivElement>, anchor: HTMLElement): CSSProperties {
  // Measure the hidden first pass at the final width, so the height the positioning
  // effect reads is the height it will actually have.
  const [style, setStyle] = useState<CSSProperties>(() => ({
    position: 'fixed',
    top: 0,
    ...pickerSpan(anchor),
    visibility: 'hidden',
  }));
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const margin = 8;
    const row = (anchor.parentElement ?? anchor).getBoundingClientRect();
    const { height } = element.getBoundingClientRect();
    const { left, width } = pickerSpan(anchor);
    const below = row.bottom + 4;
    if (below + height <= window.innerHeight - margin) {
      // Below the row: its TOP is the edge that must stay put, and it already
      // does. Filtering shortens it from the bottom, which is where the empty
      // space belongs.
      setStyle({
        position: 'fixed',
        top: below,
        left,
        width,
        maxHeight: Math.max(0, window.innerHeight - below - margin),
        visibility: 'visible',
      });
      return;
    }
    // Flipped above: anchor the BOTTOM to the row rather than working out a top
    // from the height it happens to have right now.
    //
    // A top computed once is a top that stops being right the moment the list
    // gets shorter — and the list gets shorter on every keystroke. The box then
    // shrank away from the field it belongs to, leaving a growing gap between
    // them while its top edge stayed nailed where it opened. Held by the bottom,
    // it stays against the field and grows upward into the space it has.
    setStyle({
      position: 'fixed',
      bottom: Math.max(margin, window.innerHeight - (row.top - 4)),
      left,
      width,
      maxHeight: Math.max(0, row.top - 4 - margin),
      visibility: 'visible',
    });
  }, [ref, anchor]);
  return style;
}

// A press outside the picker (and outside its anchor) or Escape closes it.
