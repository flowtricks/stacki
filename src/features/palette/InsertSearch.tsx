import React, { useEffect, useMemo, useRef, useState } from 'react';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { HTML_TAGS } from '../../editor/elementSchemas';
import { rankInsertItems, tagSearchText } from './insertRank';
import { ASTRO_ASSETS } from './astroAssets';
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

const TABS = [
  { key: 'all', label: 'All results' },
  { key: 'components', label: 'Components' },
  { key: 'elements', label: 'Elements' },
  { key: 'other', label: 'Other' },
] as const;
type Tab = (typeof TABS)[number]['key'];

// Quick-insert palette (⌘F / ⌘E): fuzzy-searches components, HTML tags, and
// special node types; Enter or click inserts at the current selection.
interface InsertComponent {
  readonly path?: string;
  readonly name: string;
  readonly folder?: string;
  readonly isLayout?: boolean;
}
export type InsertChoice =
  | { readonly type: 'component' | 'astroAsset'; readonly name: string; readonly path?: string }
  | { readonly type: 'element'; readonly tag: string }
  | {
      readonly type: 'map' | 'cond' | 'text' | 'comment' | 'expr' | 'doctype' | 'style' | 'script';
    };
export type InsertItem = InsertChoice & {
  readonly label: string;
  readonly sub?: string;
  readonly search?: string;
  readonly cat: 'components' | 'elements' | 'other';
  readonly icon: React.ReactNode;
};
interface InsertSearchProps {
  readonly components?: readonly InsertComponent[];
  readonly allowSlot?: boolean;
  readonly onInsert: (item: InsertItem) => void;
  readonly onClose: () => void;
}
export default function InsertSearch(props: InsertSearchProps) {
  const { onInsert, onClose } = props;
  const state = useInsertSearch(props);
  const { query, setQuery, tab, setTab, highlight, setHighlight, listRef, results } = state;
  return (
    <div
      className="insert-overlay"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        className="insert-palette"
        onKeyDown={(event) => insertKey(event, state, onInsert, onClose)}
      >
        <div className="insert-search-row">
          <SearchIcon size={14} />
          <input
            autoFocus
            value={query}
            placeholder="Search components, elements…"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="insert-tabs">
          {TABS.map((tabEntry) => (
            <button
              key={tabEntry.key}
              className={`insert-tab ${tab === tabEntry.key ? 'on' : ''}`}
              onClick={() => setTab(tabEntry.key)}
            >
              {tabEntry.label}
            </button>
          ))}
        </div>
        <div className="insert-results" ref={listRef}>
          {results.map((item, i) => (
            <div
              key={insertItemKey(item)}
              className={`insert-item ${i === highlight ? 'highlight' : ''}`}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => onInsert(item)}
            >
              <span className="insert-item-icon">{item.icon}</span>
              <span className="insert-item-label">{item.label}</span>
              {item.sub && <span className="insert-item-sub">{item.sub}</span>}
            </div>
          ))}
          {results.length === 0 && <div className="props-empty">No matches.</div>}
        </div>
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

function useInsertSearch({ components, allowSlot }: InsertSearchProps) {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<Tab>('all');
  const [highlight, setHighlight] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const allItems = useMemo(
    () => insertItems(components ?? [], { allowSlot }),
    [components, allowSlot],
  );
  // The words, and where they land: see src/features/palette/insertRank.ts. The trailing space
  // is meaningful, so the query is not trimmed on the way in.
  const results = useMemo(() => {
    const items = allItems.filter((i) => tab === 'all' || i.cat === tab);
    return rankInsertItems(items, query).slice(0, 60);
  }, [allItems, query, tab]);

  useEffect(() => setHighlight(0), [query, tab]);

  // Keep the highlighted row scrolled into view.
  useEffect(() => {
    const element = listRef.current?.children[highlight];
    if (element) {
      element.scrollIntoView({ block: 'nearest' });
    }
  }, [highlight]);

  return { query, setQuery, tab, setTab, highlight, setHighlight, listRef, results };
}

type InsertState = ReturnType<typeof useInsertSearch>;
function insertKey(
  event: React.KeyboardEvent,
  state: InsertState,
  onInsert: (item: InsertItem) => void,
  onClose: () => void,
): void {
  const { results, highlight, setHighlight, tab, setTab } = state;
  if (event.key === 'Escape') {
    event.preventDefault();
    onClose();
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    setHighlight((current) => Math.min(current + 1, results.length - 1));
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    setHighlight((current) => Math.max(current - 1, 0));
  } else if (event.key === 'Enter') {
    event.preventDefault();
    const item = results[highlight];
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
function insertItems(
  components: readonly InsertComponent[],
  options: {
    readonly allowSlot: boolean | undefined;
  },
): InsertItem[] {
  assert(components.length <= LIMITS.scanEntriesMax, 'InsertSearch: component limit exceeded');
  const items = [
    ...insertComponents(components),
    ...insertAssets(),
    ...insertTags(options),
    ...OTHER_ITEMS,
  ];
  assert(
    items.length <= LIMITS.scanEntriesMax + HTML_TAGS.length + 11,
    'InsertSearch: combined item limit exceeded',
  );
  // Project components stay first so a local Image is not shadowed by Astro's.
  return items;
}
function insertComponents(components: readonly InsertComponent[]): InsertItem[] {
  return components.map((component): InsertItem => ({
    type: 'component',
    ...(component.path === undefined ? {} : { path: component.path }),
    name: component.name,
    label: component.name,
    sub: component.folder || 'component',
    cat: 'components',
    icon: component.isLayout ? (
      <LayoutIcon size={15} style={{ color: '#79e09c' }} />
    ) : (
      <ElementComponentIcon size={15} style={{ color: '#79e09c' }} />
    ),
  }));
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
const OTHER_ITEMS: readonly InsertItem[] = [
  {
    type: 'map',
    label: 'Loop',
    sub: 'items.map',
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
