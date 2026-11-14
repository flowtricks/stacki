// The variable picker: its collections, items and search, where it opens and
// how it closes, and keeping the panel still while it is open
// (VariableConnect.tsx).

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MutableRefObject } from 'react';
import { SkeletonRows } from '../../ui/Skeleton';
import { SearchIcon } from '../../ui/Icons';
import { arrangeNames, shortLabel } from '../../../shared/properties/variableGroups';
import Menu, { useMenuTrigger } from '../../ui/Menu';
import { centralIcon } from '../../ui/central/CentralIcon';
import { settings as centralSettings, eyeOff as centralEyeOff } from '../../ui/central/centralGeometry';
import { useGrouped } from './pickerOptions';
import { useTranslate } from '../../lib/i18n/useTranslate';
import Popup from '../../ui/Popup';
import { type ProjectVariable } from './model/webflow';
import { panelBox, panelSpan } from './model/panelBox';
import { CheckIcon, VariableTypeIcon, ChevronRightIcon } from './VariableIcons';
import { varTypeAllowed, byCollection } from './sharedVars';
import { useResolvedColor } from './model/computedColor';
import { getHost } from './model/host';
import { hasCanvas, queryCanvas } from '../../editor/canvasQuery';
import { assert } from '../../../shared/core/assert';
import { PICKER_RESTORE_EVENT } from './CustomValueEditor';
import { resolveVariableValue, valuePredicateFor } from '../../../shared/properties/propertyValueAccepts';
import { filterBySlot, isWholeSlot, VerdictCache, type Supports, type ValueSlot } from '../../../shared/properties/valueSlot';
import { LIMITS } from '../../../shared/core/limits';
import { useHiddenVariables } from '../../ipc/useHiddenVariables';
import { suggestionNames } from '../../../shared/properties/variableVisibility';
import { sameExpression, WINNING_NAMES_MAX, type WinningDeclarationText } from '../../../shared/properties/winningDeclaration';
import { cachedAnswer, rememberAnswer, type DefinedAnswer } from './model/definedAnswers';

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

const OptionsIcon = centralIcon(centralSettings, 16);
const HiddenIcon = centralIcon(centralEyeOff, 12);

// The picker popup: search field + grouped variable list (name + value). Portaled to
// <body>, anchored to the dot and clamped into the viewport.
const ZERO_EPOCH = (): number => 0;

export function VariablePicker({
  anchor,
  vars,
  loading,
  prop,
  selectedBinding,
  slot,
  typing,
  onPreview,
  previewEpoch = ZERO_EPOCH,
  onPreviewEnd,
  onPick,
  onClose,
}: {
  anchor: HTMLElement;
  vars: ProjectVariable[];
  loading: boolean;
  prop?: string;
  /** The currently-applied binding — highlighted and scrolled into view on open. */
  selectedBinding?: string;
  /** Where the pick would land in the field's expression (valueSlot.ts); absent is the whole value. */
  slot?: ValueSlot;
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
  onPreview?: (binding: string, epoch: number) => void;
  /** The epoch a preview asked now belongs to: a restore bumps it, which drops every older preview. */
  previewEpoch?: () => number;
  /** Hovering ended without a pick (the pointer left the list, the window lost focus): put the value back. */
  onPreviewEnd?: () => void;
  onPick: (binding: string) => void;
  onClose: () => void;
}) {
  const translate = useTranslate();
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [ownSearch, setSearch] = useState('');
  const search = typing === undefined ? ownSearch : typing.query;
  // Held here rather than in the list, which unmounts while a search matches
  // nothing: what was collapsed outlives that.
  const [collapsed, toggleCollapse] = useCollapsedSet();
  const listRef = useRef<HTMLDivElement>(null);
  const style = usePickerPosition(ref, anchor);
  usePickerFocus(searchRef);
  const query = search.trim().toLowerCase();
  // The applied variable is always listed, whichever scope declares it: one the stylesheets read
  // here do not hold (a local custom property of the element or its component) gets a row of its
  // own, first, labelled as this element's, with the value the page computes for it.
  const localLabel = translate('style.variablePicker.localScope');
  const listed = useMemo(() => withAppliedVariable(vars, selectedBinding, localLabel), [vars, selectedBinding, localLabel]);
  const answer = useDefinedVariables(listed);
  const defined = answer?.names;
  const winning = answer?.winning;
  const [grouped, setGrouped] = useGrouped();
  // Session only: opening the picker always starts on the filtered list.
  const [showAll, setShowAll] = useState(false);
  const optionsMenu = useMenuTrigger();
  // "Hidden from suggestions" (the Variables panel's setting, .stacki/variables.json): hidden names are
  // left out of the list, except the variable applied to this property, and "show all" brings them back
  // dimmed. The set is cached and live, so a toggle in the panel changes an open list.
  const { hidden } = useHiddenVariables(getHost().projectPath);
  const appliedName = selectedBinding === undefined ? undefined : customPropertyOf(selectedBinding);
  const suggested = useMemo(
    () =>
      new Set(
        suggestionNames(
          listed.flatMap((variable) => customPropertyOf(variable.binding) ?? []),
          hidden,
          appliedName,
        ),
      ),
    [listed, hidden, appliedName],
  );
  const suggestible = (variable: ProjectVariable): boolean => showAll || suggested.has(customPropertyOf(variable.binding) ?? '');
  const visibleHere = (variable: ProjectVariable): boolean =>
    sameVariable(variable.binding, selectedBinding) || defined === undefined || defined.has(customPropertyOf(variable.binding) ?? '');
  // Each row shows the variable's value as WRITTEN for the selected element: the declaration that wins
  // for it (the page traces the property up the element's parents), never a computed value. The computed
  // value serves the swatch, the kind and the validity filter, and the tooltip's "Computes to" line.
  // Until the page answers, or where it cannot trace a name, the row shows the stylesheet's own text
  // (the :root declaration) and the answer swaps the text in place: rows are ordered by name, never by value.
  const overriddenHere = new Map<string, string>();
  const detailOf = new Map<string, RowDetail>();
  const withLocalValue = (variable: ProjectVariable): ProjectVariable => {
    const property = customPropertyOf(variable.binding) ?? '';
    const computed = defined?.get(property);
    const written = traceableDeclaration(winning?.get(property), computed);
    if (written !== undefined) {
      detailOf.set(variable.binding, { declaration: written, computed });
      if (variable.file !== LOCAL_FILE && !sameExpression(written.expression, variable.value)) {
        overriddenHere.set(variable.binding, variable.value);
      }
      return { ...variable, value: written.expression };
    }
    // No traced declaration: a local row has no stylesheet text, and shows none rather than a computed value.
    return variable.file === LOCAL_FILE ? { ...variable, value: '' } : variable;
  };
  const context = { computed: defined, selectedBinding, slot };
  // What the picker offers, before any search: the variables valid for the property at the slot, or
  // with "show all" every one the element can see. Group structure is judged on this list, so a
  // search narrows rows without dissolving a group.
  const offered = pickerVariables(listed, prop, '', { ...context, showAll })
    .filter(visibleHere)
    .filter(suggestible)
    .map(withLocalValue);
  // Show all marks what the filter would have refused, so it can be shown muted and still be picked.
  const refused = useMemo(() => {
    if (!showAll) {
      return new Set<string>();
    }
    const valid = new Set(
      pickerVariables(listed, prop, '', context)
        .filter(visibleHere)
        .filter((variable) => suggested.has(customPropertyOf(variable.binding) ?? ''))
        .map((variable) => variable.binding),
    );
    return new Set(offered.filter((variable) => !valid.has(variable.binding)).map((variable) => variable.binding));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the inputs are the ones listed
  }, [showAll, listed, prop, defined, selectedBinding, slot, suggested]);
  const filtered = query === '' ? offered : offered.filter((variable) => matchesQuery(variable, query));
  const drawn = useMemo(() => drawingOrder(filtered, listed, offered, { grouped }), [filtered, listed, offered, grouped]);
  const { activeBinding, navigation } = usePickerNavigation(ref, drawn, { typing, search }, onPreview, previewEpoch, onPick);
  // With its own search box the arrows move the purple mark itself, from the
  // applied variable to the one being previewed. Following typing, the mark
  // stays on the applied variable and the keyboard row is tinted instead.
  const markedBinding = typing === undefined ? (activeBinding ?? selectedBinding) : selectedBinding;
  const hover = useHoverPreview({ onPreview: typing === undefined ? onPreview : undefined, previewEpoch, onPreviewEnd });
  const endHover = hover.end;
  useEffect(() => {
    const element = ref.current;
    element?.addEventListener(PICKER_RESTORE_EVENT, endHover);
    return () => element?.removeEventListener(PICKER_RESTORE_EVENT, endHover);
  });
  const holdSelected = useHoldSelectedInView(listRef, {
    rows: filtered.map((variable) => variable.binding).join('\n'),
    following: typing === undefined && activeBinding === undefined && search === '' && selectedBinding !== undefined,
  });

  return (
    <Popup
      mode="popover"
      onClose={onClose}
      anchor={anchor}
      ref={ref}
      className="embed-editor_varpicker"
      role="dialog"
      label={translate('style.variablePicker.connectToVariable')}
      style={style}
    >
      {typing === undefined ? (
        <div className="embed-editor_varpicker-searchrow">
          <div className="embed-editor_varpicker-searchbox">
            <SearchIcon size={16} className="embed-editor_varpicker-search-icon" />
            <input
              ref={searchRef}
              className="embed-editor_varpicker-search"
              value={search}
              placeholder={translate('style.variablePicker.searchPlaceholder')}
              spellCheck={false}
              autoFocus
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => searchKeyDown(event, navigation)}
              aria-label={translate('style.variablePicker.search')}
            />
          </div>
          <button
            type="button"
            ref={optionsMenu.ref}
            className="embed-editor_varpicker-options"
            aria-label={translate('style.variablePicker.viewOptions')}
            title={translate('style.variablePicker.viewOptions')}
            aria-haspopup="menu"
            aria-expanded={optionsMenu.open}
            // Pressing it must not take focus (or the text) from the search box.
            onMouseDown={(event) => event.preventDefault()}
            onClick={optionsMenu.toggle}
          >
            <OptionsIcon size={16} />
          </button>
          <Menu
            open={optionsMenu.open}
            anchor={optionsMenu.anchor}
            label={translate('style.variablePicker.viewOptions')}
            placement="below-end"
            onClose={optionsMenu.close}
            entries={[
              {
                kind: 'item',
                id: 'group',
                label: translate('style.variablePicker.groupVariables'),
                checked: grouped,
                keepOpen: true,
                onSelect: () => setGrouped({ grouped: !grouped }),
              },
              {
                kind: 'item',
                id: 'show-all',
                label: translate('style.variablePicker.showAll'),
                checked: showAll,
                keepOpen: true,
                onSelect: () => setShowAll(!showAll),
              },
            ]}
          />
        </div>
      ) : undefined}
      <div
        ref={listRef}
        className="embed-editor_varpicker-list"
        onWheel={holdSelected.release}
        onPointerDown={holdSelected.release}
        onTouchStart={holdSelected.release}
        onPointerLeave={hover.end}
      >
        {loading && !vars.length ? (
          <div className="embed-editor_varpicker-empty">
            <SkeletonRows count={3} />
          </div>
        ) : !filtered.length ? (
          <p className="embed-editor_varpicker-empty">{translate('style.variablePicker.noVariables')}</p>
        ) : (
          <PickerCollections
            variables={filtered}
            allVariables={listed}
            offered={offered}
            grouped={grouped}
            refused={refused}
            hiddenNames={hidden}
            overridden={overriddenHere}
            details={detailOf}
            query={query}
            collapsed={collapsed}
            selectedBinding={markedBinding}
            activeBinding={typing === undefined ? undefined : activeBinding}
            onToggleCollapse={toggleCollapse}
            onPick={onPick}
            onHover={hover.enter}
          />
        )}
      </div>
    </Popup>
  );
}

// Hovering a row previews that variable on the canvas and in the field; leaving the list,
// or the window losing focus, puts the original back. The preview is the same transient
// draft the arrow keys use (VariableConnect's `preview`): never a write, a history entry
// or a save. Rapid hovers are coalesced to one update per animation frame, the latest
// winning, and a pending one is cancelled when the pointer leaves or the picker closes,
// so a stale frame can never re-show a preview after the restore. Hover events are
// pointer events dispatched by the page; nothing here depends on real pointer hardware.
function useHoverPreview({
  onPreview,
  previewEpoch,
  onPreviewEnd,
}: {
  readonly onPreview: ((binding: string, epoch: number) => void) | undefined;
  readonly previewEpoch: () => number;
  readonly onPreviewEnd: (() => void) | undefined;
}): { readonly enter: (binding: string) => void; readonly end: () => void } {
  const frame = useRef<number | undefined>(undefined);
  const latest = useRef({ onPreview, previewEpoch, onPreviewEnd });
  latest.current = { onPreview, previewEpoch, onPreviewEnd };
  // The row waiting for its frame, with the epoch it was asked in: a restore in between makes it stale.
  const pending = useRef<{ readonly binding: string; readonly epoch: number } | undefined>(undefined);
  const cancel = (): void => {
    if (frame.current !== undefined) {
      cancelAnimationFrame(frame.current);
      frame.current = undefined;
    }
    pending.current = undefined;
  };
  const end = (): void => {
    cancel();
    latest.current.onPreviewEnd?.();
  };
  // The listener reads the latest `end` through a ref, so it is added once.
  const endRef = useRef(end);
  endRef.current = end;
  useEffect(() => {
    const onBlur = (): void => endRef.current();
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('blur', onBlur);
      endRef.current();
    };
  }, []);
  const enter = (binding: string): void => {
    if (latest.current.onPreview === undefined) {
      return;
    }
    pending.current = { binding, epoch: latest.current.previewEpoch() };
    if (frame.current !== undefined) {
      return;
    }
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined;
      const next = pending.current;
      pending.current = undefined;
      // Stale by now (a restore bumped the epoch since the pointer entered): never applied.
      if (next !== undefined && next.epoch === latest.current.previewEpoch()) {
        latest.current.onPreview?.(next.binding, next.epoch);
      }
    });
  };
  return { enter, end };
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
//
// A property with a value predicate (font-weight: propertyValueAccepts.ts) keeps only the
// variables whose COMPUTED value it accepts. The source of that value is, in order:
//   1. `computed`: what the selected element's cascade gives each custom property, asked of
//      the live canvas (useDefinedVariables), so an override on an ancestor, a theme class
//      or an inline style counts;
//   2. the stylesheet declarations in `vars`, with var() chains followed, until the canvas
//      answers or when there is no canvas or element (Studio without one).
// The applied variable stays listed even when it fails, so the field never shows a value
// that is not in its own list.
export function pickerVariables(
  vars: ProjectVariable[],
  prop: string | undefined,
  query: string,
  context: {
    readonly computed?: ReadonlyMap<string, string> | undefined;
    readonly selectedBinding?: string | undefined;
    /** Where the pick would go in the field's expression; undefined is the whole value. */
    readonly slot?: ValueSlot | undefined;
    /** The engine's grammar check; defaults to the browser's CSS.supports when it has one. */
    readonly supports?: Supports | undefined;
    /** List every variable, bypassing the validity filter and the curated narrowing. */
    readonly showAll?: boolean | undefined;
  } = {},
): ProjectVariable[] {
  const declared = declaredValues(vars);
  const lookup = (name: string): string | undefined => declared.get(name);
  const computedOf = (variable: ProjectVariable): string | undefined =>
    context.computed?.get(customPropertyOf(variable.binding) ?? '') ?? resolveVariableValue(variable.value, lookup);
  const supports = context.supports ?? engineSupports();
  const typed =
    context.showAll === true || prop?.startsWith('--') === true
      ? // A custom property takes any value, and "show all" bypasses the filter: every variable is offered.
        vars
      : engineKnows(prop, supports)
        ? // The browser's own grammar decides, at the slot the pick lands in (valueSlot.ts). The
          // variable's type guess (Color, Size...) is not consulted: `10%` is no colour on its own
          // and a colour-mix() percentage inside one.
          [
            ...filterBySlot(
              vars.map((variable) => ({ item: variable, computed: computedOf(variable), keep: sameVariable(variable.binding, context.selectedBinding) })),
              prop,
              context.slot,
              supports,
              VERDICTS,
            ),
          ]
        : vars.filter((variable) => legacyAllowed(variable, prop, context, computedOf));
  const sorted = [...typed].sort(
    (left, right) =>
      Number(right.file === LOCAL_FILE) - Number(left.file === LOCAL_FILE) ||
      left.collection.localeCompare(right.collection) ||
      left.group.localeCompare(right.group) ||
      left.name.localeCompare(right.name),
  );
  if (!query) {
    return sorted;
  }
  return sorted.filter((variable) => matchesQuery(variable, query));
}

// Without an engine to ask (a test realm, a property the browser does not know), the variable's
// guessed type and the curated narrowing decide, as before. The curated narrowing is for the
// whole value only: inside calc() and the like it would hide valid factors.
function legacyAllowed(
  variable: ProjectVariable,
  prop: string | undefined,
  context: { readonly selectedBinding?: string | undefined; readonly slot?: ValueSlot | undefined },
  computedOf: (variable: ProjectVariable) => string | undefined,
): boolean {
  if (!varTypeAllowed(prop, variable.type)) {
    return false;
  }
  const accepts = valuePredicateFor(prop);
  if (accepts === undefined || !isWholeSlot(context.slot)) {
    return true;
  }
  if (sameVariable(variable.binding, context.selectedBinding)) {
    return true;
  }
  const computed = computedOf(variable);
  return computed !== undefined && accepts(computed);
}

// Verdicts shared by every picker, bounded (VALUE_SLOT_LIMITS.cacheEntriesMax).
const VERDICTS = new VerdictCache();

// The browser's CSS.supports, when this realm has one.
function engineSupports(): Supports | undefined {
  if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') {
    return undefined;
  }
  return (property, value) => CSS.supports(property, value);
}

// Does the engine know this property? Every property it knows takes a CSS-wide keyword, so a
// refusal of `inherit` means the name is the panel's own (or a typo), and the engine cannot judge it.
function engineKnows(prop: string | undefined, supports: Supports | undefined): supports is Supports {
  return supports !== undefined && prop !== undefined && !prop.startsWith('--') && supports(prop, 'inherit');
}

// The plain root scope is assumed, so its label is not drawn: `:root` and its spellings
// (`html`, `:where(:root)`). Any other selector (.dark, [data-theme], .section, `:root` inside a
// media query or state) is a different scope and keeps its label.
export function isRootScope(group: string): boolean {
  return /^(?::root|html|:where\(\s*:root\s*\))$/i.test(group.trim());
}

// The list: one collapsible head per collection, its groups beneath.
export function PickerCollections({
  variables,
  query,
  collapsed,
  selectedBinding,
  activeBinding,
  onToggleCollapse,
  onPick,
  onHover,
  allVariables,
  offered,
  grouped = true,
  refused,
  hiddenNames,
  overridden,
  details,
}: {
  variables: ProjectVariable[];
  /** Every variable the picker knows, so a scope is grouped the way the panel groups it however the list is narrowed. */
  allVariables?: readonly ProjectVariable[] | undefined;
  /** What the picker offers before the search: group sizes are judged on it. */
  offered?: readonly ProjectVariable[] | undefined;
  /** One flat list when false. */
  grouped?: boolean;
  /** Bindings listed by "show all" that are not valid for the property: drawn muted. */
  refused?: ReadonlySet<string> | undefined;
  /** Names hidden from suggestions: listed (by "show all") dimmed with a mark. */
  hiddenNames?: ReadonlySet<string> | undefined;
  /** Bindings whose winning declaration here differs from the stylesheet's base one, with that base text. */
  overridden?: ReadonlyMap<string, string> | undefined;
  /** Where each row's text was written, and what it computes to, for the tooltip. */
  details?: ReadonlyMap<string, RowDetail> | undefined;
  query: string;
  collapsed: ReadonlySet<string>;
  selectedBinding: string | undefined;
  /** The row the keyboard is on while a reference is typed, if any. */
  activeBinding?: string | undefined;
  onToggleCollapse: (name: string) => void;
  onPick: (binding: string) => void;
  /** The pointer is over this row: preview it. */
  onHover?: ((binding: string) => void) | undefined;
}) {
  const translate = useTranslate();
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
          ? groups.map(({ group, items }) => {
              const blocks = blocksOf(collection, group, items, allVariables, offered, { grouped });
              const scopeLabel = group && !isRootScope(group) ? group : undefined;
              const hasNamedGroups = blocks.some((block) => block.title !== undefined);
              const flatRun = blocks.some((block) => block.title === undefined);
              return (
                <div key={group || '_'} className="embed-editor_varpicker-group">
                  {/* A scope with no ungrouped run still names itself, on one line. */}
                  {scopeLabel !== undefined && !flatRun ? (
                    <div className="embed-editor_varpicker-group-name" title={scopeLabel}>
                      {scopeLabel}
                    </div>
                  ) : undefined}
                  {blocks.map((block) => {
                    const rows = block.items.map((variable) => {
                      const detail = details?.get(variable.binding);
                      return (
                        <PickerItem
                          key={variable.binding}
                          variable={variable}
                          collection={collection}
                          group={group}
                          {...(block.title === undefined ? {} : { label: shortLabel(`--${variable.name}`, block.title) })}
                          invalid={refused?.has(variable.binding) === true}
                          hidden={hiddenNames?.has(customPropertyOf(variable.binding) ?? '') === true}
                          {...(overridden?.has(variable.binding) === true ? { declared: overridden.get(variable.binding) ?? '' } : {})}
                          {...(detail === undefined ? {} : { detail })}
                          selected={sameVariable(variable.binding, selectedBinding)}
                          active={variable.binding === activeBinding}
                          onPick={onPick}
                          onHover={onHover}
                        />
                      );
                    });
                    // The ungrouped run is a card like the named groups when the scope has a label of
                    // its own or the scope has named groups beside it; a small project with neither
                    // keeps a plain list. Its heading is the scope's selector list (one line, the whole
                    // list in the tooltip) or, for the plain root, a neutral "Other".
                    const flatHeading =
                      block.title === undefined ? (scopeLabel ?? (hasNamedGroups ? translate('style.variablePicker.otherGroup') : undefined)) : block.title;
                    if (flatHeading === undefined) {
                      return rows;
                    }
                    // A section's heading names the group for the eye and the reader alike: the rows
                    // are options of the labelled group, the heading itself is not an option.
                    return (
                      <div key={`s:${block.title ?? ''}`} role="group" aria-label={flatHeading} className="embed-editor_varpicker-family">
                        <div className="embed-editor_varpicker-family-name" aria-hidden="true" title={flatHeading}>
                          {flatHeading}
                        </div>
                        {rows}
                      </div>
                    );
                  })}
                </div>
              );
            })
          : undefined}
      </div>
    );
  });
}

// The rows of one scope as blocks, in the panel's grouping (shared/properties/variableGroups.ts) for
// every kind of variable. Whether something is a group is decided from what the picker OFFERS (the
// validity filter and "show all" applied, the search not): a group of two or more offered variables
// stays a group however far a search narrows it, and a group with no matching row is hidden. A group
// offering one variable is a flat row under its FULL name, so `display-font` > `family` reads
// `display-font-family`. With grouping off the rows are one flat list in the panel's order. (The panel
// keeps a one-row section it was given; this list is for scanning.) Block order is stable: the flat
// run first (ungrouped names, then each flattened one in section order), then the groups.
function blocksOf(
  collection: string,
  group: string,
  items: ProjectVariable[],
  allVariables: readonly ProjectVariable[] | undefined,
  offered: readonly ProjectVariable[] | undefined,
  { grouped }: { readonly grouped: boolean },
): Array<{ readonly title: string | undefined; readonly items: ProjectVariable[] }> {
  const inScope = (variable: ProjectVariable): boolean => variable.collection === collection && variable.group === group;
  const everyName = (allVariables ?? items).filter(inScope).map((variable) => `--${variable.name}`);
  const byName = new Map<string, ProjectVariable>(items.map((variable): [string, ProjectVariable] => [`--${variable.name}`, variable]));
  const blocks = arrangeNames(everyName, new Set(byName.keys()));
  if (!blocks.some((block) => block.title !== undefined)) {
    return [{ title: undefined, items }];
  }
  const resolved = blocks.map((block) => ({ title: block.title, items: block.names.flatMap((name) => byName.get(name) ?? []) }));
  if (!grouped) {
    return [{ title: undefined, items: resolved.flatMap((block) => block.items) }];
  }
  const offeredNames = new Set((offered ?? items).filter(inScope).map((variable) => `--${variable.name}`));
  const offeredCount = new Map<string, number>();
  for (const block of arrangeNames(everyName, offeredNames)) {
    if (block.title !== undefined) {
      offeredCount.set(block.title, block.names.length);
    }
  }
  const flat: ProjectVariable[] = [];
  const groups: Array<{ readonly title: string | undefined; readonly items: ProjectVariable[] }> = [];
  for (const block of resolved) {
    if (block.title === undefined || (offeredCount.get(block.title) ?? 0) < GROUP_ROWS_MIN) {
      flat.push(...block.items);
    } else {
      groups.push(block);
    }
  }
  return [...(flat.length > 0 ? [{ title: undefined, items: flat }] : []), ...groups];
}

// Offered rows a group needs to be drawn as a group.
const GROUP_ROWS_MIN = 2;

// `filtered` in the order the rows are drawn, so the keyboard walks what the eye sees.
function drawingOrder(
  filtered: ProjectVariable[],
  allVariables: readonly ProjectVariable[],
  offered: readonly ProjectVariable[],
  options: { readonly grouped: boolean },
): ProjectVariable[] {
  const ordered: ProjectVariable[] = [];
  for (const { collection, groups } of byCollection(filtered)) {
    for (const { group, items } of groups) {
      for (const block of blocksOf(collection, group, items, allVariables, offered, options)) {
        ordered.push(...block.items);
      }
    }
  }
  return ordered;
}

// One variable: its type glyph, name and value, checked when it is the one applied.
export function PickerItem({
  variable,
  collection,
  group,
  label,
  invalid = false,
  hidden = false,
  declared,
  detail,
  selected,
  active,
  onPick,
  onHover,
}: {
  variable: ProjectVariable;
  /** The name drawn when the row sits under a group heading: the full name minus the group. */
  label?: string;
  /** Listed by "show all" though not valid for the property: muted, still pickable. */
  invalid?: boolean;
  /** Hidden from suggestions in the Variables panel: dimmed, with the eye-off mark. */
  hidden?: boolean;
  /** The stylesheet's base declaration, given when the declaration that wins for the element differs from it. */
  declared?: string;
  /** Where the row's text was written for this element, and what it computes to. */
  detail?: RowDetail;
  collection: string;
  group: string;
  selected: boolean;
  active?: boolean;
  onPick: (binding: string) => void;
  onHover?: ((binding: string) => void) | undefined;
}) {
  const translate = useTranslate();
  const selectedClassName = `${selected ? 'is-selected' : ''}${active === true ? ' is-active' : ''}${invalid ? ' is-invalid' : ''}${hidden ? ' is-hidden' : ''}${declared === undefined ? '' : ' is-overridden'}`;
  const note = [
    invalid ? translate('style.variablePicker.notValidForProperty') : '',
    hidden ? translate('variables.hidden.indicator') : '',
    declared === undefined || detail === undefined
      ? ''
      : `${translate('style.variablePicker.overriddenHere')}: ${detail.declaration.selector}${detail.declaration.file === undefined ? '' : ` (${fileLabel(detail.declaration.file)})`}`,
  ]
    .filter(Boolean)
    .join('. ');
  const groupPrefix = group ? `${group} / ` : '';
  const valueSuffix = variable.value ? ` — ${variable.value}` : '';
  const lines = detail === undefined ? [] : detailLines(variable.name, detail, translate);
  return (
    <button
      type="button"
      className={`embed-editor_varpicker-item ${selectedClassName}`}
      aria-current={selected || undefined}
      data-binding={variable.binding}
      aria-label={`--${variable.name}${variable.value ? `: ${variable.value}` : ''}`}
      // A press must not take focus from the field being typed in: the pick
      // puts the caret back after the variable, and a focus change would commit
      // the half-typed value first.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onPick(variable.binding)}
      onPointerEnter={() => onHover?.(variable.binding)}
      title={[`${collection} / ${groupPrefix}${variable.name}${valueSuffix}${note === '' ? '' : ` (${note})`}`, ...lines].join('\n')}
    >
      {variable.type === 'Color' ? (
        <VariableSwatch binding={variable.binding} />
      ) : (
        <span className="embed-editor_varpicker-item-icon" aria-hidden="true">
          <VariableTypeIcon type={variable.type} />
        </span>
      )}
      <span className="embed-editor_varpicker-item-name">{label ?? variable.name}</span>
      <span className="embed-editor_varpicker-item-value">{variable.value}</span>
      {hidden ? (
        <span className="embed-editor_varpicker-item-hidden" aria-hidden="true">
          <HiddenIcon />
        </span>
      ) : undefined}
      {selected ? (
        <span className="embed-editor_varpicker-item-check" aria-hidden="true">
          <CheckIcon />
        </span>
      ) : undefined}
    </button>
  );
}

/** Where one row's text was written for the selected element, and what it computes to there. */
export interface RowDetail {
  readonly declaration: WinningDeclarationText;
  readonly computed: string | undefined;
}

// The winning declaration, when its text can be shown next to the swatch without contradicting it.
// The page picks the winner with the browser's own cascade, so a declaration that holds a var() is
// trusted as written. A literal (no var()) must read the same as what the element computes to; when
// it does not (a condition the page could not evaluate), the row falls back to the stylesheet's text.
export function traceableDeclaration(declaration: WinningDeclarationText | undefined, computed: string | undefined): WinningDeclarationText | undefined {
  if (declaration === undefined || declaration.expression === '') {
    return undefined;
  }
  if (/var\(|env\(/i.test(declaration.expression) || computed === undefined) {
    return declaration;
  }
  return sameExpression(declaration.expression, computed) ? declaration : undefined;
}

// The tooltip's two lines: where it was written, and what it computes to.
function detailLines(name: string, detail: RowDetail, translate: ReturnType<typeof useTranslate>): string[] {
  const { declaration, computed } = detail;
  const where =
    declaration.file === undefined
      ? translate('style.variablePicker.declaredOn', { name: `--${name}`, value: declaration.expression, selector: declaration.selector })
      : translate('style.variablePicker.declaredIn', {
          name: `--${name}`,
          value: declaration.expression,
          file: fileLabel(declaration.file),
          selector: declaration.selector,
        });
  if (computed === undefined || sameExpression(computed, declaration.expression)) {
    return [where];
  }
  return [where, translate('style.variablePicker.computesTo', { value: computed })];
}

// A file's last path segment: the tooltip names the file, the selector says where in it.
function fileLabel(file: string): string {
  return file.split('/').filter(Boolean).pop() ?? file;
}

// Marks the row made for an applied variable no stylesheet read here declares.
export const LOCAL_FILE = '\u0000local';

// `vars`, plus a first row for the applied variable when none of them is it.
export function withAppliedVariable(vars: ProjectVariable[], selectedBinding: string | undefined, localLabel: string): ProjectVariable[] {
  const property = selectedBinding === undefined ? undefined : customPropertyOf(selectedBinding);
  if (property === undefined) {
    return vars;
  }
  if (vars.some((variable) => customPropertyOf(variable.binding) === property)) {
    return vars;
  }
  const local: ProjectVariable = {
    collection: localLabel,
    group: '',
    name: property.slice(2),
    value: '',
    binding: `var(${property})`,
    type: 'String',
    file: LOCAL_FILE,
  };
  return [local, ...vars];
}

// Every word of the query must be found: in the scope, the full name (`button-background`), the name
// with its dashes read as spaces (so `button background` finds it, group and name) or the value.
export function matchesQuery(variable: ProjectVariable, query: string): boolean {
  const words = query.split(/\s+/).filter(Boolean);
  const text = `${variable.collection}/${variable.group}/${variable.name} ${variable.name.replace(/-/g, ' ')} ${variable.value}`.toLowerCase();
  return words.every((word) => text.includes(word));
}

// Declared values by name without `--`, first declaration winning: the stylesheet-side lookup.
function declaredValues(vars: readonly ProjectVariable[]): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (const variable of vars) {
    const name = (customPropertyOf(variable.binding) ?? '').slice(2);
    if (name !== '' && !values.has(name)) {
      values.set(name, variable.value);
    }
  }
  return values;
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
function useDefinedVariables(vars: readonly ProjectVariable[]): DefinedAnswer | undefined {
  const names = [...new Set(vars.flatMap((variable) => customPropertyOf(variable.binding) ?? []))].sort();
  const key = names.join(' ');
  const host = getHost();
  const path = host.selectedId ? host.pathOf?.(host.selectedId) : undefined;
  const cacheKey = path === undefined ? undefined : `${path}\n${key}`;
  // The last answer for this element, shown at once while the page is asked again; the fresh one
  // replaces it in place.
  const [fresh, setFresh] = useState<{ readonly key: string; readonly answer: DefinedAnswer } | undefined>(undefined);
  useEffect(() => {
    const asked = key === '' ? [] : key.split(' ');
    // Past what one canvas question may hold, every variable is shown, unasked.
    if (path === undefined || cacheKey === undefined || !hasCanvas() || asked.length === 0 || asked.length > LIMITS.scanEntriesMax) {
      return undefined;
    }
    let live = true;
    assert(
      asked.every((name) => name.startsWith('--')),
      'Only custom properties are asked about',
    );
    // Computed values for the swatch and validity; the winning declaration, traced up the parents, for the text.
    void queryCanvas(path, [], [], asked, { winning: asked.slice(0, WINNING_NAMES_MAX) }).then((reply) => {
      if (live && reply !== undefined) {
        const answer: DefinedAnswer = {
          names: new Map(
            asked.flatMap((name): Array<[string, string]> => {
              const value = (reply.computedProps[name] ?? '').trim();
              return value === '' ? [] : [[name, value]];
            }),
          ),
          winning: new Map(Object.entries(reply.winning)),
        };
        rememberAnswer(cacheKey, answer);
        setFresh({ key: cacheKey, answer });
      }
    });
    return () => {
      live = false;
    };
  }, [key, path, cacheKey]);
  if (cacheKey === undefined) {
    return undefined;
  }
  return fresh?.key === cacheKey ? fresh.answer : cachedAnswer(cacheKey);
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

// Keep the applied variable's row in the middle of the list until the person
// takes the list over.
//
// Scrolling once, when the row first mounted, was not enough: the rows keep
// changing after the picker opens. Variables stream in on a first load, a
// reload replaces the list, and the canvas answers later which variables reach
// the selected element (useDefinedVariables), which drops rows above the
// applied one. Each change moved the row away from where it had been centred,
// so the picker opened on some other stretch of the list. So the row is centred
// again after every change of the rows, while `following` holds, until a wheel,
// a press or a touch in the list hands its scroll to the person.
//
// The centring waits for the next frame: the picker mounts hidden and unsized
// and is given its place and height in a layout effect (usePickerPosition), and
// a row centred before that is centred in a list that then changes height.
export function useHoldSelectedInView(
  listRef: React.RefObject<HTMLDivElement>,
  { rows, following }: { readonly rows: string; readonly following: boolean },
): { readonly release: () => void } {
  const released = useRef(false);
  useLayoutEffect(() => {
    if (!following) {
      // Once the arrows, a search or typing move the mark, the list is theirs.
      released.current = true;
      return undefined;
    }
    if (released.current) {
      return undefined;
    }
    const frame = requestAnimationFrame(() => {
      const list = listRef.current;
      const row = list?.querySelector<HTMLElement>('.embed-editor_varpicker-item.is-selected');
      if (row !== null && row !== undefined && !released.current) {
        centreInList(row);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [listRef, rows, following]);
  return {
    release: () => {
      released.current = true;
    },
  };
}

// Scroll the list so `element` sits in its vertical middle. The list's own
// scroll, never scrollIntoView, which would also scroll the panels behind the
// portalled picker.
export function centreInList(element: HTMLElement): void {
  const list = element.closest<HTMLElement>('.embed-editor_varpicker-list');
  if (!list) {
    return;
  }
  assert(list.contains(element), 'centreInList: the row is inside the list it scrolls');
  const listRect = list.getBoundingClientRect();
  const itemRect = element.getBoundingClientRect();
  // The popup opens with a slight scale (popup.css), and a rect is measured in
  // the scaled box while scrollTop is in the list's own pixels: undo the scale,
  // or a row far down lands short of the middle.
  const scale = list.offsetHeight > 0 && listRect.height > 0 ? listRect.height / list.offsetHeight : 1;
  assert(scale > 0, 'centreInList: the list has a positive scale');
  const offset = (itemRect.top - listRect.top) / scale;
  list.scrollTop += Math.round(offset - (list.clientHeight - element.clientHeight) / 2);
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
  onPreview: ((binding: string, epoch: number) => void) | undefined,
  previewEpoch: () => number,
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
        onPreview?.(binding, previewEpoch());
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

// The picker never grows past this, whatever room the window has, in every host (the chip control,
// the code field's typing list, Studio and the demo all render VariablePicker). It is the one cap: the CSS
// does not repeat it, because an inline max-height (the room left in the window) used to replace
// the stylesheet's and let the list run the full height of a tall window.
export const PICKER_HEIGHT_REM_MAX = 18;
// Below this the list is not usable, so a short window still gets this much, never less than
// what the window itself holds.
export const PICKER_HEIGHT_REM_MIN = 10;
const PICKER_GAP_REM = 0.25;
const PICKER_EDGE_REM = 1;

export type PickerPlacement =
  | { readonly side: 'below'; readonly top: number; readonly heightMax: number }
  | { readonly side: 'above'; readonly bottom: number; readonly heightMax: number };

// Which side of the field the picker opens on, and the most height it may take there: at most
// the cap, at most the room on that side minus the edge margin, at least the readable minimum
// (clamped to the window). It opens below when its natural height fits there, else on the side
// with more room. Pure, so the sizes can be tested without a layout engine.
export function pickerPlacement(input: {
  readonly rowTop: number;
  readonly rowBottom: number;
  readonly naturalHeight: number;
  readonly viewportHeight: number;
  readonly rootFontPx: number;
}): PickerPlacement {
  const { rowTop, rowBottom, naturalHeight, viewportHeight, rootFontPx } = input;
  assert(rootFontPx > 0, 'pickerPlacement: the root font size is positive');
  assert(viewportHeight > 0, 'pickerPlacement: the window has a height');
  const edge = PICKER_EDGE_REM * rootFontPx;
  const gap = PICKER_GAP_REM * rootFontPx;
  const capPx = PICKER_HEIGHT_REM_MAX * rootFontPx;
  const floorPx = Math.min(PICKER_HEIGHT_REM_MIN * rootFontPx, viewportHeight - 2 * edge);
  const roomBelow = viewportHeight - (rowBottom + gap) - edge;
  const roomAbove = rowTop - gap - edge;
  const fit = (room: number): number => Math.max(floorPx, Math.min(capPx, room));
  const wanted = Math.min(naturalHeight, capPx);
  if (wanted <= roomBelow || roomBelow >= roomAbove) {
    const heightMax = fit(roomBelow);
    // Held by the top edge: filtering shortens it from the bottom, where the space belongs.
    const top = Math.min(rowBottom + gap, Math.max(edge, viewportHeight - edge - heightMax));
    return { side: 'below', top, heightMax };
  }
  // Held by the bottom edge, so the box stays against the field as the list shrinks.
  const heightMax = fit(roomAbove);
  return { side: 'above', bottom: Math.max(edge, viewportHeight - (rowTop - gap)), heightMax };
}

// Drops below the row that owns the anchor (the dot's wrapper, or the chip's cell), or above it
// when there is more room there (pickerPlacement). Its width and left edge come from pickerSpan:
// the style panel's span inside the panel, the row's own otherwise.
export function usePickerPosition(ref: React.RefObject<HTMLDivElement>, anchor: HTMLElement): CSSProperties {
  // Measure the hidden first pass at the final width, so the height the positioning
  // effect reads is the height it will actually have.
  const [style, setStyle] = useState<CSSProperties>(() => ({
    position: 'fixed',
    top: 0,
    ...pickerSpan(anchor),
    maxHeight: `${PICKER_HEIGHT_REM_MAX}rem`,
    visibility: 'hidden',
  }));
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const row = (anchor.parentElement ?? anchor).getBoundingClientRect();
    const { height } = element.getBoundingClientRect();
    const { left, width } = pickerSpan(anchor);
    const rootFontPx = Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
    const placement = pickerPlacement({
      rowTop: row.top,
      rowBottom: row.bottom,
      naturalHeight: height,
      viewportHeight: window.innerHeight,
      rootFontPx,
    });
    setStyle({
      position: 'fixed',
      ...(placement.side === 'below' ? { top: placement.top } : { bottom: placement.bottom }),
      left,
      width,
      maxHeight: placement.heightMax,
      visibility: 'visible',
    });
  }, [ref, anchor]);
  return style;
}

// A press outside the picker (and outside its anchor) or Escape closes it.
