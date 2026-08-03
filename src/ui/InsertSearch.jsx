import React, { useEffect, useMemo, useRef, useState } from 'react';
import { HTML_TAGS } from '../elementSchemas.js';
import {
  elementIcon,
  ElementComponentIcon,
  LayoutIcon,
  RepeatIcon,
  TextIcon,
  CommentIcon,
  CodeIcon,
  SearchIcon,
} from './Icons.jsx';

const TABS = [
  { key: 'all', label: 'All results' },
  { key: 'components', label: 'Components' },
  { key: 'elements', label: 'Elements' },
  { key: 'other', label: 'Other' },
];

// Quick-insert palette (⌘F / ⌘E): fuzzy-searches components, HTML tags, and
// special node types; Enter or click inserts at the current selection.
export default function InsertSearch({ components, allowSlot, onInsert, onClose }) {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState('all');
  const [highlight, setHighlight] = useState(0);
  const listRef = useRef(null);

  const allItems = useMemo(() => {
    // Layouts sit in the same list as components — they insert identically,
    // and their folder in `sub` both says where they came from and makes
    // them findable by typing "layouts".
    const comps = (components || []).map((c) => ({
      type: 'component',
      name: c.name,
      label: c.name,
      sub: c.folder || 'component',
      cat: 'components',
      icon: c.isLayout ? (
        <LayoutIcon size={15} style={{ color: '#79e09c' }} />
      ) : (
        <ElementComponentIcon size={15} style={{ color: '#79e09c' }} />
      ),
    }));
    // <slot> only belongs in a component or layout — on a page it renders
    // nothing, since a page has no caller to pass it content.
    const tags = (allowSlot ? [...HTML_TAGS, 'slot'].sort() : HTML_TAGS).map((tag) => ({
      type: 'element',
      tag,
      label: `<${tag}>`,
      search: tag === 'slot' ? 'slot children content' : tag,
      sub: tag === 'slot' ? 'what the caller passes in' : undefined,
      cat: 'elements',
      icon: elementIcon(tag, 14),
    }));
    const other = [
      { type: 'map', label: 'Loop', sub: 'items.map', cat: 'other', icon: <RepeatIcon size={14} style={{ color: '#c4afff' }} /> },
      { type: 'text', label: 'Text', cat: 'other', icon: <TextIcon size={14} /> },
      { type: 'comment', label: 'Comment', cat: 'other', icon: <CommentIcon size={14} /> },
      { type: 'expr', label: 'Code Expression', sub: '{ }', cat: 'other', icon: <CodeIcon size={14} /> },
      { type: 'style', label: 'Style Block', sub: '<style>', cat: 'other', icon: <CodeIcon size={14} /> },
      { type: 'script', label: 'Script Block', sub: '<script>', cat: 'other', icon: <CodeIcon size={14} /> },
    ];
    return [...comps, ...tags, ...other];
  }, [components, allowSlot]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    let items = allItems.filter((i) => tab === 'all' || i.cat === tab);
    if (q) {
      const scored = [];
      for (const item of items) {
        const hay = (item.search || item.label).toLowerCase();
        const sub = (item.sub || '').toLowerCase();
        let score = -1;
        if (hay.startsWith(q)) score = 0;
        else if (hay.includes(q)) score = 1;
        else if (sub.includes(q)) score = 2;
        if (score >= 0) scored.push({ item, score });
      }
      scored.sort((a, b) => a.score - b.score);
      items = scored.map((s) => s.item);
    }
    return items.slice(0, 60);
  }, [allItems, query, tab]);

  useEffect(() => setHighlight(0), [query, tab]);

  // Keep the highlighted row scrolled into view.
  useEffect(() => {
    const el = listRef.current?.children[highlight];
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (results[highlight]) onInsert(results[highlight]);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const idx = TABS.findIndex((t) => t.key === tab);
      setTab(TABS[(idx + (e.shiftKey ? TABS.length - 1 : 1)) % TABS.length].key);
    }
  };

  return (
    <div className="insert-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="insert-palette" onKeyDown={onKeyDown}>
        <div className="insert-search-row">
          <SearchIcon size={14} />
          <input
            autoFocus
            value={query}
            placeholder="Search components, elements…"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="insert-tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={`insert-tab ${tab === t.key ? 'on' : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="insert-results" ref={listRef}>
          {results.map((item, i) => (
            <div
              key={`${item.type}-${item.label}`}
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
