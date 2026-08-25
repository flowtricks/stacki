import React, { useEffect, useRef, useState } from 'react';
import { comparePageNames, isCollectionRoute, leadsFolders } from '../pageOrder.js';
import Dropdown from '../ui/Dropdown.jsx';
import {
  FileIcon,
  CollectionIcon,
  PlusIcon,
  RefreshIcon,
  CloseIcon,
  TrashIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
} from '../ui/Icons.jsx';

// Builds a nested tree from the flat page list + folder list.
// node = { dirs: Map<name, node>, pages: [{...page, base}] }
function buildTree(pages, folders) {
  const root = { dirs: new Map(), pages: [] };
  const dirNode = (rel) => {
    if (!rel) return root;
    let node = root;
    for (const part of rel.split('/')) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), pages: [] });
      node = node.dirs.get(part);
    }
    return node;
  };
  for (const f of folders) dirNode(f);
  for (const p of pages) {
    const parts = p.name.split('/');
    dirNode(parts.slice(0, -1).join('/')).pages.push({ ...p, base: parts[parts.length - 1] });
  }
  return root;
}

function countPages(node) {
  let n = node.pages.length;
  for (const child of node.dirs.values()) n += countPages(child);
  return n;
}

const stripExt = (base) => base.replace(/\.(astro|mdx?)$/i, '');
const extOf = (base) => (base.match(/\.(astro|mdx?)$/i) || ['.astro'])[0];
const dirOf = (rel) => rel.split('/').slice(0, -1).join('/');

// Astro's routing lives in the filename. The brackets of `[slug]` and the dots
// of `[...rest]` are what make a route dynamic; strip them and the page is a
// static one, which means Astro stops consulting `getStaticPaths` — so a page
// held back by returning `[]` from it quietly starts shipping. The sanitizer
// therefore keeps what Astro routes with and drops the rest: separators, so a
// rename stays one segment, and any leading dot or dash, so what comes back is
// a name rather than `..` or a hidden file.
const sanitizeSegment = (text) =>
  text
    .trim()
    .replace(/[/\\]+/g, '-')
    .replace(/[^\w\-[\].]+/g, '-')
    .replace(/^[.\-]+/, '');

// Webflow-style pages tree: folders (create, rename, delete, collapse with
// page counts), pages (select, rename, delete), drag pages between folders,
// and a search field over names and routes.
export default function PagesPanel({
  scan,
  currentPage,
  injectedRoutes = [],
  onSelectRoute,
  onSelect,
  onCreate,
  onDelete,
  onRescan,
  onMovePage,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
}) {
  const [showNew, setShowNew] = useState(false);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [editing, setEditing] = useState(null); // {type:'page'|'folder', key}
  const [dropDir, setDropDir] = useState(null); // folder rel path or '' (root)

  const tree = buildTree(scan.pages, scan.pageFolders || []);
  const q = query.trim().toLowerCase();

  const isPagePayload = (e) => e.dataTransfer.types.includes('avb/page');

  const dropInto = (e, dirRel) => {
    e.preventDefault();
    e.stopPropagation();
    setDropDir(null);
    let payload;
    try {
      payload = JSON.parse(e.dataTransfer.getData('avb/page'));
    } catch {
      return;
    }
    if (!payload?.name) return;
    if (dirOf(payload.name) === dirRel) return; // already there
    const base = payload.name.split('/').pop();
    onMovePage(payload, dirRel ? `${dirRel}/${base}` : base);
  };

  const dragProps = (dirRel) => ({
    onDragOver: (e) => {
      if (isPagePayload(e)) {
        e.preventDefault();
        e.stopPropagation();
        setDropDir(dirRel);
      }
    },
    onDrop: (e) => dropInto(e, dirRel),
  });

  // The "did it change?" question is asked of what was typed, before any
  // sanitizing: confirming the name a page already has is a no-op whatever
  // characters it is spelled with. Comparing the sanitized candidate instead
  // meant a bracketed route could never match itself, so committing the
  // untouched field — a click away from it is enough — renamed the file.
  const commitPageRename = (page, text) => {
    setEditing(null);
    const current = stripExt(page.base);
    const typed = text.trim().replace(/\.(astro|mdx?)$/i, '');
    if (typed === current) return;
    const base = sanitizeSegment(typed);
    if (!base || base === current) return;
    const dir = dirOf(page.name);
    onMovePage(page, `${dir ? dir + '/' : ''}${base}${extOf(page.base)}`);
  };

  const commitFolderRename = (rel, text) => {
    setEditing(null);
    const parts = rel.split('/');
    const current = parts[parts.length - 1];
    const typed = text.trim();
    if (typed === current) return;
    const name = sanitizeSegment(typed);
    if (!name || name === current) return;
    onRenameFolder(rel, [...parts.slice(0, -1), name].join('/'));
  };

  const renderPage = (page, depth) => {
    const isEditing = editing?.type === 'page' && editing.key === page.path;
    // A bracketed route is one Astro renders per collection entry, so it gets
    // the collection glyph rather than the page one.
    const collection = isCollectionRoute(page.name);
    return (
      <div
        key={page.path}
        className={`list-item ${collection ? 'collection' : ''} ${
          currentPage?.path === page.path ? 'active' : ''
        }`}
        style={{ paddingLeft: 8 + depth * 14 }}
        title={page.route}
        draggable={!isEditing}
        onDragStart={(e) => {
          e.dataTransfer.setData(
            'avb/page',
            JSON.stringify({ path: page.path, name: page.name })
          );
          e.dataTransfer.effectAllowed = 'move';
        }}
        onClick={() => !isEditing && onSelect(page)}
        onDoubleClick={(e) => {
          e.stopPropagation();
          setEditing({ type: 'page', key: page.path });
        }}
      >
        <span className="icon">
          {collection ? <CollectionIcon size={13} /> : <FileIcon size={13} />}
        </span>
        {isEditing ? (
          <RenameInput
            initial={stripExt(page.base)}
            onCommit={(t) => commitPageRename(page, t)}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <span className="label">{stripExt(page.base)}</span>
        )}
        <button
          className="row-action"
          title="Delete page"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(page);
          }}
        >
          <CloseIcon size={11} />
        </button>
      </div>
    );
  };

  const renderFolder = (name, node, rel, depth) => {
    const isCollapsed = collapsed.has(rel);
    const isEditing = editing?.type === 'folder' && editing.key === rel;
    const count = countPages(node);
    return (
      <React.Fragment key={`dir:${rel}`}>
        <div
          className={`list-item folder ${dropDir === rel ? 'drop' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() =>
            !isEditing &&
            setCollapsed((prev) => {
              const next = new Set(prev);
              if (next.has(rel)) next.delete(rel);
              else next.add(rel);
              return next;
            })
          }
          onDoubleClick={(e) => {
            e.stopPropagation();
            setEditing({ type: 'folder', key: rel });
          }}
          {...dragProps(rel)}
        >
          <span className="icon">
            {isCollapsed ? <FolderIcon size={13} /> : <FolderOpenIcon size={13} />}
          </span>
          {isEditing ? (
            <RenameInput
              initial={name}
              onCommit={(t) => commitFolderRename(rel, t)}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <span className="label">{name}</span>
          )}
          {isCollapsed && count > 0 && (
            <span className="sub folder-count">
              {count} page{count === 1 ? '' : 's'}
            </span>
          )}
          <button
            className="row-action"
            title="Delete folder"
            onClick={(e) => {
              e.stopPropagation();
              onDeleteFolder(rel, count);
            }}
          >
            <TrashIcon size={12} />
          </button>
        </div>
        {!isCollapsed && renderChildren(node, rel, depth + 1)}
      </React.Fragment>
    );
  };

  const renderChildren = (node, rel, depth) => {
    const pages = node.pages.slice().sort((a, b) => comparePageNames(a.base, b.base));
    // The folder's own page goes above the folders — see leadsFolders. The
    // rest sit below them, which is where a page under a folder belongs.
    const lead = pages.filter((p) => leadsFolders(p.base));
    const rest = pages.filter((p) => !leadsFolders(p.base));
    return (
      <>
        {lead.map((p) => renderPage(p, depth))}
        {[...node.dirs.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, child]) =>
            renderFolder(name, child, rel ? `${rel}/${name}` : name, depth)
          )}
        {rest.map((p) => renderPage(p, depth))}
      </>
    );
  };

  const searchResults = q
    ? scan.pages
        .filter((p) => p.name.toLowerCase().includes(q) || p.route.toLowerCase().includes(q))
        .sort((a, b) => comparePageNames(a.name, b.name))
    : null;

  return (
    <div className="panel-section grow">
      <div className="panel-header">
        <h2>Pages</h2>
        <div style={{ display: 'flex', gap: 2 }}>
          <button className="ghost" title="Rescan project files" onClick={onRescan}>
            <RefreshIcon size={13} />
          </button>
          <button
            className="ghost"
            title="New folder"
            onClick={async () => {
              const name = await onCreateFolder();
              if (name) setEditing({ type: 'folder', key: name });
            }}
          >
            <FolderPlusIcon size={13} />
          </button>
          <button className="ghost" title="New page" onClick={() => setShowNew(true)}>
            <PlusIcon size={13} />
          </button>
        </div>
      </div>

      <div style={{ padding: '0 12px 8px' }}>
        <input
          value={query}
          placeholder="Search pages and folders"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div
        className={`panel-body ${dropDir === '' ? 'pages-root-drop' : ''}`}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDropDir(null);
        }}
        {...(searchResults ? {} : dragProps(''))}
      >
        {searchResults ? (
          <>
            {searchResults.map((p) => (
              <div
                key={p.path}
                className={`list-item ${isCollectionRoute(p.name) ? 'collection' : ''} ${
                  currentPage?.path === p.path ? 'active' : ''
                }`}
                onClick={() => onSelect(p)}
              >
                <span className="icon">
                  {isCollectionRoute(p.name) ? (
                    <CollectionIcon size={13} />
                  ) : (
                    <FileIcon size={13} />
                  )}
                </span>
                <span className="label">
                  {stripExt(p.name.split('/').pop())}
                  <div className="sub">{p.route}</div>
                </span>
              </div>
            ))}
            {searchResults.length === 0 && (
              <div className="props-empty">No pages match “{query.trim()}”.</div>
            )}
          </>
        ) : (
          <>
            {renderChildren(tree, '', 0)}
            {scan.pages.length === 0 && (scan.pageFolders || []).length === 0 && !injectedRoutes.length && (
              <div className="props-empty">No pages yet. Create one with +.</div>
            )}
            {/* Routes the dev server serves that this project has no file for:
                an integration injected them, and their source lives inside a
                dependency. They can be previewed, and deliberately nothing
                else — renaming or deleting a page you do not own is not a
                thing the editor should offer. */}
            {injectedRoutes.length > 0 && (
              <div className="vars-table pages-injected">
                <h3 className="list-item folder pages-injected-head">
                  <span className="icon">
                    <FolderIcon size={13} />
                  </span>
                  <span className="label">
                    From {injectedRoutes[0].from ? injectedRoutes[0].from : 'integrations'}
                  </span>
                  <span className="sub">preview only</span>
                </h3>
                {injectedRoutes.map((r) => (
                  <div
                    key={r.route}
                    className={`list-item ${currentPage?.route === r.route ? 'active' : ''}`}
                    style={{ paddingLeft: 22 }}
                    title={`${r.route}${r.entrypoint ? `\n${r.entrypoint}` : ''}`}
                    onClick={() => onSelectRoute?.(r)}
                  >
                    <span className="icon">
                      <FileIcon size={13} />
                    </span>
                    <span className="label">{r.route}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {showNew && (
        <NewPageModal
          layouts={scan.layouts}
          onClose={() => setShowNew(false)}
          onCreate={(name, layout) => {
            setShowNew(false);
            onCreate(name, layout);
          }}
        />
      )}
    </div>
  );
}

// Inline rename input: commits on Enter/blur, cancels on Escape.
//
// Escape used to cancel by committing the name it started with, which is only
// a no-op if a round trip through the sanitizer leaves that name alone. It
// doesn't for a dynamic route, so backing out of a rename you never meant to
// start was itself a rename. It closes the field now and touches nothing.
function RenameInput({ initial, onCommit, onCancel }) {
  const [text, setText] = useState(initial);
  const ref = useRef(null);
  const settled = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (fn) => {
    if (settled.current) return;
    settled.current = true;
    fn();
  };
  return (
    <input
      ref={ref}
      className="rename-input"
      value={text}
      spellCheck={false}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => finish(() => onCommit(text))}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(() => onCommit(text));
        else if (e.key === 'Escape') finish(onCancel);
      }}
    />
  );
}

function NewPageModal({ layouts, onClose, onCreate }) {
  const [name, setName] = useState('');
  const [layout, setLayout] = useState(layouts[0]?.name || '');

  const submit = () => {
    if (!name.trim()) return;
    onCreate(name.trim(), layout || null);
  };

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">New Page</div>
        <div className="modal-body">
          <div>
            <label>Page name (e.g. "about" or "blog/post-1")</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              placeholder="about"
            />
          </div>
          <div>
            <label>Layout</label>
            <Dropdown
              value={layout}
              options={[
                { value: '', label: '(no layout)', dim: true },
                ...layouts.map((l) => ({ value: l.name, label: l.name })),
              ]}
              onChange={setLayout}
            />
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!name.trim()} onClick={submit}>
            Create Page
          </button>
        </div>
      </div>
    </div>
  );
}
