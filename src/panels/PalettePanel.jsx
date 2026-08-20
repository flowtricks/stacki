import React, { useEffect, useRef, useState } from 'react';
import {
  ElementComponentIcon,
  LayoutIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  ExpandVerticalIcon,
  CollapseVerticalIcon,
} from '../ui/Icons.jsx';
import { setDrag, clearDrag } from '../dragState.js';

// PascalCase → spaced display name (ButtonArrow → Button Arrow).
const prettyName = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2');

// Which folders are folded shut, remembered per project.
//
// The panel unmounts whenever another left tab is opened, so in-component state
// would forget the fold on the way to Assets and back — which is most of the
// point of folding one. Per project, because a folder called "marketing" in one
// site says nothing about another.
const FOLD_KEY = 'stacki.paletteFolds';

const readFolds = (projectPath) => {
  try {
    const all = JSON.parse(localStorage.getItem(FOLD_KEY) || '{}');
    const mine = all?.[projectPath];
    return new Set(Array.isArray(mine) ? mine.filter((f) => typeof f === 'string') : []);
  } catch {
    // A corrupt value is not a reason to fail to draw a panel.
    return new Set();
  }
};

const writeFolds = (projectPath, folds) => {
  try {
    const all = JSON.parse(localStorage.getItem(FOLD_KEY) || '{}');
    const next = { ...(all && typeof all === 'object' ? all : {}) };
    if (folds.size) next[projectPath] = [...folds];
    else delete next[projectPath];
    localStorage.setItem(FOLD_KEY, JSON.stringify(next));
  } catch {
    /* best effort — the fold is a convenience, not state worth an error */
  }
};

export default function PalettePanel({ project, components, devUrl, onInsert, onDragBegin }) {
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState(null); // {name, left, top}
  const hoverTimer = useRef(null);
  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  const projectPath = project?.path || '';
  const [folded, setFolded] = useState(() => readFolds(projectPath));
  useEffect(() => setFolded(readFolds(projectPath)), [projectPath]);

  const setFolds = (next) => {
    setFolded(next);
    if (projectPath) writeFolds(projectPath, next);
  };
  const toggleFold = (folder) => {
    const next = new Set(folded);
    if (next.has(folder)) next.delete(folder);
    else next.add(folder);
    setFolds(next);
  };

  const q = query.trim().toLowerCase();
  const list = components.filter(
    (c) => !q || c.name.toLowerCase().includes(q) || (c.folder || '').toLowerCase().includes(q)
  );

  // Grouped by the folder each file sits in, so layouts land under "layouts"
  // and component subfolders group under their own name. Anything at the
  // root of src/components has no folder and stays at the top, ungrouped.
  const groups = React.useMemo(() => {
    const byFolder = new Map();
    for (const c of list) {
      const key = c.folder || '';
      if (!byFolder.has(key)) byFolder.set(key, []);
      byFolder.get(key).push(c);
    }
    return [...byFolder.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [components, q]);

  // The root of src/components has no header to click, so it is never one of
  // these — it is the ungrouped remainder rather than a folder.
  const namedFolders = groups.map(([folder]) => folder).filter(Boolean);
  const allFolded = namedFolders.length > 0 && namedFolders.every((f) => folded.has(f));

  const schedulePreview = (comp) => (e) => {
    clearTimeout(hoverTimer.current);
    const rect = e.currentTarget.getBoundingClientRect();
    const left = rect.right + 10;
    const top = Math.max(8, Math.min(rect.top, window.innerHeight - 260));
    hoverTimer.current = setTimeout(() => setPreview({ name: comp.name, left, top }), 450);
  };

  const cancelPreview = () => {
    clearTimeout(hoverTimer.current);
    setPreview(null);
  };

  return (
    <div className="panel-section grow">
      <div className="panel-header">
        <h2>Components</h2>
        {namedFolders.length > 0 && (
          <button
            className="ghost"
            title={allFolded ? 'Expand all' : 'Collapse all'}
            onClick={() => setFolds(allFolded ? new Set() : new Set(namedFolders))}
          >
            {allFolded ? <ExpandVerticalIcon size={14} /> : <CollapseVerticalIcon size={14} />}
          </button>
        )}
      </div>

      <div style={{ padding: '0 12px 8px' }}>
        <input
          value={query}
          placeholder="Search components"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="panel-body" onMouseLeave={cancelPreview}>
        {groups.map(([folder, items]) => {
          // A search that hid its own results inside a folded folder would look
          // like it found nothing, so filtering opens everything for as long as
          // it lasts — the folds are remembered, not lost.
          const shut = !!folder && !q && folded.has(folder);
          return (
          <React.Fragment key={folder || '__root'}>
            {folder && (
              <div
                className="palette-folder"
                role="button"
                tabIndex={0}
                onClick={() => toggleFold(folder)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleFold(folder);
                  }
                }}
              >
                <span className="palette-fold-chevron">
                  {shut ? <ChevronRightIcon size={9} /> : <ChevronDownIcon size={9} />}
                </span>
                <span className="palette-folder-name">{folder}</span>
                <span className="palette-folder-count">{items.length}</span>
              </div>
            )}
            {!shut && items.map((comp) => (
          <div
            key={comp.path}
            className="palette-item"
            draggable
            title="Drag into the Navigator, or double-click to add to the page"
            onMouseEnter={schedulePreview(comp)}
            onMouseLeave={cancelPreview}
            onDragStart={(e) => {
              cancelPreview();
              e.dataTransfer.setData('avb/component', comp.name);
              e.dataTransfer.effectAllowed = 'copy';
              // Components render unknown markup, so nothing blocks them —
              // recorded anyway so stale state can't linger between drags.
              setDrag({ kind: 'component', name: comp.name });
              // Switch the left panel to the Navigator so the component can
              // be dropped into the tree. Deferred so the browser captures
              // the drag before this row unmounts.
              if (onDragBegin) setTimeout(onDragBegin, 0);
            }}
            onDragEnd={clearDrag}
            onDoubleClick={() => onInsert(comp.name)}
          >
            <span className="icon">
              {comp.isLayout ? <LayoutIcon size={14} /> : <ElementComponentIcon size={14} />}
            </span>
            <span className="label">
              {prettyName(comp.name)}
              {comp.instances != null && (
                <div className="sub">
                  {comp.instances} instance{comp.instances === 1 ? '' : 's'}
                </div>
              )}
            </span>
          </div>
            ))}
          </React.Fragment>
          );
        })}
        {list.length === 0 && (
          <div className="props-empty">
            {components.length === 0 ? (
              <>
                No components found in <code>src/components</code>.
              </>
            ) : (
              <>No components match “{query.trim()}”.</>
            )}
          </div>
        )}
      </div>

      {preview && devUrl && (
        <div className="comp-preview" style={{ left: preview.left, top: preview.top }}>
          <div className="comp-preview-title">{prettyName(preview.name)}</div>
          <iframe
            src={`${devUrl}/__avb/preview?c=${encodeURIComponent(preview.name)}`}
            title={`${preview.name} preview`}
          />
        </div>
      )}
    </div>
  );
}
