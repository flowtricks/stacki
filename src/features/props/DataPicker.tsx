import { useCodeAccess } from '../../ui/CodeAccess';
import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import type { LoopSourceInspection } from './loopSourceInspection';
import {
  ChevronRightIcon,
  ChevronLeftIcon,
  CheckIcon,
  CodeIcon,
  SearchIcon,
  PencilIcon,
} from '../../ui/Icons';

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
function ancestorsOf(path: string | undefined): string[] {
  const out: string[] = [];
  const pathText = path || '';
  assert(pathText.length <= LIMITS.attrCharsMax, 'DataPicker: binding path limit exceeded');
  let acc = '';
  for (const part of pathText.split('.')) {
    // Array steps ride along with the name they belong to: `posts[0]` is one
    // step down from `posts`, not two.
    const match = part.match(/^([^[]*)((\[\d+\])*)$/);
    acc = acc ? `${acc}.${match ? (match[1] ?? '') : part}` : match ? (match[1] ?? '') : part;
    if (acc !== pathText) {
      out.push(acc);
    }
    for (const index of (match?.[2] || '').match(/\[\d+\]/g) || []) {
      acc += index;
      if (acc !== pathText) {
        out.push(acc);
      }
    }
  }
  return out;
}

// How far a nested field steps in: enough to read as inside its parent, with
// its name starting just past the parent's chevron rather than far beyond it.
const DEPTH_INDENT_PX = 8;

function flatten(nodes: readonly PickerNode[]): PickerNode[] {
  const pending = nodes.map((node) => ({ node, depth: 0 })).reverse();
  const out: PickerNode[] = [];
  assert(pending.length <= LIMITS.treeNodesMax, 'DataPicker: node limit exceeded');
  for (let visited = 0; pending.length; visited++) {
    assert(visited < LIMITS.treeNodesMax, 'DataPicker: node limit exceeded');
    const next = pending.pop();
    assert(next !== undefined, 'DataPicker: queued node exists');
    assert(next.depth <= LIMITS.treeDepthMax, 'DataPicker: depth limit exceeded');
    out.push(next.node);
    const children = next.node.children ?? [];
    assert(
      out.length + pending.length + children.length <= LIMITS.treeNodesMax,
      'DataPicker: node limit exceeded',
    );
    for (let index = children.length - 1; index >= 0; index--) {
      const node = children[index];
      assert(node !== undefined, 'DataPicker: child exists');
      pending.push({ node, depth: next.depth + 1 });
    }
  }
  return out;
}

const SECTION_LABEL: Readonly<Record<string, string>> = {
  collections: 'Collections in this project',
};

// A field can be bound to something this entry doesn't have — an optional
// field left unset, or data the app can't see the shape of. The path is still
// what the chip says, so it is shown where it belongs and marked, rather than
// leaving the picker looking like it doesn't know what the chip points at.
function withCurrent(tree: readonly PickerNode[], current: string | undefined) {
  const flat = flatten(tree);
  if (!current) {
    return tree;
  }
  if (flat.some((node) => node.path === current)) {
    return tree;
  }
  let anchor: PickerNode | undefined;
  for (const ancestor of ancestorsOf(current)) {
    const found = flat.find((node) => node.path === ancestor);
    if (found) {
      anchor = found;
    }
  }
  const missing: PickerNode = {
    path: current,
    key: anchor ? current.slice(anchor.path.length).replace(/^\./, '') : current,
    kind: 'not in this entry',
    preview: '',
    children: undefined,
    missing: true,
  };
  if (!anchor) {
    return [...(tree || []), missing];
  }
  // The bounded flatten above already proved the tree stays inside the depth limit;
  // the graft checks it again on its own walk.
  const anchorPath = anchor.path;
  const graft = (nodes: readonly PickerNode[], depth: number): readonly PickerNode[] => {
    assert(depth <= LIMITS.treeDepthMax, 'DataPicker: depth limit exceeded');
    return nodes.map((node) =>
      node.path === anchorPath
        ? { ...node, children: [...(node.children || []), missing] }
        : node.children
          ? { ...node, children: graft(node.children, depth + 1) }
          : node,
    );
  };
  return graft(tree || [], 0);
}

interface Navigation {
  readonly index: number;
  readonly count: number;
}
interface Entries extends Navigation {
  readonly label: string;
  readonly onStep: (step: -1 | 1) => void;
}
export interface PickerNode {
  readonly path: string;
  readonly key: string;
  readonly kind: string;
  readonly preview: string;
  readonly children: readonly PickerNode[] | undefined;
  readonly section?: string;
  readonly nav?: Navigation;
  readonly query?: { readonly collection: string; readonly name: string };
  readonly lazy?: boolean;
  readonly pickable?: boolean;
  readonly missing?: boolean;
  readonly image?: string;
}
export interface DataPickerProps {
  readonly tree?: readonly PickerNode[] | undefined;
  readonly current?: string | undefined;
  readonly sourceInspection?: LoopSourceInspection | undefined;
  readonly onEditSource?: (() => void) | undefined;
  readonly entries?: Entries | undefined;
  readonly onStepItem?: (path: string, step: -1 | 1, count: number) => void;
  readonly onPick: (path: string, query: PickerNode['query'] | undefined) => void;
  readonly onExpand?: (node: PickerNode) => void;
  readonly onWrite?: () => void;
  readonly onEdit?: (() => void) | undefined;
  readonly editLabel?: string;
  readonly footer?: boolean;
}

export default function DataPicker(props: DataPickerProps) {
  const allowCode = useCodeAccess();
  const {
    entries,
    onStepItem,
    onPick,
    onWrite,
    onEdit,
    editLabel = 'Edit',
    footer = true,
    sourceInspection,
    onEditSource,
  } = props;
  const state = useDataPicker(props);
  const { query, setQuery, searchRef, listRef } = state;
  return (
    <div className="data-picker">
      {/* Which entry the values below are FROM. A dynamic route stands for
          many, and the one on the canvas is the one being read here — so
          stepping through them previews the page against other content and
          re-reads this list against it at the same time. */}
      {entries && entries.count > 1 && <EntryNavigation entries={entries} />}
      {sourceInspection && (
        <LoopSourceSummary
          source={sourceInspection}
          onEdit={allowCode ? onEditSource : undefined}
        />
      )}
      <div className="dp-search">
        <SearchIcon size={12} />
        <input
          ref={searchRef}
          value={query}
          placeholder="Search data…"
          spellCheck={false}
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <DataPickerResults state={state} onPick={onPick} onStepItem={onStepItem} listRef={listRef} />
      {/* Above "Write an expression…", because it is about the thing already
          bound rather than about replacing it. Only ever rendered for a picker
          opened on a specific chip — the field's own handle opens this on
          nothing in particular, and there is no "the" value to edit then. */}
      {allowCode && onEdit && (
        <div className="dp-foot" onMouseDown={(event) => event.preventDefault()} onClick={onEdit}>
          <PencilIcon size={11} />
          {editLabel}
        </div>
      )}
      {allowCode && footer && (
        <div className="dp-foot" onMouseDown={(event) => event.preventDefault()} onClick={onWrite}>
          <CodeIcon size={11} />
          Write an expression…
        </div>
      )}
    </div>
  );
}

function DataPickerResults({
  state,
  onPick,
  onStepItem,
  listRef,
}: {
  readonly state: PickerState;
  readonly onPick: DataPickerProps['onPick'];
  readonly onStepItem: DataPickerProps['onStepItem'];
  readonly listRef: React.RefObject<HTMLDivElement>;
}) {
  const { matches, tree } = state;
  return (
    <div className="dp-list" ref={listRef}>
      {/* Search uses full paths because the flattened rows lose their parents. */}
      {matches ? (
        matches.map((node) => (
          <DataRow
            key={node.path}
            node={node}
            depth={0}
            showPath
            root={undefined}
            state={state}
            onPick={onPick}
            onStepItem={onStepItem}
          />
        ))
      ) : (
        <DataRoots nodes={tree} state={state} onPick={onPick} onStepItem={onStepItem} />
      )}
      {((matches && !matches.length) || (!matches && !tree.length)) && (
        <div className="dp-empty">
          {matches
            ? 'Nothing matches'
            : 'No data in scope here — add a prop to this file, or a const to its frontmatter.'}
        </div>
      )}
    </div>
  );
}

function LoopSourceSummary({
  source,
  onEdit,
}: {
  readonly source: LoopSourceInspection;
  readonly onEdit: (() => void) | undefined;
}) {
  return (
    <div className="dp-source-summary">
      <div className="dp-source-heading">Looping over</div>
      <div className="dp-source-path" title={source.path}>
        {source.path}
      </div>
      <div className="dp-source-origin" title={source.origin}>
        {source.count === undefined
          ? 'Source'
          : `${source.count} ${source.count === 1 ? 'item' : 'items'}`}
        {' · '}
        {source.origin}
      </div>
      {source.items.length > 0 && (
        <div className="dp-source-items">
          {source.items.map((item, index) => (
            <div className="dp-source-item" key={index} title={item}>
              <span>{index + 1}</span>
              {item}
            </div>
          ))}
          {source.count !== undefined && source.count > source.items.length && (
            <div className="dp-source-more">+{source.count - source.items.length} more items</div>
          )}
        </div>
      )}
      {source.note && <div className="dp-source-note">{source.note}</div>}
      {onEdit && (
        <button type="button" className="dp-source-edit" onClick={onEdit}>
          <PencilIcon size={11} /> Open source to edit
        </button>
      )}
    </div>
  );
}

function useDataPicker({ tree: rawTree, current, onExpand }: DataPickerProps) {
  const [query, setQuery] = useState('');
  const tree = useMemo(() => withCurrent(rawTree ?? [], current), [rawTree, current]);
  const [open, setOpen] = useState(() => {
    const start = new Set(ancestorsOf(current));
    // Nothing bound yet: open the first root that holds anything, so the panel
    // opens on data rather than on a list of closed names.
    if (!start.size) {
      const first = (tree || []).find((node) => node.children?.length);
      if (first) {
        start.add(first.path);
      }
    }
    return start;
  });
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLDivElement>(null);

  // Open ON what the field is already bound to: the ancestors are expanded
  // above, and the row itself is brought into view here. A path four levels
  // down is otherwise below the fold, which reads as the picker not knowing
  // what the chip was pointing at.
  useLayoutEffect(() => {
    const list = listRef.current;
    const row = selectedRef.current;
    if (!list || !row) {
      return;
    }
    const lr = list.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    if (rr.top >= lr.top && rr.bottom <= lr.bottom) {
      return;
    } // already in view
    list.scrollTop += rr.top - lr.top - (lr.height - rr.height) / 2;
  }, [current]);

  const needle = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!needle) {
      return undefined;
    }
    return flatten(tree || []).filter(
      (node) =>
        node.path.toLowerCase().includes(needle) ||
        String(node.preview).toLowerCase().includes(needle),
    );
  }, [needle, tree]);

  const toggle = (node: PickerNode) => {
    // A collection nobody has looked at yet has no rows until it is asked for.
    if (node.lazy && !node.children?.length) {
      onExpand?.(node);
    }
    setOpen((previous) => {
      const next = new Set(previous);
      if (next.has(node.path)) {
        next.delete(node.path);
      } else {
        next.add(node.path);
      }
      return next;
    });
  };

  return { query, setQuery, tree, open, searchRef, listRef, selectedRef, matches, toggle, current };
}

type PickerState = ReturnType<typeof useDataPicker>;
interface RowProps {
  readonly node: PickerNode;
  readonly depth: number;
  readonly showPath: boolean;
  readonly root: PickerNode | undefined;
  readonly state: PickerState;
  readonly onPick: DataPickerProps['onPick'];
  readonly onStepItem: DataPickerProps['onStepItem'];
}
function DataRow({ node, depth, showPath, root, state, onPick, onStepItem }: RowProps) {
  assert(depth <= LIMITS.treeDepthMax, 'DataPicker: render depth limit exceeded');
  const { open, current, selectedRef, toggle } = state;
  const expandable = !!node.children?.length || node.lazy;
  const isOpen = open.has(node.path);
  const from = root || node;
  const isCurrent = node.path === current;
  return (
    <React.Fragment key={node.path}>
      <div
        ref={isCurrent ? selectedRef : undefined}
        className={`dp-row ${isCurrent ? 'selected' : ''} ${
          node.pickable === false ? 'path-only' : ''
        } ${node.missing ? 'missing' : ''}`}
        style={{ paddingLeft: 6 + depth * DEPTH_INDENT_PX }}
        title={`${node.path}${node.kind ? ` — ${node.kind}` : ''}`}
        onMouseDown={(event) => event.preventDefault()}
        // The root carries what has to happen before this path means
        // anything — a collection the page doesn't read yet needs its query
        // written first.
        onClick={() =>
          // A row kept only so a list beneath it can be reached opens
          // instead of being chosen — there is no looping over an object.
          node.pickable === false ? toggle(node) : onPick(node.path, from.query || undefined)
        }
      >
        <span
          className={`dp-twist ${expandable ? '' : 'hidden'} ${isOpen ? 'open' : ''}`}
          onClick={
            expandable
              ? (event) => {
                  event.stopPropagation();
                  toggle(node);
                }
              : undefined
          }
        >
          <ChevronRightIcon size={10} />
        </span>
        <span className="dp-key">{showPath ? node.path : node.key}</span>
        {isCurrent && <CheckIcon size={11} className="dp-check" />}
        {/* A loop hands its item one entry of a list, and the list has more
              than one. These say which one is being read, and move it — so the
              fields below are this service's, not always the first one's. The
              row itself still picks the item, so the arrows stop the click. */}
        {node.nav && onStepItem ? (
          <ItemNavigation path={node.path} nav={node.nav} onStepItem={onStepItem} />
        ) : undefined}
        <PreviewValue preview={node.preview} kind={node.kind} image={node.image} />
      </div>
      {isOpen &&
        (node.children?.length ? (
          node.children.map((child) => (
            <DataRow
              key={child.path}
              node={child}
              depth={depth + 1}
              showPath={false}
              root={from}
              state={state}
              onPick={onPick}
              onStepItem={onStepItem}
            />
          ))
        ) : node.lazy ? (
          <div className="dp-loading" style={{ paddingLeft: 19 + depth * DEPTH_INDENT_PX }}>
            Reading one entry…
          </div>
        ) : undefined)}
    </React.Fragment>
  );
}
function ItemNavigation({
  path,
  nav,
  onStepItem,
}: {
  readonly path: string;
  readonly nav: Navigation;
  readonly onStepItem: (path: string, step: -1 | 1, count: number) => void;
}) {
  return (
    <span className="dp-item-nav" onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        className="dp-step"
        title="Previous item"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onStepItem(path, -1, nav.count)}
      >
        <ChevronLeftIcon size={11} />
      </button>
      <span className="dp-item-count">
        {nav.index + 1}/{nav.count}
      </span>
      <button
        type="button"
        className="dp-step"
        title="Next item"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onStepItem(path, 1, nav.count)}
      >
        <ChevronRightIcon size={11} />
      </button>
    </span>
  );
}
// Roots in order, with a heading wherever the section changes — the
// collections at the foot are a different kind of thing from what is already
// in scope, and reading as one list would hide that.
function DataRoots({
  nodes,
  state,
  onPick,
  onStepItem,
}: {
  readonly nodes: readonly PickerNode[];
  readonly state: PickerState;
  readonly onPick: DataPickerProps['onPick'];
  readonly onStepItem: DataPickerProps['onStepItem'];
}) {
  let section: string | undefined;
  return (nodes || []).map((node) => {
    const head = node.section && node.section !== section ? SECTION_LABEL[node.section] : undefined;
    section = node.section || section;
    return (
      <React.Fragment key={`s:${node.path}`}>
        {head && <div className="dp-section">{head}</div>}
        {
          <DataRow
            node={node}
            depth={0}
            showPath={false}
            root={undefined}
            state={state}
            onPick={onPick}
            onStepItem={onStepItem}
          />
        }
      </React.Fragment>
    );
  });
}
function EntryNavigation({ entries }: { readonly entries: Entries }) {
  return (
    <div className="dp-entry">
      <button
        type="button"
        className="dp-step"
        title="Previous entry"
        onMouseDown={(event) => event.preventDefault()}
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
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => entries.onStep(1)}
      >
        <ChevronRightIcon size={12} />
      </button>
    </div>
  );
}

// What a field holds, as a person reads it: words without the quotes a sample
// writes around them, a link without its scheme, and an image as the image.
function PreviewValue(props: {
  readonly preview: string;
  readonly kind: string;
  readonly image: string | undefined;
}) {
  if (props.image) {
    return (
      <span className="dp-val" title={props.image}>
        <img className="dp-thumb" src={props.image} alt="" loading="lazy" />
      </span>
    );
  }
  if (!props.preview) {
    return <span className="dp-val kind">{props.kind}</span>;
  }
  const words = unquoted(props.preview);
  return words === undefined ? (
    <span className="dp-val">{props.preview}</span>
  ) : (
    <span className="dp-val text" title={words}>
      {words.replace(/^https?:\/\//, '')}
    </span>
  );
}

// The words of a quoted string preview, or undefined for any other value. A
// long one is clipped with an ellipsis where its closing quote was.
function unquoted(preview: string): string | undefined {
  if (!preview.startsWith('"')) {
    return undefined;
  }
  if (preview.endsWith('…')) {
    return preview.slice(1);
  }
  if (preview.length < 2 || !preview.endsWith('"')) {
    return undefined;
  }
  return preview.slice(1, -1);
}
