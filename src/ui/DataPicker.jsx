import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronRightIcon, ChevronLeftIcon, CheckIcon, CodeIcon, SearchIcon, PencilIcon } from './Icons.jsx';

// The data behind the page, as something you can look through rather than
// something you have to already know. Every row is a value that is in scope
// here, with what it currently holds beside it — so choosing what a prop is
// bound to is reading a list of real content, not writing `post.data.pubDate`
// from memory.
//
// The tree comes from dataTree(); this only decides what is open, what a
// search matches, and what a click means.

// Every ancestor of a path, so opening the picker on an existing binding shows
// it rather than making you find it: `post.data.title` opens post and post.data.
function ancestorsOf(path) {
  const out = [];
  const src = String(path || '');
  let acc = '';
  for (const part of src.split('.')) {
    // Array steps ride along with the name they belong to: `posts[0]` is one
    // step down from `posts`, not two.
    const m = part.match(/^([^[]*)((\[\d+\])*)$/);
    acc = acc ? `${acc}.${m ? m[1] : part}` : m ? m[1] : part;
    if (acc !== src) out.push(acc);
    for (const idx of (m?.[2] || '').match(/\[\d+\]/g) || []) {
      acc += idx;
      if (acc !== src) out.push(acc);
    }
  }
  return out;
}

function flatten(nodes, out = []) {
  for (const n of nodes) {
    out.push(n);
    if (n.children) flatten(n.children, out);
  }
  return out;
}

const SECTION_LABEL = { collections: 'Collections in this project' };

// A field can be bound to something this entry doesn't have — an optional
// field left unset, or data the app can't see the shape of. The path is still
// what the chip says, so it is shown where it belongs and marked, rather than
// leaving the picker looking like it doesn't know what the chip points at.
function withCurrent(tree, current) {
  if (!current) return tree;
  const flat = flatten(tree || []);
  if (flat.some((n) => n.path === current)) return tree;
  let anchor = null;
  for (const p of ancestorsOf(current)) {
    const found = flat.find((n) => n.path === p);
    if (found) anchor = found;
  }
  const missing = {
    path: current,
    key: anchor ? current.slice(anchor.path.length).replace(/^\./, '') : current,
    kind: 'not in this entry',
    preview: '',
    children: null,
    missing: true,
  };
  if (!anchor) return [...(tree || []), missing];
  const graft = (nodes) =>
    nodes.map((n) =>
      n.path === anchor.path
        ? { ...n, children: [...(n.children || []), missing] }
        : n.children
          ? { ...n, children: graft(n.children) }
          : n
    );
  return graft(tree || []);
}

export default function DataPicker({
  tree: rawTree,
  current,
  entries,
  onPick,
  onExpand,
  onWrite,
  /** Opens whatever defines the value this picker was opened ON. Absent when
   *  the picker wasn't opened on anything, or when nothing findable defines it. */
  onEdit,
  editLabel = 'Edit',
  footer = true,
}) {
  const [query, setQuery] = useState('');
  const tree = useMemo(() => withCurrent(rawTree, current), [rawTree, current]);
  const [open, setOpen] = useState(() => {
    const start = new Set(ancestorsOf(current));
    // Nothing bound yet: open the first root that holds anything, so the panel
    // opens on data rather than on a list of closed names.
    if (!start.size) {
      const first = (tree || []).find((n) => n.children?.length);
      if (first) start.add(first.path);
    }
    return start;
  });
  const searchRef = useRef(null);
  const listRef = useRef(null);
  const selectedRef = useRef(null);

  // Open ON what the field is already bound to: the ancestors are expanded
  // above, and the row itself is brought into view here. A path four levels
  // down is otherwise below the fold, which reads as the picker not knowing
  // what the chip was pointing at.
  useLayoutEffect(() => {
    const list = listRef.current;
    const row = selectedRef.current;
    if (!list || !row) return;
    const lr = list.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    if (rr.top >= lr.top && rr.bottom <= lr.bottom) return; // already in view
    list.scrollTop += rr.top - lr.top - (lr.height - rr.height) / 2;
  }, [current]);

  const q = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q) return null;
    return flatten(tree || []).filter(
      (n) => n.path.toLowerCase().includes(q) || String(n.preview).toLowerCase().includes(q)
    );
  }, [q, tree]);

  const toggle = (node, e) => {
    e.stopPropagation();
    // A collection nobody has looked at yet has no rows until it is asked for.
    if (node.lazy && !node.children?.length) onExpand?.(node);
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(node.path)) next.delete(node.path);
      else next.add(node.path);
      return next;
    });
  };

  const row = (n, depth, showPath, root) => {
    const expandable = !!n.children?.length || n.lazy;
    const isOpen = open.has(n.path);
    const from = root || n;
    const isCurrent = n.path === current;
    return (
      <React.Fragment key={n.path}>
        <div
          ref={isCurrent ? selectedRef : undefined}
          className={`dp-row ${isCurrent ? 'selected' : ''} ${
            n.pickable === false ? 'path-only' : ''
          } ${n.missing ? 'missing' : ''}`}
          style={{ paddingLeft: 6 + depth * 13 }}
          title={`${n.path}${n.kind ? ` — ${n.kind}` : ''}`}
          onMouseDown={(e) => e.preventDefault()}
          // The root carries what has to happen before this path means
          // anything — a collection the page doesn't read yet needs its query
          // written first.
          onClick={() =>
            // A row kept only so a list beneath it can be reached opens
            // instead of being chosen — there is no looping over an object.
            n.pickable === false ? toggle(n, { stopPropagation() {} }) : onPick(n.path, from.query || null)
          }
        >
          <span
            className={`dp-twist ${expandable ? '' : 'hidden'} ${isOpen ? 'open' : ''}`}
            onClick={expandable ? (e) => toggle(n, e) : undefined}
          >
            <ChevronRightIcon size={10} />
          </span>
          <span className="dp-key">{showPath ? n.path : n.key}</span>
          {isCurrent && <CheckIcon size={11} className="dp-check" />}
          <span className={`dp-val ${n.preview ? '' : 'kind'}`}>{n.preview || n.kind}</span>
        </div>
        {isOpen &&
          (n.children?.length ? (
            n.children.map((c) => row(c, depth + 1, false, from))
          ) : n.lazy ? (
            <div className="dp-loading" style={{ paddingLeft: 19 + depth * 13 }}>
              Reading one entry…
            </div>
          ) : null)}
      </React.Fragment>
    );
  };

  // Roots in order, with a heading wherever the section changes — the
  // collections at the foot are a different kind of thing from what is already
  // in scope, and reading as one list would hide that.
  const roots = (nodes) => {
    let section = null;
    return (nodes || []).map((n) => {
      const head = n.section && n.section !== section ? SECTION_LABEL[n.section] : null;
      section = n.section || section;
      return (
        <React.Fragment key={`s:${n.path}`}>
          {head && <div className="dp-section">{head}</div>}
          {row(n, 0, false, null)}
        </React.Fragment>
      );
    });
  };

  return (
    <div className="data-picker">
      {/* Which entry the values below are FROM. A dynamic route stands for
          many, and the one on the canvas is the one being read here — so
          stepping through them previews the page against other content and
          re-reads this list against it at the same time. */}
      {entries && entries.count > 1 && (
        <div className="dp-entry">
          <button
            type="button"
            className="dp-step"
            title="Previous entry"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => entries.onStep(-1)}
          >
            <ChevronLeftIcon size={12} />
          </button>
          <span className="dp-entry-label" title={entries.label}>
            {entries.label}
          </span>
          <span className="dp-entry-count">
            {entries.index + 1}/{entries.count}
          </span>
          <button
            type="button"
            className="dp-step"
            title="Next entry"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => entries.onStep(1)}
          >
            <ChevronRightIcon size={12} />
          </button>
        </div>
      )}
      <div className="dp-search">
        <SearchIcon size={12} />
        <input
          ref={searchRef}
          value={query}
          placeholder="Search data…"
          spellCheck={false}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="dp-list" ref={listRef}>
        {/* A search flattens the tree: what you want is the row, not where it
            sits, and full paths say where that is anyway. */}
        {matches ? matches.map((n) => row(n, 0, true, null)) : roots(tree)}
        {((matches && !matches.length) || (!matches && !(tree || []).length)) && (
          <div className="dp-empty">
            {matches
              ? 'Nothing matches'
              : 'No data in scope here — add a prop to this file, or a const to its frontmatter.'}
          </div>
        )}
      </div>
      {/* Above "Write an expression…", because it is about the thing already
          bound rather than about replacing it. Only ever rendered for a picker
          opened on a specific chip — the field's own handle opens this on
          nothing in particular, and there is no "the" value to edit then. */}
      {onEdit && (
        <div className="dp-foot" onMouseDown={(e) => e.preventDefault()} onClick={onEdit}>
          <PencilIcon size={11} />
          {editLabel}
        </div>
      )}
      {footer && (
        <div className="dp-foot" onMouseDown={(e) => e.preventDefault()} onClick={onWrite}>
          <CodeIcon size={11} />
          Write an expression…
        </div>
      )}
    </div>
  );
}
