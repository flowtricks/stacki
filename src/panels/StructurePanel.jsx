import React, { useEffect, useRef, useState } from 'react';
import { canContainTag } from '../elementSchemas.js';
import { isDataBound } from '../bindings.js';
import { setDrag, clearDrag, getDrag } from '../dragState.js';
import { elementLabel } from '../classNames.js';
import { isContentOnlyChild, noteText } from '../treeSelection.js';
import { soleThen, rowChildren, rowHost } from '../branches.js';
import {
  LayoutIcon,
  ElementComponentIcon,
  astroAssetIcon,
  TextIcon,
  CommentIcon,
  CodeIcon,
  ChevronRightIcon,
  HideIcon,
  ChevronDownIcon,
  DragIcon,
  FileIcon,
  RepeatIcon,
  BranchIcon,
  CornerIcon,
  ExpandVerticalIcon,
  CollapseVerticalIcon,
  elementIcon,
  CustomElementIcon,
} from '../ui/Icons.jsx';


// The page structure tree: layout wrapper + nested nodes (components,
// elements, text, comments). Supports:
//  - dropping palette items (avb/component) on gaps (sibling insert) or
//    directly on a node row (append as child)
//  - reordering/reparenting existing nodes (avb/node) the same way
//  - collapse/expand for nodes with children
export default function StructurePanel({
  pageState,
  currentPage,
  layouts,
  currentLayoutName,
  selectedId,
  emptyNodeIds,
  liveClassesById,
  revealTick,
  onSelect,
  onHoverNode,
  onOpenComponent,
  onChangeLayout,
  onDropComponent,
  onMoveNode,
  onRemoveNode,
  onCopyNode,
  onDuplicateNode,
  onPasteNode,
  onCreateComponent,
  onUnlinkComponent,
  hasClipboard,
  onRawChange,
}) {
  // dropTarget: {parentId, index} for gaps, {intoId} for node rows
  const [dropTarget, setDropTarget] = useState(null);
  // Manual expand/collapse overrides by node id; nodes not in the map use
  // their default (text-only children start collapsed).
  const [toggled, setToggled] = useState(() => new Map());
  const [ctxMenu, setCtxMenu] = useState(null); // {x, y, nodeId}
  // Expand-all / collapse-all toggle in the header, with a delayed tooltip.
  const [allExpanded, setAllExpanded] = useState(false);
  const [headerTip, setHeaderTip] = useState(null); // {left, top}
  const tipTimer = useRef(null);
  useEffect(() => () => clearTimeout(tipTimer.current), []);

  const showTipSoon = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    clearTimeout(tipTimer.current);
    tipTimer.current = setTimeout(
      () => setHeaderTip({ left: rect.left + rect.width / 2, top: rect.bottom + 8 }),
      500
    );
  };
  const hideTip = () => {
    clearTimeout(tipTimer.current);
    setHeaderTip(null);
  };

  // Arrow-key navigation from the selected node: ←/→ between siblings,
  // ↑ to the parent, ↓ to the first child (expanding a collapsed node so
  // the child is visible).
  useEffect(() => {
    if (!pageState?.editable || !selectedId) return;
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
      ) {
        return;
      }
      const found = findWithParent(pageState.model.nodes, selectedId, null);
      if (!found) return;
      e.preventDefault(); // keep arrows from scrolling the panel
      const { node, parent, siblings, index } = found;
      let next = null;
      if (e.key === 'ArrowLeft') next = siblings[index - 1];
      else if (e.key === 'ArrowRight') next = siblings[index + 1];
      else if (e.key === 'ArrowUp') next = parent;
      else if (
        e.key === 'ArrowDown' &&
        rowChildren(node).length > 0 &&
        // Content-only children aren't shown in the navigator — don't
        // descend into rows that don't exist.
        !rowChildren(node).every(isContentOnlyChild)
      ) {
        const collapsed = toggled.has(node.id) ? toggled.get(node.id) : defaultCollapsed(node);
        if (collapsed) setToggled((prev) => new Map(prev).set(node.id, false));
        next = rowChildren(node)[0];
      }
      if (next) onSelect(next.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pageState, selectedId, toggled, onSelect]);

  // Reveal the selection: with everything collapsed by default, selecting a
  // node from the canvas or breadcrumbs must expand its ancestors.
  useEffect(() => {
    if (!pageState?.editable || !selectedId || selectedId === 'frontmatter') return;
    const chain = [];
    const walk = (list, trail) => {
      for (const n of list) {
        if (n.id === selectedId) {
          chain.push(...trail);
          return true;
        }
        if (walk(rowChildren(n), [...trail, n])) return true;
      }
      return false;
    };
    walk(pageState.model.nodes, []);
    if (!chain.length) return;
    setToggled((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const a of chain) {
        const collapsed = next.has(a.id) ? next.get(a.id) : defaultCollapsed(a);
        if (collapsed) {
          next.set(a.id, false);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [pageState, selectedId]);

  // Clicking an element on the page scrolls its row into view here — with no
  // animation, and only when the row is off screen, so selecting something
  // already visible leaves the list where it is. Waits a frame: the effect
  // above may still need to expand the ancestors that mount the row.
  const bodyRef = useRef(null);
  const lastReveal = useRef(revealTick);
  useEffect(() => {
    if (revealTick === lastReveal.current) return; // a plain selection change
    lastReveal.current = revealTick;
    if (!selectedId) return;
    const frame = requestAnimationFrame(() => {
      const body = bodyRef.current;
      const row = body?.querySelector(`[data-node-id="${CSS.escape(selectedId)}"]`);
      if (!row) return;
      const b = body.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      if (r.top >= b.top && r.bottom <= b.bottom) return;
      body.scrollTop += r.top - b.top - (b.height - r.height) / 2;
    });
    return () => cancelAnimationFrame(frame);
  }, [revealTick, selectedId]);

  if (!pageState) {
    // A route with no file in this project: an integration injected it, and its
    // source lives in a dependency. It previews, and that is all — saying so
    // beats an empty panel that reads as something being broken.
    const injected = currentPage?.kind === 'route';
    return (
      <div className="panel-section grow">
        <div className="panel-header">
          <h2>Navigator</h2>
        </div>
        <div className="props-empty">
          {injected ? (
            <>
              <strong>{currentPage.route}</strong> comes from{' '}
              {currentPage.from ? <code>{currentPage.from}</code> : 'an integration'}, not from this
              project — it can be previewed here, but its markup lives in a dependency and isn’t
              editable.
            </>
          ) : (
            'Select a page to edit.'
          )}
        </div>
      </div>
    );
  }

  if (!pageState.editable) {
    return (
      <div className="panel-section grow">
        <div className="panel-header">
          <h2>Code</h2>
        </div>
        <div className="code-editor">
          <div className="code-note">
            {pageState.reason || 'This page cannot be edited visually.'} You can still edit
            the source here — the preview updates live.
          </div>
          <textarea
            spellCheck={false}
            value={pageState.source}
            onChange={(e) => onRawChange(e.target.value)}
          />
        </div>
      </div>
    );
  }

  const { model } = pageState;

  const clearDrop = () => setDropTarget(null);

  const isDndPayload = (e) =>
    e.dataTransfer.types.includes('avb/component') || e.dataTransfer.types.includes('avb/node');

  const performDrop = (e, target) => {
    e.preventDefault();
    e.stopPropagation();
    clearDrop();
    const compName = e.dataTransfer.getData('avb/component');
    const nodeId = e.dataTransfer.getData('avb/node');
    if (compName) onDropComponent(compName, target);
    else if (nodeId) onMoveNode(nodeId, target);
  };

  const isCollapsed = (node) =>
    toggled.has(node.id) ? toggled.get(node.id) : defaultCollapsed(node);

  const toggleCollapse = (node) =>
    setToggled((prev) => new Map(prev).set(node.id, !isCollapsed(node)));

  // Alternates between expanding and collapsing every node with children.
  const toggleAll = () => {
    const collapsed = allExpanded;
    const map = new Map();
    const walk = (list) =>
      list.forEach((n) => {
        if (rowChildren(n).length > 0) {
          map.set(n.id, collapsed);
          walk(rowChildren(n));
        }
      });
    walk(model.nodes);
    setToggled(map);
    setAllExpanded(!allExpanded);
  };

  return (
    <div className="panel-section grow">
      <div className="panel-header">
        <h2>Navigator</h2>
        <button
          className="ghost"
          onMouseEnter={showTipSoon}
          onMouseLeave={hideTip}
          onClick={() => {
            hideTip();
            toggleAll();
          }}
        >
          {allExpanded ? <CollapseVerticalIcon size={14} /> : <ExpandVerticalIcon size={14} />}
        </button>
      </div>
      {headerTip && (
        <div className="rail-tooltip below" style={{ left: headerTip.left, top: headerTip.top }}>
          {allExpanded ? 'Collapse all' : 'Expand all'}
        </div>
      )}

      <div className="panel-body" ref={bodyRef} onDragLeave={clearDrop}>
        <div
          className={`structure-node frontmatter-node ${selectedId === 'frontmatter' ? 'selected' : ''}`}
          style={{ paddingLeft: 6 }}
          onClick={() => onSelect('frontmatter')}
        >
          <span className="drag-handle" style={{ visibility: 'hidden' }}>
            <DragIcon size={11} />
          </span>
          <span className="icon">
            <CodeIcon size={12} />
          </span>
          <span className="label">Frontmatter</span>
          <span className="prop-preview">
            {(model.imports || []).length} import{(model.imports || []).length === 1 ? '' : 's'}
          </span>
        </div>

        <NodeList
          nodes={model.nodes}
          parentId={null}
          depth={0}
          selectedId={selectedId}
          emptyNodeIds={emptyNodeIds}
          liveClassesById={liveClassesById}
          currentLayoutName={currentLayoutName}
          onChangeLayout={onChangeLayout}
          onHoverNode={onHoverNode}
          onOpenComponent={onOpenComponent}
          isCollapsed={isCollapsed}
          dropTarget={dropTarget}
          setDropTarget={setDropTarget}
          isDndPayload={isDndPayload}
          performDrop={performDrop}
          nodeById={(id) => findNodeIn(model.nodes, id)}
          onSelect={onSelect}
          onRemoveNode={onRemoveNode}
          toggleCollapse={toggleCollapse}
          openContextMenu={(x, y, nodeId) => {
            onSelect(nodeId);
            setCtxMenu({ x, y, nodeId });
          }}
        />

        {model.nodes.length === 0 && (
          <div
            className={`drop-zone-empty ${dropTarget?.parentId === null && dropTarget?.index === 0 ? 'over' : ''}`}
            onDragOver={(e) => {
              if (isDndPayload(e)) {
                e.preventDefault();
                setDropTarget({ parentId: null, index: 0 });
              }
            }}
            onDrop={(e) => performDrop(e, { parentId: null, index: 0 })}
          >
            Drag components here
          </div>
        )}
      </div>

      {ctxMenu && (
        <ContextMenu
          pos={ctxMenu}
          canPaste={hasClipboard ? hasClipboard() : false}
          canUnlink={isUnlinkable(findNodeIn(model.nodes, ctxMenu.nodeId))}
          onClose={() => setCtxMenu(null)}
          onAction={(action) => {
            setCtxMenu(null);
            if (action === 'copy') onCopyNode(ctxMenu.nodeId);
            else if (action === 'duplicate') onDuplicateNode(ctxMenu.nodeId);
            else if (action === 'paste') onPasteNode();
            else if (action === 'component') onCreateComponent?.(ctxMenu.nodeId);
            else if (action === 'unlink') onUnlinkComponent?.(ctxMenu.nodeId);
            else if (action === 'delete') onRemoveNode(ctxMenu.nodeId);
          }}
        />
      )}
    </div>
  );
}

// Right-click menu for navigator nodes.
function ContextMenu({ pos, canPaste, canUnlink, onClose, onAction }) {
  const ref = useRef(null);

  useEffect(() => {
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    const onScroll = (e) => {
      if (ref.current && ref.current.contains(e.target)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  // Keep the menu on-screen. Measured against the stylesheet rather than
  // guessed: a row is 27px, a divider 11px with its margins, and the menu
  // itself 12px of padding and border. The count has to follow the items —
  // it was fixed at four, and the item that falls off the bottom is Delete.
  const width = 216;
  const rows = 5 + (canUnlink ? 1 : 0); // copy, paste, duplicate, create, delete
  const height = rows * 27 + 2 * 11 + 12;
  const left = Math.min(pos.x, window.innerWidth - width - 8);
  const top = Math.min(pos.y, window.innerHeight - height - 8);

  const Item = ({ action, label, shortcut, disabled }) => (
    <div
      className={`ctx-menu-item ${disabled ? 'disabled' : ''}`}
      onClick={() => !disabled && onAction(action)}
    >
      <span>{label}</span>
      {shortcut && <span className="ctx-shortcut">{shortcut}</span>}
    </div>
  );

  return (
    <div ref={ref} className="ctx-menu" style={{ left, top, width }}>
      <Item action="copy" label="Copy" shortcut="⌘C" />
      <Item action="paste" label="Paste" shortcut="⌘V" disabled={!canPaste} />
      <Item action="duplicate" label="Duplicate" shortcut="⌘D" />
      <div className="ctx-divider" />
      {/* Its own group: copy, paste and duplicate all leave the page as it is,
          and these two move a piece of it between the page and a file.
          Only ever one of them at a time — they share a key, and an instance
          that offered both would be advertising ⇧⌘A for something the key does
          not do. Making a component of a component would only wrap it. */}
      <Item action="component" label="Create Component…" shortcut="⇧⌘A" disabled={canUnlink} />
      {canUnlink && <Item action="unlink" label="Unlink Component" shortcut="⇧⌘A" />}
      <div className="ctx-divider" />
      <Item action="delete" label="Delete" shortcut="⌫" />
    </div>
  );
}

// Kinds a comment can be a note *for* — the ones that read as a thing on the
// page. A comment above another comment (or above text) keeps its own row.
const ANNOTATABLE = new Set(['element', 'component']);

function NodeList({ nodes, parentId, depth, ...ctx }) {
  // A comment directly above an element belongs to it: the element's row reads
  // "name / comment" and the comment gets no row of its own. Ten identical
  // <Section> rows are otherwise indistinguishable, and the note above each is
  // the only thing telling them apart.
  const noteFor = new Map(); // index of the annotated node -> comment node
  const folded = new Set(); // indices that render as part of the row below
  nodes.forEach((n, i) => {
    if (n.kind !== 'comment') return;
    const next = nodes[i + 1];
    if (next && ANNOTATABLE.has(next.kind)) {
      noteFor.set(i + 1, n);
      folded.add(i);
    }
  });

  return (
    <>
      {nodes.map((node, i) =>
        folded.has(i) ? null : (
          <React.Fragment key={node.id}>
            {/* Insert above the note, not between it and its element — the two
                read as one row, so a drop "above" has to clear both. */}
            <Gap
              parentId={parentId}
              index={noteFor.has(i) ? i - 1 : i}
              depth={depth}
              {...ctx}
            />
            <TreeNode
              node={node}
              note={noteFor.get(i) || null}
              parentId={parentId}
              index={i}
              depth={depth}
              {...ctx}
            />
          </React.Fragment>
        )
      )}
      {nodes.length > 0 && <Gap parentId={parentId} index={nodes.length} depth={depth} {...ctx} />}
    </>
  );
}

// Only a real component instance can be detached: a dynamic tag has no file
// behind it, and one of Astro's own belongs to Astro rather than this project.
function isUnlinkable(node) {
  return !!node && node.kind === 'component' && !node.dynamicTag && !node.astroAsset;
}

function findNodeIn(nodes, id) {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (Array.isArray(n.children)) {
      const found = findNodeIn(n.children, id);
      if (found) return found;
    }
  }
  return null;
}

// Whether the node currently being dragged may legally live inside `parent`
// (null = page root). Components are opaque — their rendered markup is
// unknown, so they're never blocked.
function acceptsDrag(parent) {
  const d = getDrag();
  if (!d || !d.tag || d.nodeKind !== 'element') return true;
  if (!parent || parent.kind !== 'element') return true;
  return canContainTag(parent.name, d.tag);
}

function Gap({ parentId, index, depth, dropTarget, setDropTarget, isDndPayload, performDrop, nodeById }) {
  const active =
    dropTarget && dropTarget.parentId === parentId && dropTarget.index === index && !dropTarget.intoId;
  const ok = acceptsDrag(parentId ? nodeById(parentId) : null);
  return (
    <div
      className="nav-gap"
      style={{ marginLeft: depth * 16 }}
      onDragOver={(e) => {
        if (ok && isDndPayload(e)) {
          e.preventDefault();
          e.stopPropagation();
          setDropTarget({ parentId, index });
        }
      }}
      onDrop={(e) => ok && performDrop(e, { parentId, index })}
    >
      {active && <div className="drop-indicator" />}
    </div>
  );
}

function TreeNode({ node, note, parentId, index, depth, ...ctx }) {
  const {
    selectedId,
    currentLayoutName,
    isCollapsed,
    dropTarget,
    setDropTarget,
    isDndPayload,
    performDrop,
    onSelect,
    onHoverNode,
    onOpenComponent,
    toggleCollapse,
    openContextMenu,
  } = ctx;

  const isLayoutNode = node.id === 'layout';
  const isSelected = selectedId === node.id;

  // Keep the selected row visible while navigating with the arrow keys.
  const rowRef = useRef(null);
  useEffect(() => {
    if (isSelected) rowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [isSelected]);

  // Reported by the page: this node's markers wrap nothing.
  const rendersNothing = !!ctx.emptyNodeIds?.has(node.id);
  // An `if` with no `else` shows what is inside it directly — see branches.js.
  // `host` is the node those children really belong to, which is what a drop
  // has to name.
  const kids = rowChildren(node);
  const host = rowHost(node);
  const hasChildren = kids.length > 0;
  // Pure text (plus simple {expr} interpolations) is edited via the Content
  // field — showing those as rows is noise until real tags are involved.
  const showChildren = hasChildren && !kids.every(isContentOnlyChild);
  const canHostChildren =
    node.kind === 'component' ||
    node.kind === 'element' ||
    node.kind === 'chunk-group' ||
    node.kind === 'map' ||
    // A condition holds nothing directly; each of its branches does — unless
    // the only branch is a then, whose row the `if` is standing in for.
    node.kind === 'branch' ||
    !!soleThen(node);
  const nodeCollapsed = isCollapsed(node);
  const isDropInto = dropTarget?.intoId === node.id;

  let { icon, label } = describeNode(node, ctx.liveClassesById?.get(node.id));
  // The layout wrapper is the one node whose row named something the markup
  // doesn't: a page that does `import Layout from '…/BaseLayout.astro'` writes
  // `<Layout>`, and showing "BaseLayout" made the tree disagree with the file.
  // The name it was imported under leads, like every other row; the layout it
  // resolves to rides along on the right, since that's the part worth knowing.
  let hint = null;
  if (isLayoutNode) {
    icon = <LayoutIcon size={13} />;
    label = node.name || currentLayoutName;
    if (currentLayoutName && currentLayoutName !== label) hint = currentLayoutName;
  }

  return (
    <>
      <div
        ref={rowRef}
        data-node-id={node.id}
        className={`structure-node ${node.kind === 'component' && !node.dynamicTag ? 'is-component' : ''} ${node.kind === 'map' || node.kind === 'cond' || node.kind === 'branch' || (isDataBound(node) && !(node.kind === 'component' && !node.dynamicTag)) ? 'is-map' : ''} ${isLayoutNode ? 'layout-node' : ''} ${isSelected ? 'selected' : ''}`}
        style={{
          paddingLeft: 6 + depth * 16,
          ...(isDropInto ? { borderColor: 'var(--accent)', background: 'var(--accent-soft)' } : {}),
        }}
        // A branch is part of its condition's shape, not a node you can move
        // or drop somewhere else.
        draggable={node.kind !== 'chunk-group' && node.kind !== 'branch'}
        onDragStart={(e) => {
          e.stopPropagation();
          e.dataTransfer.setData('avb/node', node.id);
          e.dataTransfer.effectAllowed = 'move';
          setDrag({ kind: 'node', id: node.id, nodeKind: node.kind, tag: node.name });
        }}
        onDragEnd={clearDrag}
        onDragOver={(e) => {
          if (canHostChildren && acceptsDrag(node) && isDndPayload(e)) {
            e.preventDefault();
            e.stopPropagation();
            setDropTarget({ intoId: node.id });
          }
        }}
        onDrop={(e) => {
          if (canHostChildren && acceptsDrag(node)) {
            performDrop(e, { parentId: host.id, index: kids.length });
          }
        }}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(node.id);
        }}
        onDoubleClick={(e) => {
          // Drill into a component's own file, the way Webflow opens one.
          // astro:assets components live in Astro, not the project — there is
          // no file to open, so a double-click does nothing rather than
          // hunting for one that can't be found.
          if (node.kind !== 'component' || node.dynamicTag || node.astroAsset) return;
          if (!onOpenComponent) return;
          e.stopPropagation();
          onOpenComponent(node.name, node.id);
        }}
        onMouseEnter={() => onHoverNode && onHoverNode(node.id)}
        onMouseLeave={() => onHoverNode && onHoverNode(null)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          openContextMenu(e.clientX, e.clientY, node.id);
        }}
      >
        {showChildren ? (
          <span
            className="drag-handle"
            style={{ cursor: 'pointer', opacity: 1 }}
            onClick={(e) => {
              e.stopPropagation();
              toggleCollapse(node);
            }}
          >
            {nodeCollapsed ? <ChevronRightIcon size={10} /> : <ChevronDownIcon size={10} />}
          </span>
        ) : (
          <span className="drag-handle">
            <DragIcon size={11} />
          </span>
        )}
        <span className="icon">{icon}</span>
        <span className="label" style={node.kind === 'text' ? { fontWeight: 400, fontStyle: 'italic' } : {}}>
          {label}
          {note && (
            <span className="node-note" title={note.value.trim()}>
              {' / '}
              {truncate(noteText(note.value).replace(/\s+/g, ' '), 44)}
            </span>
          )}
        </span>
        {hint && (
          <span className="prop-preview" title={`Imported from ${hint}.astro`}>
            {hint}
          </span>
        )}
        {rendersNothing && (
          <span
            className="node-empty"
            title="Renders nothing on the page with its current props"
          >
            <HideIcon size={13} />
          </span>
        )}
      </div>

      {showChildren && !nodeCollapsed && (
        <NodeList nodes={kids} parentId={host.id} depth={depth + 1} {...ctx} />
      )}
    </>
  );
}

// Locates a node plus its parent, sibling list, and index — the context the
// arrow-key navigation needs. Walked the way the tree is drawn, so ↑ from
// inside a lone then reaches the `if` the reader can see rather than the
// branch row standing behind it.
function findWithParent(nodes, id, parent) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.id === id) return { node: n, parent, siblings: nodes, index: i };
    const found = findWithParent(rowChildren(n), id, n);
    if (found) return found;
  }
  return null;
}

// Components/elements whose children are all text (or comments) start
// collapsed — their text is editable via the Content field in the props panel.
// Everything starts collapsed; expanding is always an explicit action
// (chevron, expand-all, arrow-down navigation, or selection reveal).
function defaultCollapsed(node) {
  return rowChildren(node).length > 0;
}

// The row's icon already says what kind a node is, so no trailing kind badge
// ("comment", "loop", …) — it only repeated the icon in words.
function describeNode(node, live) {
  switch (node.kind) {
    case 'text':
      return { icon: <TextIcon size={12} />, label: truncate(node.value, 34) };
    case 'comment':
      return { icon: <CommentIcon size={12} />, label: truncate(node.value.trim(), 30) };
    case 'raw':
      return { icon: <CodeIcon size={12} />, label: node.name };
    case 'raw-line':
      return { icon: <CodeIcon size={12} />, label: truncate(node.value, 30) };
    case 'element': {
      // Webflow-style label: the first class name when the element has
      // classes, the bare tag name otherwise (and a named slot's name — see
      // elementLabel). Covers `class:list={[...]}`, where the classes live in
      // an expression rather than a string.
      const fromSource = elementLabel(node);
      // A class the source can't resolve — `class:list={["button_wrap", …]}`
      // or a whole class passed in as a prop — leaves the label as the bare
      // tag. The page knows what it rendered as, so use that instead.
      const label =
        fromSource === node.name && live?.length ? live[0] : fromSource;
      return { icon: elementIcon(node.name), label: truncate(label, 40) };
    }
    case 'chunk-group':
      return { icon: <FileIcon size={12} />, label: node.name };
    case 'expr':
      return {
        icon: <CodeIcon size={12} />,
        label: truncate(node.value.replace(/\s+/g, ' '), 34),
      };
    case 'map': {
      const at = node.head.indexOf('.map');
      return {
        icon: <RepeatIcon size={12} />,
        label: at > 0 ? node.head.slice(0, at + 4) : truncate(node.head, 24),
      };
    }
    case 'cond':
      // The test is what tells one condition from another, so it's the label.
      return { icon: <BranchIcon size={12} />, label: truncate(`if ${node.test}`, 40) };
    case 'branch':
      return {
        icon: <CornerIcon size={12} />,
        label: node.name === 'else' ? 'else' : 'then',
      };
    default:
      // `<Tag>` from `const Tag = tag` is a dynamic element, not a component
      // — no file behind it, so it shouldn't wear the component's colours.
      // Its name is a variable, so it says nothing about what the row is; the
      // class it rendered with does, the same as for any other element.
      if (node.dynamicTag) {
        const named = elementLabel(node);
        return {
          icon: <CustomElementIcon size={12} />,
          label: truncate(named === node.name && live?.length ? live[0] : named, 40),
        };
      }
      // astro:assets' <Image>/<Picture> aren't the project's components —
      // there's no file to open — so they get Astro's mark, not the green cube.
      if (node.astroAsset) {
        return { icon: astroAssetIcon(node.name, 14), label: node.name };
      }
      return { icon: <ElementComponentIcon size={14} />, label: node.name };
  }
}

function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
