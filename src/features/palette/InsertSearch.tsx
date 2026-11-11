import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { segmentIndicatorStyle, useSegmentIndicator } from '../../ui/segmentIndicator';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import type { ScanComponent } from '../../../shared/properties/projectScan';
import { HTML_TAGS } from '../../editor/elementSchemas';
import type { TrailingSlash } from '../../editor/pageState';
import { rankInsertItems, tagSearchText } from '../../lib/insertRank';
import { ASTRO_ASSETS } from './astroAssets';
import { insertFolderOf, type InsertFolderKey } from './insertFolders';
import { insertResultsMax, insertView, mountedFrameKeys, moveHighlight, previewFramesMax, type GridMove, type InsertTab } from './insertGrid';
import type { InsertItem } from './insertItem';
import { InsertCard, InsertHints, InsertPills, InsertRow, type InsertPreviewHost } from './InsertCards';
import { INSERT_TAB_DEFAULT, loadInsertFolder, loadInsertTab, saveInsertFolder, saveInsertTab } from './insertPreferences';
import type { AppsEmpty } from './InsertAppRows';
import { usePaletteResize } from './paletteResize';
import {
  canSeePaletteApps,
  paletteAppItems,
  paletteAppsActions,
  paletteMarketplaceItems,
  visiblePaletteApps,
  type PaletteAppItem,
  type PaletteAppsAction,
  type PaletteMarketplaceItem,
  type PaletteAppsSource,
} from './paletteApps';
import { InsertAppRow, InsertAppsEmpty, InsertMarketplaceRow } from './InsertAppRows';
import { useCurrentRole } from '../../lib/useCurrentRole';
import {
  elementIcon,
  ElementComponentIcon,
  LayoutIcon,
  RepeatIcon,
  BranchIcon,
  TextIcon,
  CommentIcon,
  BracesIcon,
  CodeIcon,
  SearchIcon,
  astroAssetIcon,
} from '../../ui/Icons';

export type { InsertChoice, InsertItem } from './insertItem';

type TabEntry = { readonly key: InsertTab; readonly label: string };

const TABS: ReadonlyArray<TabEntry> = [
  { key: 'all', label: 'All results' },
  { key: 'components', label: 'Components' },
  { key: 'elements', label: 'Elements' },
  { key: 'other', label: 'Other' },
];

/** The tabs with Apps, for a host that lists apps and a role that sees the Apps panel. */
const TABS_WITH_APPS: ReadonlyArray<TabEntry> = [...TABS, { key: 'apps', label: 'Apps' }];

/** What the palette lists: something to insert, an app to open, or a marketplace app to show in the Apps panel. */
type PaletteEntry = InsertItem | PaletteAppItem | PaletteMarketplaceItem;

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
  /** The installed apps, for the Apps tab; without it (or for a role without the Apps panel) there is no Apps tab. */
  readonly apps?: PaletteAppsSource | undefined;
  readonly onInsert: (item: InsertItem) => void;
  readonly onClose: () => void;
}
export default function InsertSearch(props: InsertSearchProps) {
  const { onClose } = props;
  const state = useInsertSearch(props);
  const { query, setQuery, tab, setTab, pickFolder, highlight, setHighlight, listRef, view } = state;
  // An app opens rather than inserts; either way the palette's work is done.
  const choose = (entry: PaletteEntry): void => {
    if (entry.type === 'app') {
      onClose();
      entry.app.open();
    } else if (entry.type === 'marketplace') {
      onClose();
      entry.app.open();
    } else {
      props.onInsert(entry);
    }
  };
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
      <div ref={paletteRef} className={`insert-palette ${grid ? 'insert-palette-grid' : ''}`} onKeyDown={(event) => insertKey(event, state, choose, onClose)}>
        <div className="insert-search-row">
          <SearchIcon size={14} />
          <input
            autoFocus
            value={query}
            placeholder={state.tabs === TABS ? 'Search components, elements…' : 'Search components, elements, apps…'}
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <InsertTabs tabs={state.tabs} tab={tab} onPick={setTab} />
        {view.folders !== undefined && <InsertPills pills={view.folders.pills} selected={view.folders.selected} onPick={pickFolder} />}
        <div className={`insert-results ${grid ? 'insert-results-grid' : ''}`} ref={listRef}>
          {view.shown.map((item, i) => {
            const key = insertItemKey(item);
            const select = () => choose(item);
            const hover = () => {
              state.noteMove('pointer');
              setHighlight(i);
            };
            if (item.type === 'app') {
              return <InsertAppRow key={key} app={item.app} highlighted={i === highlight} onHover={hover} onOpen={select} />;
            }
            if (item.type === 'marketplace') {
              const first = view.shown[i - 1]?.type !== 'marketplace';
              return <InsertMarketplaceRow key={key} app={item.app} first={first} highlighted={i === highlight} onHover={hover} onOpen={select} />;
            }
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
                showFolder={view.folders?.selected === undefined}
                onHover={hover}
                onInsert={select}
              />
            );
          })}
          {view.shown.length === 0 && <InsertEmpty state={state} onClose={onClose} />}
        </div>
        {grid && <InsertHints />}
      </div>
    </div>
  );
}

// Nothing to list. On the Apps tab with no app to open, a short section on what apps are and the ways to
// get one, as rows the keys move through and Enter runs; while the apps load or when they failed to, the reason.
function InsertEmpty({ state, onClose }: { readonly state: InsertState; readonly onClose: () => void }) {
  const empty = state.appsEmpty;
  if (empty === undefined) {
    return <div className="props-empty">No matches.</div>;
  }
  return (
    <InsertAppsEmpty
      empty={empty}
      actions={state.emptyActions}
      highlight={state.highlight}
      onHover={(index) => {
        state.noteMove('pointer');
        state.setHighlight(index);
      }}
      onRun={(action) => runEmptyAction(action, onClose)}
    />
  );
}

/** An empty-state row hands the work to the Apps panel, so the palette closes first, as for an app. */
function runEmptyAction(action: PaletteAppsAction, onClose: () => void): void {
  onClose();
  action.run();
}

// The tab row: plain labels, and one pill behind the active tab that slides and resizes to the next
// one (the shared segment indicator, src/ui/segmentIndicator.ts), whatever changed the tab: a click,
// the Tab key, or the preference the palette reopened on.
function InsertTabs({ tabs, tab, onPick }: { readonly tabs: ReadonlyArray<TabEntry>; readonly tab: InsertTab; readonly onPick: (tab: InsertTab) => void }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const buttonsRef = useRef<Array<HTMLButtonElement | undefined>>([]);
  const selectedIndex = tabs.findIndex((entry) => entry.key === tab);
  assert(selectedIndex >= 0, 'InsertSearch: the tab is one of the tabs');
  const { indicator, animated } = useSegmentIndicator({ trackRef, buttonsRef, selectedIndex, layoutKey: String(tabs.length) });
  return (
    <div ref={trackRef} className="insert-tabs" role="tablist" aria-label="Insert results">
      <span className={`insert-tab-indicator${animated ? ' is-animated' : ''}`} aria-hidden="true" style={segmentIndicatorStyle(indicator)} />
      {tabs.map((entry, index) => (
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

/** Whether an entry inserts something: apps and marketplace apps open instead. */
function isInsertItem(entry: PaletteEntry): entry is InsertItem {
  if (entry.type === 'app') {
    return false;
  }
  return entry.type !== 'marketplace';
}

function insertItemKey(item: PaletteEntry): string {
  if (item.type === 'app') {
    return JSON.stringify([item.type, item.app.id]);
  }
  if (item.type === 'marketplace') {
    return JSON.stringify([item.type, item.app.id]);
  }
  // Component names can repeat across folders; their files identify distinct insertion targets.
  if (item.type === 'component') {
    return JSON.stringify([item.type, item.path ?? item.sub, item.name]);
  }
  return JSON.stringify([item.type, item.label]);
}

function useInsertSearch({ components, allowSlot, projectKey, apps }: InsertSearchProps) {
  const [query, setQuery] = useState('');
  const role = useCurrentRole();
  const appsShown = apps !== undefined && canSeePaletteApps(role);
  const tabs = appsShown ? TABS_WITH_APPS : TABS;
  // The tab the palette was last left on, for this person in every project (insertPreferences.ts).
  // A remembered Apps tab the host or role no longer offers shows All results, and stays remembered.
  const [storedTab, setTabState] = useState<InsertTab>(loadInsertTab);
  const tab = tabs.some((entry) => entry.key === storedTab) ? storedTab : INSERT_TAB_DEFAULT;
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
  const appList = apps?.list;
  // The apps this role may open, as search rows; none while they load, or when the role has no Apps panel.
  const appItems = useMemo(
    () => (appsShown && appList?.kind === 'ready' ? paletteAppItems(visiblePaletteApps(appList.apps, role)) : []),
    [appsShown, appList, role],
  );
  // Marketplace results follow the installed apps on the Apps tab, and only for a search: browsing is the Apps panel's.
  const marketplaceApps = apps?.marketplace;
  const marketplaceItems = useMemo(
    () => (appsShown && marketplaceApps !== undefined ? paletteMarketplaceItems(marketplaceApps, role) : []),
    [appsShown, marketplaceApps, role],
  );
  // Every folder the project's cards fill, whatever the search hits, so the pills do not come and go while typing.
  const folders = useMemo(() => allItems.flatMap((item) => (item.card?.folder === undefined ? [] : [item.card.folder])), [allItems]);
  // The words, and where they land: see src/lib/insertRank.ts. The trailing space
  // is meaningful, so the query is not trimmed on the way in.
  const view = useMemo(() => {
    const entries: readonly PaletteEntry[] = [...allItems, ...appItems];
    const items = entries.filter((i) => tab === 'all' || i.cat === tab);
    const ranked = rankInsertItems(items, query);
    if (tab === 'components') {
      return insertView(ranked, tab, { chosen: folder, present: folders });
    }
    const market = tab === 'apps' && /\S/.test(query) ? rankInsertItems(marketplaceItems, query) : [];
    const shown: readonly PaletteEntry[] = [...ranked, ...market].slice(0, listResultsMax);
    return { shown, folders: undefined };
  }, [allItems, appItems, marketplaceItems, folders, query, tab, folder]);
  const appsEmpty = tab === 'apps' ? appsEmptyState(appList, appItems.length) : undefined;
  const emptyActions = useMemo(() => (appsEmpty?.kind === 'none' && apps !== undefined ? paletteAppsActions(apps, role) : []), [appsEmpty?.kind, apps, role]);

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
    const cardKeys = view.shown
      .filter(isInsertItem)
      .filter((item) => item.card !== undefined && item.preview !== undefined)
      .map(insertItemKey);
    return mountedFrameKeys(cardKeys, { visible: visibleKeys, settled: settledKeys, framesMax: previewFramesMax });
  }, [view.shown, visibleKeys, settledKeys]);

  return {
    query,
    setQuery,
    tabs,
    tab,
    setTab,
    appsEmpty,
    emptyActions,
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

/** Why the Apps tab lists nothing, before a search can be the reason: loading, failed, or no app to open. */
function appsEmptyState(list: PaletteAppsSource['list'] | undefined, visibleCount: number): AppsEmpty | undefined {
  assert(visibleCount >= 0, 'InsertSearch: a count is never negative');
  if (list === undefined) {
    return undefined;
  }
  switch (list.kind) {
    case 'loading':
      return { kind: 'loading' };
    case 'failed':
      return { kind: 'failed', message: list.message };
    case 'ready':
      // Apps that a search hides are "No matches."; only a tab with no app at all offers Browse Apps.
      return visibleCount === 0 ? { kind: 'none' } : undefined;
    default: {
      const exhaustive: never = list;
      return exhaustive;
    }
  }
}

function insertKey(event: React.KeyboardEvent, state: InsertState, onInsert: (item: PaletteEntry) => void, onClose: () => void): void {
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
    } else {
      // The empty Apps tab's rows are what Enter runs, the highlighted one as with any row.
      const action = state.emptyActions[highlight];
      if (action !== undefined) {
        runEmptyAction(action, onClose);
      }
    }
  } else if (event.key === 'Tab') {
    event.preventDefault();
    const tabs = state.tabs;
    const index = tabs.findIndex((tabEntry) => tabEntry.key === tab);
    const next = tabs[(index + (event.shiftKey ? tabs.length - 1 : 1)) % tabs.length];
    assert(next !== undefined, 'InsertSearch: next tab exists');
    setTab(next.key);
  }
}

// The list moves one row at a time and stops at both ends; left and right stay the text cursor's.
function listKey(event: React.KeyboardEvent, state: InsertState): void {
  assert(event.key === 'ArrowDown' || event.key === 'ArrowUp', 'InsertSearch: a list key is up or down');
  event.preventDefault();
  state.noteMove('keyboard');
  // The empty Apps tab's action rows stand in for results, so the keys move through them the same way.
  const rows = state.view.shown.length > 0 ? state.view.shown.length : state.emptyActions.length;
  const last = rows - 1;
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
// Tags Astro itself understands: Fragment groups children, Content renders a Markdown or collection entry.
const ASTRO_TAGS = ['Fragment', 'Content'] as const;
function insertTags({ allowSlot }: { readonly allowSlot: boolean | undefined }): InsertItem[] {
  // Astro's own tags are not HTML, so HTML_TAGS cannot hold them, but they are inserted the same way.
  const tags = [...HTML_TAGS, ...ASTRO_TAGS, ...(allowSlot ? ['slot'] : [])].sort();
  return tags.map((tag): InsertItem => ({
    type: 'element',
    tag,
    label: `<${tag}>`,
    search: tagSearchText(tag),
    ...(tag === 'slot' ? { sub: 'what the caller passes in' } : {}),
    ...(tag === 'Fragment' ? { sub: 'group without a wrapper element' } : {}),
    ...(tag === 'Content' ? { sub: 'rendered Markdown entry' } : {}),
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
    icon: <BracesIcon size={14} />,
  },
  {
    type: 'doctype',
    label: 'Doctype',
    sub: '<!doctype html>',
    search: 'doctype html',
    cat: 'other',
    icon: elementIcon('html', 14),
  },
  {
    type: 'style',
    label: 'Style Block',
    sub: '<style>',
    cat: 'other',
    icon: elementIcon('style', 14),
  },
  {
    type: 'script',
    label: 'Script Block',
    sub: '<script>',
    cat: 'other',
    icon: <CodeIcon size={14} />,
  },
];
