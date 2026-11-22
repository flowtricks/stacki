// The Add elements panel: Webflow's Add panel for Stacki. A search box, then collapsible groups of square tiles
// (an icon over a friendly name, three to a row): every HTML tag the editor inserts, and the Astro constructs it
// writes (elementsCatalog.ts). A click, Enter or Space inserts the tile where the selection points, through the
// host's insert (the same path as the insert palette's pick). A tile dragged onto the canvas or the Navigator is
// inserted where it lands: the tile writes its choice into the drag (src/editor/insertDragData.ts) and into the
// window's drag record (src/editor/dragState.ts), and the existing drop targets place it. The host is told when a
// drag starts and ends, so it can show the Navigator for it.
//
// The data is static, so the panel renders whole in its first frame: no loading state, no skeleton.
//
// Layout (addElements.css): the title, the search box, the section and group headings and the tile grid share
// one inset, so every left edge lines up; tile names wrap onto a second line instead of being cut short.
import React, { useMemo, useRef, useState } from 'react';
import { assert } from '../../../shared/core/assert';
import { allowDragEffect, clearDrag, setDrag } from '../../editor/dragState';
import { INSERT_DRAG_TYPE, insertDragText, type InsertDragChoice } from '../../editor/insertDragData';
import type { MessageKey } from '../../lib/i18n/localeContext';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { CodeInline } from '../../ui/CodeBlock';
import { tooltipAnchor, useDelayedPlacement, type TooltipAnchor } from '../../ui/delayedTooltip';
import FittedTooltip from '../../ui/FittedTooltip';
import {
  BracesIcon,
  BranchIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CodeIcon,
  CollapseVerticalIcon,
  CommentIcon,
  ElementComponentIcon,
  ExpandVerticalIcon,
  RepeatIcon,
  TextIcon,
  astroAssetIcon,
  elementIcon,
} from '../../ui/Icons';
import { PanelHeader } from '../../ui/PanelHeader';
import { PanelSearch } from '../../ui/PanelSearch';
import {
  ELEMENT_GROUP_IDS,
  ELEMENT_GROUPS,
  filterElementGroups,
  foldAllAction,
  moveElementFocus,
  type ElementGroup,
  type ElementGroupId,
  type ElementSectionId,
  type ElementTile,
} from './elementsCatalog';
import type { GridMove } from './insertGrid';
import type { InsertItem } from './insertItem';
import './addElements.css';

export interface AddElementsPanelProps {
  /** Whether the open file is a component, the only place a slot means something. */
  readonly allowSlot: boolean;
  /** Inserts at the selection: the host's insert, the one the insert palette uses. */
  readonly onInsert: (item: InsertItem) => void;
  /** The Component tile: show the project's components to pick from. */
  readonly onPickComponent: () => void;
  /** A tile's drag began or ended, however it ended. */
  readonly onDragPhase?: ((phase: 'start' | 'end') => void) | undefined;
}

const GRID_KEYS: Readonly<Record<string, GridMove>> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };

const SECTION_LABELS: Readonly<Record<ElementSectionId, MessageKey>> = { html: 'elements.section.html', astro: 'elements.section.astro' };

// The groups the person folded, remembered for the app session so switching rail panels and coming back keeps
// them folded. In memory only, as transcriptUi.ts does: a reload starts with every group open. Bounded by the
// catalog's group count, since it only ever holds group ids.
let sessionCollapsed: ReadonlySet<ElementGroupId> = new Set();

export default function AddElementsPanel(props: AddElementsPanelProps) {
  const translate = useTranslate();
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<ElementGroupId>>(() => sessionCollapsed);
  const [focus, setFocus] = useState(0);
  // The tile being dragged, drawn lifted out of its place until the drag ends.
  const [draggedId, setDraggedId] = useState<string | undefined>(undefined);
  const tileRefs = useRef<Array<HTMLButtonElement | undefined>>([]);
  const headerTip = useDelayedPlacement((element) => tooltipAnchor(element.getBoundingClientRect()));
  const tooltip = useDelayedPlacement((element) => ({ tileId: element.dataset['tileId'] ?? '', anchor: tooltipAnchor(element.getBoundingClientRect()) }));
  const { allowSlot } = props;
  const groups = useMemo(() => filterElementGroups(ELEMENT_GROUPS, query, { allowSlot }, translate), [query, allowSlot, translate]);
  // A search shows every match: a folded group would hide what was searched for.
  const searching = query.trim().length > 0;
  const open = (group: ElementGroup): boolean => searching || !collapsed.has(group.id);
  const shownTiles = groups.flatMap((group) => (open(group) ? group.tiles : []));
  const focused = Math.min(focus, Math.max(shownTiles.length - 1, 0));

  const choose = (tile: ElementTile): void => {
    tooltip.hide();
    const action = tile.action;
    switch (action.kind) {
      case 'insert':
        props.onInsert(insertItemOf(tile, action.choice));
        return;
      case 'pickComponent':
        props.onPickComponent();
        return;
      default: {
        const exhaustive: never = action;
        return exhaustive;
      }
    }
  };
  const focusTile = (index: number): void => {
    setFocus(index);
    tileRefs.current[index]?.focus();
  };
  const onGridKey = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const move = Object.hasOwn(GRID_KEYS, event.key) ? GRID_KEYS[event.key] : undefined;
    if (move === undefined || shownTiles.length === 0) {
      return;
    }
    event.preventDefault();
    const sizes = groups.map((group) => (open(group) ? group.tiles.length : 0));
    focusTile(moveElementFocus(sizes, focused, move));
  };
  const onSearchKey = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!(event.target instanceof HTMLInputElement)) {
      return;
    }
    const first = shownTiles[0];
    if (event.key === 'ArrowDown' && first !== undefined) {
      event.preventDefault();
      focusTile(0);
    } else if (event.key === 'Enter' && first !== undefined) {
      // Enter in the box takes the best match, as the insert palette does.
      event.preventDefault();
      choose(first);
    }
  };
  const toggle = (id: ElementGroupId): void =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return rememberCollapsed(next);
    });
  // One button, as the Navigator's: it folds every group while any is open and opens them all once every one is
  // folded, so it never offers a press that would change nothing. A search opens every matching group regardless
  // (see `open`), so folding then would show no change: the button is disabled while searching.
  const foldAll = foldAllAction(collapsed);
  const foldAllLabel = translate(foldAll === 'collapse' ? 'structure.collapseAll' : 'structure.expandAll');
  const onFoldAll = (): void => {
    headerTip.hide();
    setCollapsed(() => rememberCollapsed(new Set(foldAll === 'collapse' ? ELEMENT_GROUP_IDS : [])));
  };

  let position = 0;
  let previousSection: ElementSectionId | undefined;
  return (
    <div className="panel-section grow add-elements">
      <PanelHeader
        title={translate('elements.panel.title')}
        actions={
          <button
            type="button"
            className="ghost"
            aria-label={foldAllLabel}
            disabled={searching}
            onMouseEnter={(event) => headerTip.show(event.currentTarget)}
            onMouseLeave={headerTip.hide}
            onClick={onFoldAll}
          >
            {foldAll === 'collapse' ? <CollapseVerticalIcon size={14} /> : <ExpandVerticalIcon size={14} />}
          </button>
        }
      />
      {headerTip.value !== undefined && <FittedTooltip anchor={headerTip.value}>{foldAllLabel}</FittedTooltip>}
      <div onKeyDown={onSearchKey}>
        <PanelSearch value={query} placeholder={translate('elements.panel.search')} clearLabel={translate('elements.panel.clearSearch')} onChange={setQuery} />
      </div>
      <div className="add-elements-body" onKeyDown={onGridKey}>
        {groups.map((group) => {
          const heading = group.section === previousSection ? undefined : group.section;
          previousSection = group.section;
          const start = position;
          if (open(group)) {
            position += group.tiles.length;
          }
          return (
            <React.Fragment key={group.id}>
              {heading !== undefined && <h3 className="add-elements-section">{translate(SECTION_LABELS[heading])}</h3>}
              <ElementGroupView
                group={group}
                open={open(group)}
                start={start}
                focused={focused}
                draggedId={draggedId}
                tileRefs={tileRefs}
                onToggle={() => toggle(group.id)}
                onChoose={choose}
                onFocusTile={(index, element) => {
                  setFocus(index);
                  tooltip.showNow(element);
                }}
                onHover={tooltip.show}
                onLeave={tooltip.hide}
                onDragPhase={(phase, tileId) => {
                  tooltip.hide();
                  setDraggedId(phase === 'start' ? tileId : undefined);
                  props.onDragPhase?.(phase);
                }}
              />
            </React.Fragment>
          );
        })}
        {groups.length === 0 && <div className="props-empty">{translate('elements.panel.empty', { query: query.trim() })}</div>}
      </div>
      {tooltip.value !== undefined && <TileTooltip tileId={tooltip.value.tileId} anchor={tooltip.value.anchor} />}
    </div>
  );
}

// Writes the folded groups to the session memory and hands them back for the state.
function rememberCollapsed(next: ReadonlySet<ElementGroupId>): ReadonlySet<ElementGroupId> {
  assert(next.size <= ELEMENT_GROUP_IDS.length, 'AddElementsPanel: only catalog groups fold');
  sessionCollapsed = next;
  return next;
}

function ElementGroupView(props: {
  readonly group: ElementGroup;
  readonly open: boolean;
  /** The position of the group's first tile among every tile drawn. */
  readonly start: number;
  readonly focused: number;
  readonly draggedId: string | undefined;
  readonly tileRefs: React.MutableRefObject<Array<HTMLButtonElement | undefined>>;
  readonly onToggle: () => void;
  readonly onChoose: (tile: ElementTile) => void;
  readonly onFocusTile: (index: number, element: HTMLElement) => void;
  readonly onHover: (element: HTMLElement) => void;
  readonly onLeave: () => void;
  readonly onDragPhase: (phase: 'start' | 'end', tileId: string) => void;
}) {
  const translate = useTranslate();
  const { group } = props;
  const label = translate(group.labelKey);
  return (
    <section className="add-elements-group" aria-label={label}>
      <button type="button" className="add-elements-toggle" aria-expanded={props.open} onClick={props.onToggle}>
        <span className="add-elements-group-name">{label}</span>
        <span className="add-elements-chevron" aria-hidden="true">
          {props.open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
        </span>
      </button>
      {props.open && (
        <div className="add-elements-grid" role="group" aria-label={translate('elements.panel.gridLabel', { group: label })}>
          {group.tiles.map((tile, offset) => {
            const index = props.start + offset;
            return (
              <button
                key={tile.id}
                ref={(element) => {
                  // eslint-disable-next-line no-param-reassign -- A ref list is the platform's way to reach the focused tile.
                  props.tileRefs.current[index] = element ?? undefined;
                }}
                type="button"
                className={tile.id === props.draggedId ? 'add-elements-tile dragged' : 'add-elements-tile'}
                data-tile-id={tile.id}
                tabIndex={index === props.focused ? 0 : -1}
                draggable={tile.action.kind === 'insert'}
                onClick={() => props.onChoose(tile)}
                onFocus={(event) => props.onFocusTile(index, event.currentTarget)}
                onBlur={props.onLeave}
                onMouseEnter={(event) => props.onHover(event.currentTarget)}
                onMouseLeave={props.onLeave}
                onDragStart={(event) => startTileDrag(event, tile, translate(tile.labelKey), (phase) => props.onDragPhase(phase, tile.id))}
                onDragEnd={() => {
                  clearDrag();
                  props.onDragPhase('end', tile.id);
                }}
              >
                <span className="add-elements-icon" aria-hidden="true">
                  {tileIcon(tile)}
                </span>
                <span className="add-elements-label">{translate(tile.labelKey)}</span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

// The tooltip gives the tile's full name (a tile may show a short one) and what it writes, as code (AGENTS.md, "Code
// display"); the Component tile says where to pick one. FittedTooltip places it inside the window before the browser
// paints, shifted off the window's edges and above the tile when there is no room below, so a tile at the bottom of the
// panel never has its tip cut off.
function TileTooltip({ tileId, anchor }: { readonly tileId: string; readonly anchor: TooltipAnchor }) {
  const translate = useTranslate();
  const tile = ELEMENT_GROUPS.flatMap((group) => group.tiles).find((candidate) => candidate.id === tileId);
  if (tile === undefined) {
    return undefined;
  }
  if (tile.code === undefined) {
    // A tile with nothing to say (the Text tile) draws no tip.
    return tile.action.kind === 'pickComponent' ? (
      <FittedTooltip className="add-elements-tip" role="tooltip" anchor={anchor}>
        {translate('elements.astro.componentHint')}
      </FittedTooltip>
    ) : undefined;
  }
  return (
    <FittedTooltip className="add-elements-tip" role="tooltip" anchor={anchor}>
      <span>{translate(tile.nameKey)}</span>
      <CodeInline text={tile.code} language="astro" />
    </FittedTooltip>
  );
}

function startTileDrag(event: React.DragEvent<HTMLButtonElement>, tile: ElementTile, label: string, onDragPhase: (phase: 'start' | 'end') => void): void {
  const action = tile.action;
  if (action.kind !== 'insert') {
    event.preventDefault();
    return;
  }
  assert(label.length > 0, 'AddElementsPanel: a dragged tile has a name');
  event.dataTransfer.setData(INSERT_DRAG_TYPE, insertDragText(action.choice));
  allowDragEffect(event.dataTransfer, 'copy');
  setDrag({ kind: 'insert', choice: action.choice, label });
  // After the browser has taken its picture of the tile: the host's Navigator may cover the panel.
  setTimeout(() => onDragPhase('start'), 0);
}

/** The palette's item for a tile's choice, which the host's insert reads only for its type, tag and name. */
function insertItemOf(tile: ElementTile, choice: InsertDragChoice): InsertItem {
  return { ...choice, label: tile.id, cat: choice.type === 'element' ? 'elements' : 'other', icon: undefined };
}

function tileIcon(tile: ElementTile): React.ReactNode {
  const size = 20;
  const action = tile.action;
  if (action.kind === 'pickComponent') {
    return <ElementComponentIcon size={size} />;
  }
  const choice = action.choice;
  switch (choice.type) {
    case 'element':
      return elementIcon(choice.tag, size);
    case 'astroAsset':
      return astroAssetIcon(choice.name, size, undefined, 'inherit');
    case 'map':
      return <RepeatIcon size={size} />;
    case 'cond':
      return <BranchIcon size={size} />;
    case 'expr':
      return <BracesIcon size={size} />;
    case 'text':
      return <TextIcon size={size} />;
    case 'comment':
      return <CommentIcon size={size} />;
    case 'doctype':
      return elementIcon('html', size);
    case 'style':
      return elementIcon('style', size);
    case 'script':
      return <CodeIcon size={size} />;
    default: {
      const exhaustive: never = choice;
      return exhaustive;
    }
  }
}
