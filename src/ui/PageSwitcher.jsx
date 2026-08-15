import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { comparePageNames, isCollectionRoute } from '../pageOrder.js';
import { FileIcon, CollectionIcon, ChevronDownIcon, CheckIcon } from './Icons.jsx';

// Generated routes read the same here as in the Pages panel — same glyph,
// same purple.
const PageGlyph = ({ page, size }) =>
  isCollectionRoute(page?.name) ? <CollectionIcon size={size} /> : <FileIcon size={size} />;

// Title-bar page switcher: shows the current page, opens a searchable list
// of the project's pages (name or route), picking one switches to it.
export default function PageSwitcher({ pages, currentPage, onSelect }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const popRef = useRef(null);
  const inputRef = useRef(null);

  const pretty = (p) => p.name.replace(/\.(astro|mdx?)$/i, '');
  const q = query.trim().toLowerCase();
  const filtered = (pages || [])
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.route.toLowerCase().includes(q))
    .sort((a, b) => comparePageNames(a.name, b.name));

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    setPos({ left: Math.max(8, r.left + r.width / 2 - 140), top: r.bottom + 6 });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setHighlight(0);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    const onDown = (e) => {
      if (
        popRef.current &&
        !popRef.current.contains(e.target) &&
        btnRef.current &&
        !btnRef.current.contains(e.target)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (p) => {
    setOpen(false);
    if (p && p.path !== currentPage?.path) onSelect(p);
  };

  const onInputKey = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered.length) pick(filtered[Math.min(highlight, filtered.length - 1)]);
    }
  };

  return (
    <>
      <button
        ref={btnRef}
        className={`page-switch-btn ${isCollectionRoute(currentPage?.name) ? 'collection' : ''}`}
        title="Switch page"
        onClick={() => setOpen((o) => !o)}
      >
        <PageGlyph page={currentPage} size={12} />
        <span className="page-switch-label">{currentPage ? pretty(currentPage) : 'No page'}</span>
        <ChevronDownIcon size={10} className="page-switch-chevron" />
      </button>

      {open && pos && (
        <div ref={popRef} className="page-menu" style={{ left: pos.left, top: pos.top }}>
          <input
            ref={inputRef}
            className="page-menu-search"
            value={query}
            placeholder="Search pages…"
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlight(0);
            }}
            onKeyDown={onInputKey}
          />
          <div className="page-menu-list">
            {filtered.map((p, i) => {
              const cur = p.path === currentPage?.path;
              return (
                <div
                  key={p.path}
                  className={`page-menu-item ${isCollectionRoute(p.name) ? 'collection' : ''} ${
                    i === highlight ? 'highlight' : ''
                  } ${cur ? 'current' : ''}`}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => pick(p)}
                >
                  <PageGlyph page={p} size={12} />
                  <span className="page-menu-name">{pretty(p)}</span>
                  <span className="page-menu-route">{p.route}</span>
                  {cur && <CheckIcon size={11} />}
                </div>
              );
            })}
            {filtered.length === 0 && <div className="page-menu-empty">No matching pages</div>}
          </div>
        </div>
      )}
    </>
  );
}
