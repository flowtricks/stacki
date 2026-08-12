import React, { useCallback, useEffect, useState } from 'react';
import {
  CmsIcon,
  PlusIcon,
  ChevronRightIcon,
  ChevronLeftIcon,
  GearIcon,
  FolderDefaultIcon,
} from '../ui/Icons.jsx';
import { collectionOf } from '../cmsSchema.js';

// Where a collection comes from, as one row in the top level of the panel: a
// source file when the data is an exported const (one file usually holds
// several), the folder otherwise.
function groupOf(collection) {
  const dir = collection.dir || '';
  const fromFile = collection.rel.includes('#');
  if (fromFile) {
    const base = dir.split('/').pop() || dir;
    return {
      key: dir,
      kind: 'file',
      label: base.charAt(0).toUpperCase() + base.slice(1),
      path: `src/${dir}`,
    };
  }
  return {
    key: dir,
    kind: 'folder',
    label: dir ? dir.split('/').pop() : 'src',
    path: dir ? `src/${dir}` : 'src',
  };
}

// Left-rail panel: the files and folders under src/ that hold content, each
// opening onto the collections inside it. Picking a collection opens the
// editor over the canvas (see CmsView).
export default function CmsPanel({
  project,
  selectedRel,
  currentFile,
  refreshKey,
  onSelect,
  onOpenSettings,
  showToast,
}) {
  const [files, setFiles] = useState([]);
  const [creating, setCreating] = useState(false);
  // Which group is open; null is the list of groups.
  const [openKey, setOpenKey] = useState(null);

  const refresh = useCallback(async () => {
    const { files: list } = await window.avb.listCms(project.path);
    setFiles(list || []);
  }, [project.path]);

  // refreshKey bumps when the editor saves — our own writes don't come back
  // through the watcher, so the item counts would otherwise go stale.
  useEffect(() => {
    refresh();
    return window.avb.onCmsChanged(refresh);
  }, [refresh, refreshKey]);

  const act = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      showToast(
        String(err?.message || err).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ''),
        'error'
      );
    }
  };

  const collections = files.map(collectionOf);

  const groups = [];
  for (const c of collections) {
    const g = groupOf(c);
    // Every .astro file has some data in its frontmatter, and listing all of
    // them would bury the project's actual content files. Only the one being
    // edited is shown — its data is the data you're looking at on the canvas.
    if (g.key.toLowerCase().endsWith('.astro') && g.key !== currentFile) continue;
    let group = groups.find((x) => x.key === g.key);
    if (!group) groups.push((group = { ...g, items: [] }));
    group.items.push(c);
  }
  // The file being edited comes first and says so — its own frontmatter data
  // is the content you're most likely here for.
  for (const g of groups) {
    g.current = !!currentFile && g.key === currentFile;
    g.badge = g.current ? (g.key.startsWith('pages/') ? 'this page' : 'open') : null;
  }
  groups.sort((a, b) => (a.current === b.current ? 0 : a.current ? -1 : 1));

  // Reopening the panel with a collection already open lands inside its
  // group rather than back at the top.
  useEffect(() => {
    if (!selectedRel || openKey !== null) return;
    const c = collections.find((x) => x.rel === selectedRel);
    if (c) setOpenKey(groupOf(c).key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRel, files]);

  const open = openKey === null ? null : groups.find((g) => g.key === openKey);

  const create = async (name) => {
    setCreating(false);
    if (!name.trim()) return;
    const res = await act(() => window.avb.createCms({ projectPath: project.path, name }));
    await refresh(); // don't wait on the watcher to show what we just made
    if (res?.rel) {
      // Show it where it landed, not wherever we happened to be.
      setOpenKey(groupOf({ rel: res.rel, dir: res.rel.split('/').slice(0, -1).join('/') }).key);
      onSelect(res.rel);
    }
  };

  return (
    <div className="panel-section grow">
      <div className="panel-header">
        <div className="cms-crumb">
          {open && (
            <button
              className="ghost"
              title="All collections"
              onClick={() => {
                setOpenKey(null);
                // Backing out of a group means nothing is being edited — drop
                // the collection too, so the panels don't keep showing the
                // last one as if it were still open.
                onSelect(null);
              }}
            >
              <ChevronLeftIcon size={14} />
            </button>
          )}
          <h2 title={open ? open.path : undefined}>{open ? open.label : 'CMS Collections'}</h2>
        </div>
        <button className="ghost" title="New collection" onClick={() => setCreating(true)}>
          <PlusIcon size={14} />
        </button>
      </div>

      <div className="panel-body">
        {creating && (
          <div className="cms-collection">
            <CmsIcon size={14} />
            <input
              autoFocus
              placeholder="Collection name"
              onBlur={(e) => create(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') {
                  e.currentTarget.value = '';
                  e.currentTarget.blur();
                }
              }}
            />
          </div>
        )}

        {!open &&
          groups.map((group) => (
            <div
              key={group.key}
              className="cms-collection"
              onClick={() => setOpenKey(group.key)}
              title={group.path}
            >
              {/* Every group is a container you open, whether it's a folder of JSON
                  collections or a source file holding several — one glyph for both. */}
              <FolderDefaultIcon size={14} />
              <span className="cms-collection-name">{group.label}</span>
              {group.badge && <span className="badge">{group.badge}</span>}
              <span className="cms-collection-count">
                {group.items.length === 1 ? '1 collection' : `${group.items.length} collections`}
              </span>
              <span className="cms-collection-chevron">
                <ChevronRightIcon size={10} />
              </span>
            </div>
          ))}

        {open &&
          open.items.map((c) => (
            <div
              key={c.rel}
              className={`cms-collection ${selectedRel === c.rel ? 'on' : ''} ${c.error ? 'broken' : ''}`}
              onClick={() => onSelect(c.rel)}
              title={c.error ? `src/${c.rel} — ${c.error}` : `src/${c.rel}`}
            >
              <CmsIcon size={14} />
              <span className="cms-collection-name">{c.label}</span>
              <span className="cms-collection-count">
                {c.error
                  ? 'unreadable'
                  : c.single || c.items.length === 1
                    ? '1 item'
                    : `${c.items.length} items`}
              </span>
              <button
                className="ghost row-action"
                title="Collection settings"
                onClick={(e) => {
                  e.stopPropagation();
                  if (!c.error) onOpenSettings(c.rel);
                }}
                disabled={!!c.error}
              >
                <GearIcon size={13} />
              </button>
              <span className="cms-collection-chevron">
                <ChevronRightIcon size={10} />
              </span>
            </div>
          ))}

        {collections.length === 0 && !creating && (
          <div className="props-empty">
            No content found in <code>src/</code>.
            <div style={{ marginTop: 10 }}>
              <button className="primary" onClick={() => setCreating(true)}>
                New collection
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
