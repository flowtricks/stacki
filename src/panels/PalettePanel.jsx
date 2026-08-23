import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CloseIcon, ComponentPlusIcon, ElementComponentIcon, FileIcon, LayoutIcon } from '../ui/Icons.jsx';
import { rankInsertItems } from '../insertRank.js';
import { setDrag, clearDrag } from '../dragState.js';
import { componentNameError, toComponentName } from '../componentName.js';
import useDismiss from '../ui/useDismiss.js';

// How long the pointer rests on the create button before its tooltip appears —
// the same wait the icon rail and the navigator's header use.
const TOOLTIP_DELAY = 500;

// PascalCase → spaced display name (ButtonArrow → Button Arrow).
const prettyName = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2');

export default function PalettePanel({
  components,
  devUrl,
  onInsert,
  onDragBegin,
  onCreateComponent,
  // Where a component is used: `onUsage(comp)` answers with the files holding
  // instances, `onOpenUsage` opens one, and `pageInstances` lists the ones in
  // the file that's already open.
  onUsage,
  onOpenUsage,
  pageInstances,
  onSelectInstance,
  // What making a component would take: the selected element's suggested name,
  // or why there's nothing to make one from.
  createFrom,
  // Bumped by ⌘⇧A — the same press that brings this panel up asks for the name.
  createRequest = 0,
}) {
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  // The create button's tooltip, once the pointer has rested on it.
  const [tip, setTip] = useState(null); // {left, top}
  const tipTimer = useRef(null);
  useEffect(() => () => clearTimeout(tipTimer.current), []);
  const showTipSoon = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    clearTimeout(tipTimer.current);
    tipTimer.current = setTimeout(
      () => setTip({ left: rect.left + rect.width / 2, top: rect.bottom + 8 }),
      TOOLTIP_DELAY
    );
  };
  const hideTip = () => {
    clearTimeout(tipTimer.current);
    setTip(null);
  };

  // The open instances popup: which component, where to draw it, and what the
  // scan came back with (null while it is still running).
  const [usage, setUsage] = useState(null); // {name, left, top, files|null}
  const usageRef = useRef(null);
  useDismiss(usageRef, !!usage, () => setUsage(null));
  const openUsage = async (comp, anchor) => {
    cancelPreview();
    const rect = anchor.getBoundingClientRect();
    // The row it belongs to, not a position — where the popup goes depends on
    // how tall it turns out to be, which only it can measure.
    setUsage({
      name: comp.name,
      anchor: { left: rect.left, top: rect.top, bottom: rect.bottom },
      files: null,
    });
    const found = await onUsage?.(comp);
    setUsage((u) =>
      u && u.name === comp.name ? { ...u, files: found?.files || [], error: found?.error || null } : u
    );
  };

  const canCreate = !!createFrom?.name;
  // The shortcut arrives as a bumped number rather than a flag, so pressing it
  // again after cancelling opens the dialog again.
  const firstRequest = useRef(createRequest);
  useEffect(() => {
    if (createRequest === firstRequest.current) return;
    firstRequest.current = createRequest;
    if (canCreate) setCreating(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createRequest]);
  const [preview, setPreview] = useState(null); // {name, left, top}
  const hoverTimer = useRef(null);
  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  // The same rule the insert palette searches by (src/insertRank.js): words,
  // each landing on a name or on a folder, so `form input` is the Input in the
  // Form folder and a folder inside a folder can be typed a segment at a time.
  // The order it comes back in is not used — the panel groups by folder, and
  // that is what it is for — but which items answer is the same question in
  // both places, and it should not have two answers.
  const list = rankInsertItems(components, query);

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
  }, [components, query]);

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
        {/* The hover lives on the wrapper, not the button: a disabled button
            fires no pointer events, and a button that looks dead is exactly
            when someone needs to be told why. */}
        <span className="tip-anchor" onMouseEnter={showTipSoon} onMouseLeave={hideTip}>
          <button
            className="ghost"
            aria-label="New component"
            disabled={!canCreate}
            onClick={() => { hideTip(); setCreating(true) }}
          >
            <ComponentPlusIcon size={14} />
          </button>
        </span>
      </div>
      {/* Not the browser's own tooltip: that one takes a second to appear, in a
          font and a colour from outside the app, and can't say a shortcut in the
          same breath as what the button does. */}
      {tip && (
        <div className="rail-tooltip below" style={{ left: tip.left, top: tip.top }}>
          {canCreate ? 'New component (⌘⇧A)' : createFrom?.reason || 'New component'}
        </div>
      )}

      <div style={{ padding: '0 12px 8px' }}>
        <input
          value={query}
          placeholder="Search components"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="panel-body" onMouseLeave={cancelPreview}>
        {groups.map(([folder, items]) => (
          <React.Fragment key={folder || '__root'}>
            {folder && <div className="palette-folder">{folder}</div>}
            {items.map((comp) => (
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
                  {/* The count is the answer to half a question — 23 instances
                      WHERE — so it opens the other half. */}
                  <button
                    type="button"
                    className="palette-instances"
                    disabled={!comp.instances}
                    onClick={(e) => { e.stopPropagation(); openUsage(comp, e.currentTarget) }}
                    onMouseDown={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onDragStart={(e) => e.preventDefault()}
                  >
                    {comp.instances} instance{comp.instances === 1 ? '' : 's'}
                  </button>
                </div>
              )}
            </span>
          </div>
            ))}
          </React.Fragment>
        ))}
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

      {creating && (
        <CreateComponentModal
          suggested={createFrom?.name || ''}
          taken={components.map((c) => c.name)}
          from={createFrom?.label || 'the selection'}
          onClose={() => setCreating(false)}
          props={createFrom?.props || []}
          onCreate={(name, options) => {
            setCreating(false);
            onCreateComponent(name, options);
          }}
        />
      )}

      {usage && (
        <InstancesPopup
          ref={usageRef}
          name={usage.name}
          anchor={usage.anchor}
          files={usage.files}
          error={usage.error}
          here={pageInstances ? pageInstances(usage.name) : []}
          onClose={() => setUsage(null)}
          onOpen={(entry) => { setUsage(null); onOpenUsage?.(entry) }}
          onSelect={(id) => { setUsage(null); onSelectInstance?.(id) }}
        />
      )}

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

// Naming the component being made. What's typed is not what's saved — a name
// is a filename, an import and a tag all at once — so the field shows the name
// it will actually be given as you type, and won't create one that collides
// with a component already in the project.
function CreateComponentModal({ suggested, taken, from, props = [], onClose, onCreate }) {
  const [text, setText] = useState(suggested);
  const [withProps, setWithProps] = useState(true);
  const inputRef = useRef(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const name = toComponentName(text);
  const error = componentNameError(text, taken);
  // Only once there's something to say about: an empty field on the way to a
  // name isn't a mistake yet.
  const shown = text.trim() ? error : null;
  const submit = () => { if (!error) onCreate(name, { withProps }); };

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">Create component</div>
        <div className="modal-body">
          <div>
            <label>Name</label>
            <input
              ref={inputRef}
              value={text}
              spellCheck={false}
              placeholder="Card"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
                else if (e.key === 'Escape') onClose();
              }}
            />
            {shown ? (
              <div className="error-text">{shown}</div>
            ) : (
              <div className="hint-text">
                {from} becomes <code>&lt;{name || 'Name'} /&gt;</code>, saved as{' '}
                <code>src/components/{name || 'Name'}.astro</code>
              </div>
            )}
          </div>
          {/* What the markup reads from the page it's leaving. Moved as-is it
              would name values that aren't there any more; taken as props, the
              component keeps working and the instance passes them straight
              back in under the same names. */}
          {props.length > 0 && (
            <label className="check-row">
              <input
                type="checkbox"
                checked={withProps}
                onChange={(e) => setWithProps(e.target.checked)}
              />
              <span>
                Take {props.length === 1 ? 'this page value' : `these ${props.length} page values`} as
                props: {props.map((p) => <code key={p}>{p}</code>).reduce((all, one, i) => (i ? [...all, ', ', one] : [one]), [])}
              </span>
            </label>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!!error} onClick={submit}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

// Which pages and components hold instances of one component, and a way into
// each of them. The instances on the file already open come first and are
// individually selectable — those are the ones a click can actually take you
// to. Everything else is a file to open, with how many it holds.
const InstancesPopup = React.forwardRef(function InstancesPopup(
  { name, anchor, files, error, here, onClose, onOpen, onSelect },
  ref
) {
  const elsewhere = files || [];
  // Placed against the row that opened it, measured rather than guessed: the
  // palette is a tall scrolling list, and a popup for a row near the bottom
  // used to be pushed up the screen by a fixed amount until it had nothing to
  // do with the thing that was clicked. Below the row when it fits, above it
  // when it doesn't, and only then clamped to the window.
  const boxRef = useRef(null);
  const [place, setPlace] = useState(null);
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el || !anchor) return;
    const margin = 8;
    const h = el.offsetHeight;
    const w = el.offsetWidth;
    // A window that reports no size can't be fitted into: keep the popup on its
    // row rather than clamping it to a corner of a viewport that isn't there.
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const below = anchor.bottom + 6;
    const top =
      !vh || below + h <= vh - margin
        ? below
        : Math.max(margin, Math.min(anchor.top - 6 - h, vh - margin - h));
    const left = vw ? Math.max(margin, Math.min(anchor.left, vw - margin - w)) : anchor.left;
    setPlace((p) => (p && p.top === top && p.left === left ? p : { top, left }));
    // Re-measured when the list lands: what fits below changes with it.
  }, [anchor, files, here.length, error]);

  return (
    <div
      className="instances-popup"
      style={{ left: place ? place.left : anchor.left, top: place ? place.top : anchor.bottom + 6 }}
      ref={(node) => {
        boxRef.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
      }}
    >
      <div className="instances-head">
        <span>{prettyName(name)} instances</span>
        <button className="ghost" aria-label="Close" onClick={onClose}>
          <CloseIcon size={12} />
        </button>
      </div>

      {here.length > 0 && (
        <div className="instances-group">
          <div className="instances-label">On this page</div>
          {here.map((inst, i) => (
            <button
              key={inst.id}
              type="button"
              className="instances-row"
              onClick={() => onSelect(inst.id)}
            >
              <span className="icon"><ElementComponentIcon size={13} /></span>
              <span className="instances-name">{prettyName(name)}{here.length > 1 ? ` ${i + 1}` : ''}</span>
            </button>
          ))}
        </div>
      )}

      <div className="instances-group">
        <div className="instances-label">
          {here.length > 0 ? 'Other files with instances' : 'Used in'}
        </div>
        {error ? (
          // Not the same sentence as "nowhere": one of them is a fact about the
          // project and the other is a fact about this app failing to look.
          <div className="instances-empty is-error">Couldn’t read the project — {error}</div>
        ) : files === null ? (
          <div className="instances-empty">Looking…</div>
        ) : elsewhere.length === 0 ? (
          <div className="instances-empty">
            {here.length > 0 ? 'Nowhere else.' : 'Not used anywhere yet.'}
          </div>
        ) : (
          elsewhere.map((f) => (
            <button
              key={f.rel}
              type="button"
              className={`instances-row ${f.kind === 'page' ? 'is-page' : ''}`}
              title={f.rel}
              onClick={() => onOpen(f)}
            >
              <span className="icon">
                {f.kind === 'page' ? <FileIcon size={13} /> : f.kind === 'layout' ? <LayoutIcon size={13} /> : <ElementComponentIcon size={13} />}
              </span>
              <span className="instances-name">{fileLabel(f)}</span>
              <span className="instances-count">{f.count}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
});

// `src/pages/blog/post.astro` reads as "blog/post"; a component or layout is
// known by its name, spaced the way the list above spells it.
function fileLabel(f) {
  const base = f.rel.replace(/^src\//, '').replace(/\.astro$/, '');
  if (f.kind === 'page') return base.replace(/^pages\//, '');
  return prettyName(base.split('/').pop());
}
