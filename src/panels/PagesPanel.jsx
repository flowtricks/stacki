import React, { useEffect, useRef, useState } from 'react';
import Dropdown from '../ui/Dropdown.jsx';
import {
  FileIcon,
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

// Webflow-style pages tree: folders (create, rename, delete, collapse with
// page counts), pages (select, rename, delete), drag pages between folders,
// and a search field over names and routes.
export default function PagesPanel({
  scan,
  currentPage,
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

  const commitPageRename = (page, text) => {
    setEditing(null);
    const base = text.trim().replace(/\.(astro|md)$/i, '').replace(/[^\w-]+/g, '-');
    if (!base || base === stripExt(page.base)) return;
    const dir = dirOf(page.name);
    onMovePage(page, `${dir ? dir + '/' : ''}${base}${extOf(page.base)}`);
  };

  const commitFolderRename = (rel, text) => {
    setEditing(null);
    const name = text.trim().replace(/[^\w-]+/g, '-');
    const parts = rel.split('/');
    if (!name || name === parts[parts.length - 1]) return;
    onRenameFolder(rel, [...parts.slice(0, -1), name].join('/'));
  };

  const renderPage = (page, depth) => {
    const isEditing = editing?.type === 'page' && editing.key === page.path;
    return (
      <div
        key={page.path}
        className={`list-item ${currentPage?.path === page.path ? 'active' : ''}`}
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
          <FileIcon size={13} />
        </span>
        {isEditing ? (
          <RenameInput initial={stripExt(page.base)} onCommit={(t) => commitPageRename(page, t)} />
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

  const renderChildren = (node, rel, depth) => (
    <>
      {[...node.dirs.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, child]) =>
          renderFolder(name, child, rel ? `${rel}/${name}` : name, depth)
        )}
      {node.pages
        .slice()
        .sort((a, b) => a.base.localeCompare(b.base))
        .map((p) => renderPage(p, depth))}
    </>
  );

  const searchResults = q
    ? scan.pages.filter(
        (p) => p.name.toLowerCase().includes(q) || p.route.toLowerCase().includes(q)
      )
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
                className={`list-item ${currentPage?.path === p.path ? 'active' : ''}`}
                onClick={() => onSelect(p)}
              >
                <span className="icon">
                  <FileIcon size={13} />
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
            {scan.pages.length === 0 && (scan.pageFolders || []).length === 0 && (
              <div className="props-empty">No pages yet. Create one with +.</div>
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
function RenameInput({ initial, onCommit }) {
  const [text, setText] = useState(initial);
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      className="rename-input"
      value={text}
      spellCheck={false}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onCommit(text)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onCommit(text);
        else if (e.key === 'Escape') onCommit(initial);
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
