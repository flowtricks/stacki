import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import type { ScanComponent } from '../../../shared/properties/projectScan';
import { HTML_TAGS } from '../../editor/elementSchemas';
import type { TrailingSlash } from '../../editor/pageState';
import { rankInsertItems, tagSearchText } from './insertRank';
import { ASTRO_ASSETS } from './astroAssets';
import { indexByName, insertGroupOf, type InsertGroup } from './insertGroups';
import { insertResultsMax, insertView, moveHighlight, previewFramesMax, type GridMove, type InsertTab } from './insertGrid';
import type { InsertItem } from './insertItem';
import { useShotCatalog, type ComponentShotSource, type ShotAccess } from './componentShotSource';
import { InsertCard, InsertEnlarged, InsertHints, InsertPills, InsertTile, type EnlargeHint, type InsertPreviewHost } from './InsertCards';
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

/** One frame is kept free for the large view, so the cards and the large view never exceed the limit together. */
const cardFramesMax = previewFramesMax - 1;

const GRID_KEYS: Readonly<Record<string, GridMove>> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };

type EnlargeState = { readonly kind: 'closed' } | { readonly kind: 'open'; readonly item: InsertItem };

// Quick-insert palette (⌘F / ⌘E / ⌘K): fuzzy-searches components, HTML tags, and
// special node types; Enter or click inserts at the current selection. Components are
// cards with a picture of the component, sorted into sections and blocks; see insertGroups.ts.
export interface InsertComponent extends Pick<ScanComponent, 'name' | 'origin' | 'instances' | 'renderTag' | 'rootComponent' | 'isLayout'> {
  readonly path?: string;
  readonly folder?: string;
}
interface InsertSearchProps {
  readonly components?: readonly InsertComponent[];
  readonly allowSlot?: boolean;
  /** The project's dev server; without it the cards say there is no preview. */
  readonly devUrl?: string | undefined;
  readonly trailingSlash?: TrailingSlash;
  readonly resolvePreviewURL?: (url: string) => Promise<string>;
  /** Photographs of components on their pages; without it every card shows the live preview. */
  readonly shots?: ComponentShotSource | undefined;
  readonly onInsert: (item: InsertItem) => void;
  readonly onClose: () => void;
}
export default function InsertSearch(props: InsertSearchProps) {
  const { onInsert, onClose } = props;
  const state = useInsertSearch(props);
  const { query, setQuery, tab, setTab, setPill, highlight, setHighlight, listRef, view, enlarged, setEnlarged } = state;
  const shotAccess = state.shotAccess;
  const host: InsertPreviewHost = {
    devURL: props.devUrl,
    trailingSlash: props.trailingSlash ?? 'ignore',
    resolvePreviewURL: props.resolvePreviewURL,
    shots: shotAccess,
  };
  const highlighted = view.shown[highlight];
  return (
    <div className="insert-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="insert-palette" onKeyDown={(event) => insertKey(event, state, props, onInsert, onClose)}>
        <div className="insert-search-row">
          <SearchIcon size={14} />
          <input autoFocus value={query} placeholder="Search components, elements…" spellCheck={false} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <div className="insert-tabs">
          {TABS.map((tabEntry) => (
            <button key={tabEntry.key} className={`insert-tab ${tab === tabEntry.key ? 'on' : ''}`} onClick={() => setTab(tabEntry.key)}>
              {tabEntry.label}
            </button>
          ))}
        </div>
        {view.counts !== undefined && view.pill !== undefined && <InsertPills counts={view.counts} pill={view.pill} onPick={setPill} />}
        <div className="insert-results" ref={listRef}>
          {view.shown.map((item, i) => {
            const key = insertItemKey(item);
            const select = () => onInsert(item);
            const hover = () => {
              state.noteMove('pointer');
              setHighlight(i);
            };
            return item.group === undefined ? (
              <InsertTile key={key} item={item} highlighted={i === highlight} onHover={hover} onInsert={select} />
            ) : (
              <InsertCard
                key={key}
                item={item}
                itemKey={key}
                highlighted={i === highlight}
                mounted={state.mountedKeys.has(key)}
                visible={state.visibleKeys.has(key)}
                host={host}
                scrollRoot={listRef}
                onVisible={state.reportVisible}
                onHover={hover}
                onInsert={select}
              />
            );
          })}
          {view.shown.length === 0 && <div className="props-empty">No matches.</div>}
        </div>
        <InsertHints enlarge={enlargeHint(highlighted, { devUrl: props.devUrl, shots: shotAccess }, query)} />
        {enlarged.kind === 'open' && <InsertEnlarged item={enlarged.item} host={host} onClose={() => setEnlarged({ kind: 'closed' })} />}
      </div>
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

/** Whether the large view has anything to show for this item. */
function canEnlarge(
  item: InsertItem | undefined,
  { devUrl, shots }: { readonly devUrl: string | undefined; readonly shots: ShotAccess | undefined },
): item is InsertItem & { readonly group: InsertGroup } {
  if (item === undefined || item.group === undefined || item.preview === undefined) {
    return false;
  }
  // A photograph needs no dev server to be shown large.
  return devUrl !== undefined || shots?.has(item.preview.path) === true;
}

function enlargeHint(
  item: InsertItem | undefined,
  via: { readonly devUrl: string | undefined; readonly shots: ShotAccess | undefined },
  query: string,
): EnlargeHint {
  if (!canEnlarge(item, via)) {
    return 'none';
  }
  // In a search a space means "word finished" (insertRank.ts), so only the shifted key opens the view.
  return query === '' ? 'space' : 'shift-space';
}

function useInsertSearch({ components, allowSlot, shots }: InsertSearchProps) {
  const { access: shotAccess, settled: shotsSettled } = useShotCatalog(shots);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<InsertTab>('components');
  const [pill, setPill] = useState<InsertGroup>('sections');
  const [highlight, setHighlight] = useState(0);
  const [enlarged, setEnlarged] = useState<EnlargeState>({ kind: 'closed' });
  const [visibleKeys, setVisibleKeys] = useState<ReadonlySet<string>>(() => new Set<string>());
  const listRef = useRef<HTMLDivElement>(null);
  // What last moved the highlight. Only the keyboard scrolls the list to it: a pointer resting on a cut-off
  // card must not make the list slide under the pointer.
  const movedBy = useRef<'keyboard' | 'pointer'>('keyboard');

  const allItems = useMemo(() => insertItems(components ?? [], { allowSlot }), [components, allowSlot]);
  // The words, and where they land: see src/features/palette/insertRank.ts. The trailing space
  // is meaningful, so the query is not trimmed on the way in.
  const view = useMemo(() => {
    const items = allItems.filter((i) => tab === 'all' || i.cat === tab);
    return insertView(rankInsertItems(items, query), tab, pill);
  }, [allItems, query, tab, pill]);

  useEffect(() => {
    movedBy.current = 'keyboard';
    setHighlight(0);
  }, [query, tab, view.pill]);

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
  }, []);

  // The visible cards that get a frame: the first ones in grid order, so a very tall window cannot
  // push the number of running pages past the limit.
  const mountedKeys = useMemo(() => {
    const keys = new Set<string>();
    // Until the photograph catalog has answered no card knows whether it needs a frame.
    if (!shotsSettled) {
      return keys;
    }
    for (const item of view.shown) {
      const key = insertItemKey(item);
      // A card with a photograph has no frame to run, so it takes no share of the limit.
      const photographed = item.preview !== undefined && shotAccess?.has(item.preview.path) === true;
      if (keys.size < cardFramesMax && visibleKeys.has(key) && !photographed) {
        keys.add(key);
      }
    }
    return keys;
  }, [view.shown, visibleKeys, shotAccess, shotsSettled]);

  return {
    query,
    setQuery,
    tab,
    setTab,
    pill,
    setPill,
    highlight,
    setHighlight,
    listRef,
    view,
    enlarged,
    setEnlarged,
    mountedKeys,
    visibleKeys,
    reportVisible,
    shotAccess,
    noteMove: (by: 'keyboard' | 'pointer') => {
      movedBy.current = by;
    },
  };
}

type InsertState = ReturnType<typeof useInsertSearch>;

function insertKey(
  event: React.KeyboardEvent,
  state: InsertState,
  props: Pick<InsertSearchProps, 'devUrl'>,
  onInsert: (item: InsertItem) => void,
  onClose: () => void,
): void {
  if (state.enlarged.kind === 'open') {
    enlargedKey(event, state);
    return;
  }
  const { view, highlight, tab, setTab, query } = state;
  const item = view.shown[highlight];
  if (event.key === 'Escape') {
    event.preventDefault();
    onClose();
  } else if (Object.hasOwn(GRID_KEYS, event.key)) {
    gridKey(event, state);
  } else if (event.key === ' ') {
    // Plain space belongs to the search once there is text. With none, it opens the large view.
    if (query === '' || event.shiftKey) {
      if (canEnlarge(item, { devUrl: props.devUrl, shots: state.shotAccess })) {
        event.preventDefault();
        state.setEnlarged({ kind: 'open', item });
      } else if (query === '') {
        // No leading space: it would turn the arrow keys into cursor keys.
        event.preventDefault();
      }
    }
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

// While the large view is open it owns the keyboard: the field below must not change under it.
function enlargedKey(event: React.KeyboardEvent, state: InsertState): void {
  if (event.metaKey || event.ctrlKey) {
    return;
  }
  event.preventDefault();
  if (event.key === 'Escape' || event.key === ' ') {
    // Only the layer closes; the palette stays.
    event.stopPropagation();
    state.setEnlarged({ kind: 'closed' });
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
  const byName = indexByName(components);
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
      group: insertGroupOf(component, byName),
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
    // Astro's own components have no file of the project's to preview.
    group: 'blocks',
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
