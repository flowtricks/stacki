import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { segmentIndicatorStyle, useSegmentIndicator } from '../../ui/segmentIndicator';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import type { ScanComponent } from '../../../shared/properties/projectScan';
import { HTML_TAGS } from '../../editor/elementSchemas';
import type { TrailingSlash } from '../../editor/pageState';
import { rankInsertItems, tagSearchText } from './insertRank';
import { ASTRO_ASSETS } from './astroAssets';
import { insertFolderOf, type InsertFolderKey } from './insertFolders';
import { insertResultsMax, insertView, mountedFrameKeys, moveHighlight, previewFramesMax, type GridMove, type InsertTab } from './insertGrid';
import type { InsertItem } from './insertItem';
import { InsertCard, InsertHints, InsertPills, InsertRow, type InsertPreviewHost } from './InsertCards';
import { loadInsertFolder, loadInsertTab, saveInsertFolder, saveInsertTab } from './insertPreferences';
import { usePaletteResize } from './paletteResize';
import {
  elementIcon,
  ElementComponentIcon,
  LayoutIcon,
  RepeatIcon,
  BranchIcon,
  TextIcon,
  CommentIcon,
  CodeIcon,
  SearchIcon,
  astroAssetIcon,
} from '../../ui/Icons';

export type { InsertChoice, InsertItem } from './insertItem';

const TABS: ReadonlyArray<{ readonly key: InsertTab; readonly label: string }> = [
  { key: 'all', label: 'All results' },
  { key: 'components', label: 'Components' },
  { key: 'elements', label: 'Elements' },
  { key: 'other', label: 'Other' },
];

/** Rows the list tabs show, as before the grid: a row is cheap to scroll past, and typing narrows the rest. */
const listResultsMax = 60;

const GRID_KEYS: Readonly<Record<string, GridMove>> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };

// Quick-insert palette (⌘F / ⌘E / ⌘K): fuzzy-searches components, HTML tags, and
// special node types; Enter or click inserts at the current selection. Components are
// cards with a live picture of the component, filtered by the project's component folders (insertFolders.ts).
// Each card is the Components panel's hover preview: the component with its insertion recipe (InsertPreview.tsx).
export interface InsertComponent extends Pick<ScanComponent, 'name' | 'origin' | 'instances' | 'isLayout'> {
  readonly path?: string;
  readonly folder?: string;
}
interface InsertSearchProps {
  /** Tells projects apart for the remembered folder pill (a path or a workspace id); without it the pill is not remembered. */
  readonly projectKey?: string | undefined;
  readonly components?: readonly InsertComponent[];
  readonly allowSlot?: boolean;
  /** The project's dev server; without it the cards say there is no preview. */
  readonly devUrl?: string | undefined;
  readonly trailingSlash?: TrailingSlash;
  readonly resolvePreviewURL?: (url: string) => Promise<string>;
  readonly onInsert: (item: InsertItem) => void;
  readonly onClose: () => void;
}
export default function InsertSearch(props: InsertSearchProps) {
  const { onInsert, onClose } = props;
  const state = useInsertSearch(props);
  const { query, setQuery, tab, setTab, pickFolder, highlight, setHighlight, listRef, view } = state;
  const host: InsertPreviewHost = {
    devURL: props.devUrl,
    trailingSlash: props.trailingSlash ?? 'ignore',
    resolvePreviewURL: props.resolvePreviewURL,
  };
  // Only Components is a grid of live previews; the other tabs are the plain list, which reads faster for tags and names.
  const grid = tab === 'components';
  const paletteRef = useRef<HTMLDivElement>(null);
  usePaletteResize(paletteRef, grid ? 'grid' : 'list');
  return (
    <div className="insert-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={paletteRef} className={`insert-palette ${grid ? 'insert-palette-grid' : ''}`} onKeyDown={(event) => insertKey(event, state, onInsert, onClose)}>
        <div className="insert-search-row">
          <SearchIcon size={14} />
          <input autoFocus value={query} placeholder="Search components, elements…" spellCheck={false} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <InsertTabs tab={tab} onPick={setTab} />
        {view.folders !== undefined && <InsertPills pills={view.folders.pills} selected={view.folders.selected} onPick={pickFolder} />}
        <div className={`insert-results ${grid ? 'insert-results-grid' : ''}`} ref={listRef}>
          {view.shown.map((item, i) => {
            const key = insertItemKey(item);
            const select = () => onInsert(item);
            const hover = () => {
              state.noteMove('pointer');
              setHighlight(i);
            };
            return !grid || item.card === undefined ? (
              <InsertRow key={key} item={item} highlighted={i === highlight} onHover={hover} onInsert={select} />
            ) : (
              <InsertCard
                key={key}
                item={item}
                itemKey={key}
                highlighted={i === highlight}
                mounted={state.mountedKeys.has(key)}
                host={host}
                scrollRoot={listRef}
                onVisible={state.reportVisible}
                onSettled={state.reportSettled}
                onHover={hover}
                onInsert={select}
              />
            );
          })}
          {view.shown.length === 0 && <div className="props-empty">No matches.</div>}
        </div>
        {grid && <InsertHints />}
      </div>
    </div>
  );
}

// The tab row: plain labels, and one pill behind the active tab that slides and resizes to the next
// one (the shared segment indicator, src/ui/segmentIndicator.ts), whatever changed the tab: a click,
// the Tab key, or the preference the palette reopened on.
function InsertTabs({ tab, onPick }: { readonly tab: InsertTab; readonly onPick: (tab: InsertTab) => void }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const buttonsRef = useRef<Array<HTMLButtonElement | undefined>>([]);
  const selectedIndex = TABS.findIndex((entry) => entry.key === tab);
  assert(selectedIndex >= 0, 'InsertSearch: the tab is one of the tabs');
  const { indicator, animated } = useSegmentIndicator({ trackRef, buttonsRef, selectedIndex, layoutKey: String(TABS.length) });
  return (
    <div ref={trackRef} className="insert-tabs" role="tablist" aria-label="Insert results">
      <span className={`insert-tab-indicator${animated ? ' is-animated' : ''}`} aria-hidden="true" style={segmentIndicatorStyle(indicator)} />
      {TABS.map((entry, index) => (
        <button
          key={entry.key}
          ref={(element) => {
            buttonsRef.current[index] = element ?? undefined;
          }}
          type="button"
          role="tab"
          aria-selected={tab === entry.key}
          className={`insert-tab ${tab === entry.key ? 'on' : ''}`}
          onClick={() => onPick(entry.key)}
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}

function insertItemKey(item: InsertItem): string {
  // Component names can repeat across folders; their files identify distinct insertion targets.
  if (item.type === 'component') {
    return JSON.stringify([item.type, item.path ?? item.sub, item.name]);
  }
  return JSON.stringify([item.type, item.label]);
}

function useInsertSearch({ components, allowSlot, projectKey }: InsertSearchProps) {
  const [query, setQuery] = useState('');
  // The tab the palette was last left on, for this person in every project (insertPreferences.ts).
  const [tab, setTabState] = useState<InsertTab>(loadInsertTab);
  const setTab = useCallback((next: InsertTab) => {
    setTabState(next);
    saveInsertTab(next);
  }, []);
  // The folder pill this project last had selected (insertPreferences.ts); none shows every card.
  const [folder, setFolder] = useState<InsertFolderKey | undefined>(() => loadInsertFolder(projectKey));
  const pickFolder = useCallback(
    (picked: InsertFolderKey) => {
      setFolder((current) => {
        const next = current === picked ? undefined : picked;
        saveInsertFolder(projectKey, next);
        return next;
      });
    },
    [projectKey],
  );
  const [highlight, setHighlight] = useState(0);
  const [visibleKeys, setVisibleKeys] = useState<ReadonlySet<string>>(() => new Set<string>());
  // Cards whose frame has answered (or given up) since they last came into view; they no longer count as loading.
  const [settledKeys, setSettledKeys] = useState<ReadonlySet<string>>(() => new Set<string>());
  const listRef = useRef<HTMLDivElement>(null);
  // What last moved the highlight. Only the keyboard scrolls the list to it: a pointer resting on a cut-off
  // card must not make the list slide under the pointer.
  const movedBy = useRef<'keyboard' | 'pointer'>('keyboard');

  const allItems = useMemo(() => insertItems(components ?? [], { allowSlot }), [components, allowSlot]);
  // Every folder the project's cards fill, whatever the search hits, so the pills do not come and go while typing.
  const folders = useMemo(() => allItems.flatMap((item) => (item.card?.folder === undefined ? [] : [item.card.folder])), [allItems]);
  // The words, and where they land: see src/features/palette/insertRank.ts. The trailing space
  // is meaningful, so the query is not trimmed on the way in.
  const view = useMemo(() => {
    const items = allItems.filter((i) => tab === 'all' || i.cat === tab);
    const ranked = rankInsertItems(items, query);
    if (tab === 'components') {
      return insertView(ranked, tab, { chosen: folder, present: folders });
    }
    return { shown: ranked.slice(0, listResultsMax), folders: undefined };
  }, [allItems, folders, query, tab, folder]);

  useEffect(() => {
    movedBy.current = 'keyboard';
    setHighlight(0);
  }, [query, tab, view.folders?.selected]);

  // Keep the highlighted card scrolled into view.
  useEffect(() => {
    const element = listRef.current?.children[highlight];
    if (element && movedBy.current === 'keyboard') {
      element.scrollIntoView({ block: 'nearest' });
    }
  }, [highlight]);

  const reportVisible = useCallback((key: string, visible: boolean) => {
    setVisibleKeys((current) => {
      if (current.has(key) === visible) {
        return current;
      }
      const next = new Set(current);
      if (visible) {
        next.add(key);
      } else {
        next.delete(key);
      }
      assert(next.size <= insertResultsMax, 'Only shown cards can be visible');
      return next;
    });
    if (!visible) {
      // A card that leaves the view loses its frame; when it comes back its page loads again, and counts as loading.
      setSettledKeys((current) => {
        if (!current.has(key)) {
          return current;
        }
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }, []);

  const reportSettled = useCallback((key: string) => {
    setSettledKeys((current) => {
      if (current.has(key)) {
        return current;
      }
      assert(current.size < insertResultsMax, 'Only shown cards can settle');
      return new Set([...current, key]);
    });
  }, []);

  // The visible cards that get a frame: the first ones in grid order, so a very tall window cannot
  // push the number of running pages past the limit, and only a few loading at once (insertGrid.ts).
  const mountedKeys = useMemo((): ReadonlySet<string> => {
    // Only a card with something to preview takes a frame: Astro's own components have no file, and would hold a loading place forever.
    const cardKeys = view.shown.filter((item) => item.card !== undefined && item.preview !== undefined).map(insertItemKey);
    return mountedFrameKeys(cardKeys, { visible: visibleKeys, settled: settledKeys, framesMax: previewFramesMax });
  }, [view.shown, visibleKeys, settledKeys]);

  return {
    query,
    setQuery,
    tab,
    setTab,
    pickFolder,
    highlight,
    setHighlight,
    listRef,
    view,
    mountedKeys,
    reportVisible,
    reportSettled,
    noteMove: (by: 'keyboard' | 'pointer') => {
      movedBy.current = by;
    },
  };
}

type InsertState = ReturnType<typeof useInsertSearch>;

function insertKey(event: React.KeyboardEvent, state: InsertState, onInsert: (item: InsertItem) => void, onClose: () => void): void {
  if (event.target instanceof HTMLElement && event.target.closest('.insert-pill, .insert-tab') !== null) {
    // A focused pill or tab is a button: Enter and Space press it, as on any button, instead of inserting.
    if (event.key === 'Enter' || event.key === ' ') {
      return;
    }
  }
  const { view, highlight, tab, setTab } = state;
  const item = view.shown[highlight];
  if (event.key === 'Escape') {
    event.preventDefault();
    onClose();
  } else if (tab !== 'components' && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    listKey(event, state);
  } else if (tab === 'components' && Object.hasOwn(GRID_KEYS, event.key)) {
    gridKey(event, state);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    if (item) {
      onInsert(item);
    }
  } else if (event.key === 'Tab') {
    event.preventDefault();
    const index = TABS.findIndex((tabEntry) => tabEntry.key === tab);
    const next = TABS[(index + (event.shiftKey ? TABS.length - 1 : 1)) % TABS.length];
    assert(next !== undefined, 'InsertSearch: next tab exists');
    setTab(next.key);
  }
}

// The list moves one row at a time and stops at both ends; left and right stay the text cursor's.
function listKey(event: React.KeyboardEvent, state: InsertState): void {
  assert(event.key === 'ArrowDown' || event.key === 'ArrowUp', 'InsertSearch: a list key is up or down');
  event.preventDefault();
  state.noteMove('keyboard');
  const last = state.view.shown.length - 1;
  if (last >= 0) {
    const current = Math.min(state.highlight, last);
    state.setHighlight(event.key === 'ArrowDown' ? Math.min(current + 1, last) : Math.max(current - 1, 0));
  }
}

function gridKey(event: React.KeyboardEvent, state: InsertState): void {
  const move = GRID_KEYS[event.key];
  assert(move !== undefined, 'InsertSearch: a grid key maps to a move');
  const horizontal = move === 'left' || move === 'right';
  if (horizontal && state.query !== '') {
    // With text in the field the arrows are the text cursor's.
    return;
  }
  event.preventDefault();
  state.noteMove('keyboard');
  const count = state.view.shown.length;
  if (count > 0) {
    const current = Math.min(state.highlight, count - 1);
    state.setHighlight(moveHighlight(current, count, move));
  }
}

function insertItems(
  components: readonly InsertComponent[],
  options: {
    readonly allowSlot: boolean | undefined;
  },
): InsertItem[] {
  assert(components.length <= LIMITS.scanEntriesMax, 'InsertSearch: component limit exceeded');
  const items = [...insertComponents(components), ...insertAssets(), ...insertTags(options), ...OTHER_ITEMS];
  assert(items.length <= LIMITS.scanEntriesMax + HTML_TAGS.length + 11, 'InsertSearch: combined item limit exceeded');
  // Project components stay first so a local Image is not shadowed by Astro's.
  return items;
}
function previewSource(component: InsertComponent): ScanComponent | undefined {
  if (component.path === undefined) {
    return undefined;
  }
  return { ...component, path: component.path, folder: component.folder ?? '' };
}
function insertComponents(components: readonly InsertComponent[]): InsertItem[] {
  return components.map((component): InsertItem => {
    const preview = previewSource(component);
    return {
      type: 'component',
      ...(component.path === undefined ? {} : { path: component.path }),
      name: component.name,
      label: component.name,
      sub: component.folder || 'component',
      cat: 'components',
      icon: component.isLayout ? <LayoutIcon size={15} style={{ color: '#79e09c' }} /> : <ElementComponentIcon size={15} style={{ color: '#79e09c' }} />,
      card: { folder: insertFolderOf(component.folder ?? '') },
      ...(component.instances === undefined ? {} : { instances: component.instances }),
      ...(preview === undefined ? {} : { preview }),
    };
  });
}
function insertAssets(): InsertItem[] {
  return ASTRO_ASSETS.map((asset): InsertItem => ({
    type: 'astroAsset',
    name: asset.name,
    label: `<${asset.name}>`,
    sub: 'astro:assets',
    search: `${asset.name} astro assets image picture optimised responsive`,
    cat: 'components',
    icon: astroAssetIcon(asset.name, 15),
    // Astro's own components have no file of the project's to preview, and no project folder, so no pill.
    card: { folder: undefined },
  }));
}
function insertTags({ allowSlot }: { readonly allowSlot: boolean | undefined }): InsertItem[] {
  return (allowSlot ? [...HTML_TAGS, 'slot'].sort() : HTML_TAGS).map((tag): InsertItem => ({
    type: 'element',
    tag,
    label: `<${tag}>`,
    search: tagSearchText(tag),
    ...(tag === 'slot' ? { sub: 'what the caller passes in' } : {}),
    cat: 'elements',
    icon: elementIcon(tag, 14),
  }));
}
export const OTHER_ITEMS: readonly InsertItem[] = [
  {
    type: 'map',
    label: 'Loop',
    sub: 'items.map',
    // What a builder calls it: Webflow's Collection List, a CMS list.
    search: 'loop map repeat repeater each for list collection list cms collection items iterate',
    cat: 'other',
    icon: <RepeatIcon size={14} style={{ color: '#c4afff' }} />,
  },
  {
    type: 'cond',
    label: 'Condition',
    sub: 'if / else',
    search: 'condition if else ternary show hide',
    cat: 'other',
    icon: <BranchIcon size={14} style={{ color: '#c4afff' }} />,
  },
  { type: 'text', label: 'Text', cat: 'other', icon: <TextIcon size={14} /> },
  { type: 'comment', label: 'Comment', cat: 'other', icon: <CommentIcon size={14} /> },
  {
    type: 'expr',
    label: 'Code Expression',
    sub: '{ }',
    cat: 'other',
    icon: <CodeIcon size={14} />,
  },
  {
    type: 'doctype',
    label: 'Doctype',
    sub: '<!doctype html>',
    search: 'doctype html',
    cat: 'other',
    icon: <CodeIcon size={14} />,
  },
  {
    type: 'style',
    label: 'Style Block',
    sub: '<style>',
    cat: 'other',
    icon: <CodeIcon size={14} />,
  },
  {
    type: 'script',
    label: 'Script Block',
    sub: '<script>',
    cat: 'other',
    icon: <CodeIcon size={14} />,
  },
];
