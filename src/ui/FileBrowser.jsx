import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon, FolderIcon, FolderOpenIcon } from './Icons.jsx';
import FileStatus from './FileStatus.jsx';

// Every file in the project, as a tree you can search and tick.
//
// Two things needed the same thing and each had half of it: the commit picker
// listed only files that had changed, flat and with no way to find anything;
// the History panel could say what a version touched but never what the
// project actually contains. So this is one component doing both — the whole
// project, with what has happened to each file marked on it.
//
// It stays useful at both sizes. A project with eight files should not make
// you expand anything; one with eight hundred should be searchable and should
// not draw eight hundred rows. Hence: folders start open when the project is
// small, search flattens the tree to matches only, and ticking a folder ticks
// what is inside it.

// --- Searching --------------------------------------------------------------
//
// Subsequence matching, the way editors do it: "spi" finds "src/pages/index".
// Plain substring matching would not, and typing the separators is exactly the
// work this is meant to save.
export function fuzzyScore(query, path) {
  const q = query.toLowerCase();
  const p = path.toLowerCase();
  if (!q) return 0;
  let qi = 0;
  let score = 0;
  let streak = 0;
  let firstHit = -1;
  for (let i = 0; i < p.length && qi < q.length; i++) {
    if (p[i] !== q[qi]) {
      streak = 0;
      continue;
    }
    if (firstHit === -1) firstHit = i;
    // Runs of consecutive matches are worth more than the same letters
    // scattered, so "index" beats "i…n…d…e…x" spread across a long path.
    streak++;
    score += 1 + streak;
    // A match right after a separator is the start of a name, which is nearly
    // always what was meant.
    if (i === 0 || '/-_.'.includes(p[i - 1])) score += 4;
    qi++;
  }
  if (qi < q.length) return -1; // not all of the query is in there
  // Shorter paths, and matches nearer the front, first.
  return score - firstHit * 0.05 - p.length * 0.02;
}

/** The best matches for a query, most likely first. */
export function search(files, query, limit = 60) {
  if (!query.trim()) return [];
  return files
    .map((f) => ({ file: f, score: fuzzyScore(query.trim(), f.path) }))
    .filter((r) => r.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.file);
}

// --- The tree ---------------------------------------------------------------

/** Files grouped into nested folders, folders before files, both by name. */
export function buildTree(files) {
  const root = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { dirs: new Map(), files: [] });
      node = node.dirs.get(parts[i]);
    }
    node.files.push({ ...f, name: parts[parts.length - 1] });
  }
  const sortNode = (node) => {
    node.files.sort((a, b) => a.name.localeCompare(b.name));
    node.dirs = new Map([...node.dirs.entries()].sort(([a], [b]) => a.localeCompare(b)));
    for (const child of node.dirs.values()) sortNode(child);
  };
  sortNode(root);
  return root;
}

/** Every file path under a folder, for ticking the folder as one. */
function pathsUnder(node, prefix) {
  const out = node.files.map((f) => f.path);
  for (const [name, child] of node.dirs) out.push(...pathsUnder(child, `${prefix}${name}/`));
  return out;
}

export default function FileBrowser({
  files,
  // Ticking is optional: the History panel shows this as a list to look at,
  // the commit box as a list to choose from, and it is the same component.
  selectable = false,
  selected,
  onSelect,
  onOpen,
  emptyMessage = 'No files.',
  autoFocusSearch = false,
}) {
  const [query, setQuery] = useState('');
  const [closed, setClosed] = useState(() => new Set());
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    if (autoFocusSearch) inputRef.current?.focus();
  }, [autoFocusSearch]);

  const tree = useMemo(() => buildTree(files || []), [files]);
  const matches = useMemo(() => search(files || [], query), [files, query]);
  const searching = query.trim().length > 0;

  useEffect(() => setActive(0), [query]);

  const isOn = (p) => !!selected?.includes(p);
  const toggle = (paths, on) => {
    if (!onSelect) return;
    const set = new Set(selected || []);
    for (const p of paths) {
      if (on) set.delete(p);
      else set.add(p);
    }
    onSelect([...set]);
  };

  // Typing is the fastest way in, so the field takes the arrow keys and Enter
  // without anyone having to leave it.
  const onKeyDown = (e) => {
    if (!searching || !matches.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((n) => Math.min(n + 1, matches.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((n) => Math.max(n - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const f = matches[active];
      if (!f) return;
      if (selectable) toggle([f.path], isOn(f.path));
      else onOpen?.(f);
    }
  };

  const Row = ({ file, depth, index }) => (
    <div
      className={`fb-row ${index === active && searching ? 'active' : ''} ${
        isOn(file.path) ? 'on' : ''
      }`}
      style={{ paddingLeft: 6 + depth * 13 }}
      onClick={() => (selectable ? toggle([file.path], isOn(file.path)) : onOpen?.(file))}
      title={file.path}
    >
      {selectable && (
        <input
          type="checkbox"
          checked={isOn(file.path)}
          onChange={() => toggle([file.path], isOn(file.path))}
          onClick={(e) => e.stopPropagation()}
        />
      )}
      <span className="fb-name">{file.name || file.path.split('/').pop()}</span>
      {/* Where it is, but only while searching — in the tree the indentation
          already says it, and repeating it would be noise on every row. */}
      {searching && <span className="fb-dir">{file.path.split('/').slice(0, -1).join('/')}</span>}
      <FileStatus status={file.status} />
    </div>
  );

  const Folder = ({ name, node, prefix, depth }) => {
    const key = prefix + name;
    const shut = closed.has(key);
    const paths = pathsUnder(node, `${key}/`);
    const allOn = paths.length > 0 && paths.every(isOn);
    return (
      <>
        <div className="fb-folder" style={{ paddingLeft: 6 + depth * 13 }}>
          {selectable && (
            <input
              type="checkbox"
              checked={allOn}
              // Some but not all: the box says "not everything here", which is
              // a different fact from either ticked or empty.
              ref={(el) => el && (el.indeterminate = !allOn && paths.some(isOn))}
              onChange={() => toggle(paths, allOn)}
              onClick={(e) => e.stopPropagation()}
            />
          )}
          <button
            className="fb-folder-head"
            onClick={() =>
              setClosed((c) => {
                const next = new Set(c);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              })
            }
          >
            <span className="fb-caret">
              {shut ? <ChevronRightIcon size={11} /> : <ChevronDownIcon size={11} />}
            </span>
            <span className="fb-folder-icon">
              {shut ? <FolderIcon size={12} /> : <FolderOpenIcon size={12} />}
            </span>
            <span className="fb-name">{name}</span>
            <span className="fb-count">{paths.length}</span>
          </button>
        </div>
        {!shut && <Node node={node} prefix={`${key}/`} depth={depth + 1} />}
      </>
    );
  };

  const Node = ({ node, prefix, depth }) => (
    <>
      {[...node.dirs.entries()].map(([name, child]) => (
        <Folder key={prefix + name} name={name} node={child} prefix={prefix} depth={depth} />
      ))}
      {node.files.map((f) => (
        <Row key={f.path} file={f} depth={depth} index={-1} />
      ))}
    </>
  );

  return (
    <div className="file-browser">
      <div className="fb-search">
        <input
          ref={inputRef}
          value={query}
          placeholder="Search files…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {query && (
          <button className="ghost" onClick={() => setQuery('')} title="Clear">
            ×
          </button>
        )}
      </div>

      <div className="fb-list">
        {!files?.length && <div className="fb-empty">{emptyMessage}</div>}

        {searching ? (
          <>
            {!matches.length && <div className="fb-empty">Nothing matches “{query}”.</div>}
            {matches.map((f, i) => (
              <Row key={f.path} file={f} depth={0} index={i} />
            ))}
          </>
        ) : (
          files?.length > 0 && <Node node={tree} prefix="" depth={0} />
        )}
      </div>

      {selectable && (
        <div className="fb-foot">
          <button
            className="ghost"
            onClick={() => onSelect?.(selected?.length === files.length ? [] : files.map((f) => f.path))}
          >
            {selected?.length === files.length ? 'Clear all' : 'Select all'}
          </button>
          <span className="fb-selected">
            {selected?.length || 0} of {files?.length || 0}
          </span>
        </div>
      )}
    </div>
  );
}
