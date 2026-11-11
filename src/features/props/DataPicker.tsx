import { useCodeAccess } from '../../ui/CodeAccess';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import {
  BracesIcon,
  ChevronRightIcon,
  ChevronLeftIcon,
  AstroIcon,
  CmsIcon,
  ElementComponentIcon,
  FileIcon,
  CodeIcon,
  ElementImageIcon,
  FieldNumberIcon,
  FieldSwitchIcon,
  GearIcon,
  PencilIcon,
  RepeatIcon,
  TextIcon,
} from '../../ui/Icons';
import { pathSteps } from '../../editor/dataSample';
import {
  entryPageOf,
  entryPath,
  dataFileOfSection,
  isComponentSection,
  sectionHeads,
  missingLabel,
  pagesOfPath,
  settingsKeyOf,
  shownEntryRows,
  steppedEntryIndex,
  type DataOrigin,
  type EntryPages,
} from './dataPickerModel';
import { DataSearch, DataSection, DataSubsection, DataTreeRow, ItemNavigation, PreviewValue, dataRowIndentPx, type ItemPosition } from '../../ui/DataTree';
import type { PropSettingsOffer } from './newPropModel';
import type { ImportNeed } from '../../editor/dataSample';
import type { PickNeed } from '../../editor/bindings';

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
  const pathText = path || '';
  assert(pathText.length <= LIMITS.attrCharsMax, 'DataPicker: binding path limit exceeded');
  // Every step's prefix but the whole path: `posts[0]` is one step down from
  // `posts`, and `post.data["campus-name"]` one down from `post.data`.
  const steps = pathSteps(pathText) ?? [];
  return steps.slice(0, -1).map((step) => pathText.slice(0, step.end));
}

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
    assert(out.length + pending.length + children.length <= LIMITS.treeNodesMax, 'DataPicker: node limit exceeded');
    for (let index = children.length - 1; index >= 0; index--) {
      const node = children[index];
      assert(node !== undefined, 'DataPicker: child exists');
      pending.push({ node, depth: next.depth + 1 });
    }
  }
  return out;
}

/**
 * The rows a search shows, flat, in tree order: every node whose path or value
 * holds `needle` (lower case). Each keeps its root, so a field found inside a
 * collection or a data file still writes that source's query or import when
 * it is picked.
 */
export function searchMatches(tree: readonly PickerNode[], needle: string): { readonly node: PickerNode; readonly root: PickerNode }[] {
  assert(needle === needle.toLowerCase(), 'searchMatches: the needle is lower case');
  return withRoots(tree).filter(({ node }) => node.path.toLowerCase().includes(needle) || String(node.preview).toLowerCase().includes(needle));
}

// Every node with the root it hangs from, roots included, in the order the
// tree lists them: search shows them flat and still needs each one's source.
function withRoots(tree: readonly PickerNode[]): { readonly node: PickerNode; readonly root: PickerNode }[] {
  const out = tree.flatMap((root) => flatten([root]).map((node) => ({ node, root })));
  assert(out.length <= LIMITS.treeNodesMax * Math.max(tree.length, 1), 'DataPicker: node limit exceeded');
  return out;
}

/**
 * What picking under `root` has to write first, or undefined for data already
 * in scope. resolvePick checks the picked path against the need's name; the
 * Source picker addresses its roots its own way and reads only the path.
 */
export function needOf(root: Pick<PickerNode, 'query' | 'importNeed'>): PickNeed | undefined {
  if (root.query !== undefined) {
    return { kind: 'collection', collection: root.query.collection, name: root.query.name };
  }
  if (root.importNeed !== undefined) {
    return { kind: 'import', import: root.importNeed, name: root.importNeed.name };
  }
  return undefined;
}

// A field can be bound to something the tree doesn't hold — an optional
// field an entry left unset, or data the app can't see the shape of. The path is still
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
  const anchors: PickerNode[] = [];
  for (const ancestor of ancestorsOf(current)) {
    const found = flat.find((node) => node.path === ancestor);
    if (found) {
      anchors.push(found);
    }
  }
  const anchor = anchors[anchors.length - 1];
  const missing: PickerNode = {
    path: current,
    key: anchor ? current.slice(anchor.path.length).replace(/^\./, '') : current,
    // "not in this entry" only for a field a collection entry left unset;
    // anything else says what is really known about it (dataPickerModel.ts).
    kind: missingLabel(anchors),
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

type Navigation = ItemPosition;
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
  readonly entryCount?: number;
  readonly query?: { readonly collection: string; readonly name: string };
  readonly importNeed?: ImportNeed;
  /** Why the row cannot be bound (an imported function): it is drawn dimmed, says why, and picks nothing. */
  readonly unbindable?: string;
  /** A muted word in place of a value: a prop the instance does not pass and has no default reads "not set". */
  readonly note?: string;
  readonly lazy?: boolean;
  readonly pickable?: boolean;
  readonly missing?: boolean;
  readonly image?: string;
}
export interface DataPickerProps {
  readonly tree?: readonly PickerNode[] | undefined;
  readonly current?: string | undefined;
  readonly entries?: Entries | undefined;
  readonly onStepItem?: (path: string, step: -1 | 1, count: number) => void;
  /** `need` is what the file has to read first: a collection's query, or a data file's import. */
  readonly onPick: (path: string, need: PickNeed | undefined) => void;
  /**
   * A row needs data the app has not read: a collection opened for the first
   * time (`index` undefined), or the entry its pager stepped to.
   */
  readonly onExpand?: (node: PickerNode, index: number | undefined) => void;
  /** Which file is being bound, so each group of rows can say where its data lives. */
  readonly origin?: DataOrigin | undefined;
  readonly onWrite?: () => void;
  readonly onEdit?: (() => void) | undefined;
  readonly editLabel?: string;
  readonly footer?: boolean;
  /** Rows above the search, for what the field can do besides pick: "New Text property" in a component. */
  readonly lead?: ReactNode;
  /** Opens a prop's settings from its row. A host without it shows no gear. */
  readonly propSettings?: PropSettingsOffer | undefined;
  /**
   * Whether a group of data the file does not read yet (a project data file,
   * the content collections) starts folded under its heading: `folded`, the
   * default, in a binding picker where it sits below what is in scope; `open`
   * where those groups are all there is to choose from (the loop's Source).
   */
  readonly sources?: 'folded' | 'open';
}

export default function DataPicker(props: DataPickerProps) {
  const allowCode = useCodeAccess();
  const { entries, onStepItem, onPick, onWrite, onEdit, editLabel = 'Edit', footer = true, lead } = props;
  const state = useDataPicker(props);
  const { query, setQuery, searchRef, listRef } = state;
  const origin = props.origin;
  const { propSettings } = props;
  const editing = propSettings === undefined ? undefined : state.settingsKey;
  return (
    <>
      {/* Hidden rather than unmounted while a prop's settings are open, so what
          was opened, stepped to and searched for is still there afterwards. */}
      <div className={editing === undefined ? 'data-picker' : 'data-picker is-covered'}>
        {lead}
        {/* Which entry the values below are FROM. A dynamic route stands for
          many, and the one on the canvas is the one being read here — so
          stepping through them previews the page against other content and
          re-reads this list against it at the same time. */}
        {entries && entries.count > 1 && <EntryNavigation entries={entries} />}
        <DataSearch value={query} label="Search data" inputRef={searchRef} onChange={setQuery} />
        <DataPickerResults state={state} origin={origin} folding={props.sources ?? 'folded'} onPick={onPick} onStepItem={onStepItem} listRef={listRef} />
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
      {editing !== undefined && propSettings !== undefined && <div className="dp-property-settings">{propSettings.render(editing, state.closeSettings)}</div>}
    </>
  );
}

function DataPickerResults({
  state,
  origin,
  folding,
  onPick,
  onStepItem,
  listRef,
}: {
  readonly state: PickerState;
  readonly origin: DataOrigin | undefined;
  readonly folding: 'folded' | 'open';
  readonly onPick: DataPickerProps['onPick'];
  readonly onStepItem: DataPickerProps['onStepItem'];
  readonly listRef: React.RefObject<HTMLDivElement>;
}) {
  const { matches, tree } = state;
  return (
    <div className="dp-list" ref={listRef}>
      {/* Search uses full paths because the flattened rows lose their parents. */}
      {matches ? (
        matches.map((match) => (
          <DataRow key={match.node.path} node={match.node} depth={0} showPath root={match.root} state={state} onPick={onPick} onStepItem={onStepItem} />
        ))
      ) : (
        <DataRoots nodes={tree} origin={origin} folding={folding} state={state} onPick={onPick} onStepItem={onStepItem} />
      )}
      {((matches && !matches.length) || (!matches && !tree.length)) && (
        <div className="dp-empty">{matches ? 'Nothing matches' : 'No data in scope here — add a prop to this file, or a const to its frontmatter.'}</div>
      )}
    </div>
  );
}

function useDataPicker({ tree: rawTree, current, onExpand, propSettings }: DataPickerProps) {
  // Which folded source groups are open, by section, for as long as the picker is.
  // A group holding the current binding starts open, so the picker opens ON it.
  const [sections, setSections] = useState<ReadonlySet<string>>(() => sectionsHolding(rawTree ?? [], current));
  const [query, setQuery] = useState('');
  const [settingsKey, setSettingsKey] = useState<string | undefined>(undefined);
  const tree = useMemo(() => withCurrent(rawTree ?? [], current), [rawTree, current]);
  // Which entry each list of entries shows: the one the binding names, else the first.
  const [pages, setPages] = useState<EntryPages>(() => pagesOfPath(current));
  const [open, setOpen] = useState(() => {
    const start = new Set(ancestorsOf(current));
    // Nothing bound yet: open the first root that holds anything, so the panel
    // opens on data rather than on a list of closed names. Never a project
    // collection: it is a whole list of entries, the page does not read it
    // yet, and opened it buried the data that is in scope under its rows.
    if (!start.size) {
      // Nor a data file the file does not import: it is not this file's data yet either.
      const first = (tree || []).find((node) => node.children?.length && node.section !== 'collections' && needOf(node) === undefined);
      if (first) {
        start.add(first.path);
        const page = entryPageOf(first, pages);
        if (page !== undefined) {
          start.add(entryPath(first.path, page.index));
        }
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
    return searchMatches(tree, needle);
  }, [needle, tree]);

  // A paged list opened, or stepped, onto an entry the app has not read asks
  // for it. After render rather than in the click, because a list opened on a
  // binding (`stats[2]…`) is open before anything is clicked. The app drops a
  // question already out, so asking again on a later render costs nothing.
  useEffect(() => {
    if (onExpand === undefined) {
      return;
    }
    for (const node of flatten(tree)) {
      const page = open.has(node.path) && node.query !== undefined ? entryPageOf(node, pages) : undefined;
      if (page !== undefined && shownEntryRows(node.path, node.children ?? [], page).unread) {
        onExpand(node, page.index);
      }
    }
  }, [tree, open, pages, onExpand]);

  const toggle = (node: PickerNode) => {
    // A collection nobody has looked at yet has no rows until it is asked for.
    if (node.lazy && !node.children?.length) {
      onExpand?.(node, undefined);
    }
    const page = entryPageOf(node, pages);
    setOpen((previous) => {
      const next = new Set(previous);
      if (next.has(node.path)) {
        next.delete(node.path);
      } else {
        next.add(node.path);
        // A list of entries opens onto its entry's fields: the entry row is
        // the only row beneath it, so leaving it closed is one more click
        // for nothing.
        if (page !== undefined) {
          next.add(entryPath(node.path, page.index));
        }
      }
      return next;
    });
  };

  const stepEntry = (node: PickerNode, step: -1 | 1) => {
    const page = entryPageOf(node, pages);
    assert(page !== undefined, 'DataPicker: only a list of entries is stepped');
    const index = steppedEntryIndex(page, step);
    setPages((previous) => ({ ...previous, [node.path]: index }));
    setOpen((previous) => new Set(previous).add(entryPath(node.path, index)));
  };

  const closeSettings = (): void => {
    setSettingsKey(undefined);
    // The search was hidden with the rest, so the keyboard goes back to where the picker starts.
    searchRef.current?.focus();
  };

  const toggleSection = (section: string): void => {
    setSections((previous) => {
      const next = new Set(previous);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  };

  return {
    query,
    setQuery,
    sections,
    toggleSection,
    tree,
    open,
    pages,
    searchRef,
    listRef,
    selectedRef,
    matches,
    toggle,
    stepEntry,
    current,
    settingsKey,
    openSettings: setSettingsKey,
    closeSettings,
    keyOf: propSettings?.keyOf,
  };
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
  const { open, pages, current, selectedRef, toggle, stepEntry } = state;
  const expandable = !!node.children?.length || node.lazy;
  const isOpen = open.has(node.path);
  // An open list of entries shows one of them, with arrows to choose which;
  // closed, it says how many it holds like any other row.
  const page = isOpen ? entryPageOf(node, pages) : undefined;
  const shown = page === undefined ? undefined : shownEntryRows(node.path, node.children ?? [], page);
  const from = root || node;
  const isCurrent = node.path === current;
  return (
    <React.Fragment key={node.path}>
      <DataTreeRow
        depth={depth}
        label={showPath ? node.path : node.key}
        title={`${node.path} — ${node.unbindable ?? node.kind}`}
        expandable={expandable === true}
        open={isOpen}
        selected={isCurrent}
        tone={node.missing ? 'missing' : node.unbindable !== undefined ? 'disabled' : node.pickable === false ? 'path-only' : 'plain'}
        check="selected-only"
        rowRef={isCurrent ? selectedRef : undefined}
        lead={<DataRowLead node={node} depth={depth} />}
        // A loop hands its item one entry of a list, and the list has more
        // than one. These say which one is being read, and move it — so the
        // fields below are this service's, not always the first one's. The
        // row itself still picks the item, so the arrows stop the click.
        // They take the right edge in place of the item's field count,
        // which the open rows beneath already show.
        value={
          node.nav && onStepItem ? (
            <ItemNavigation path={node.path} nav={node.nav} onStepItem={onStepItem} />
          ) : page !== undefined ? (
            <ItemNavigation path={node.path} nav={page} onStepItem={(_path, step) => stepEntry(node, step)} />
          ) : node.note !== undefined ? (
            <span className="dp-val kind">{node.note}</span>
          ) : (
            <PreviewValue preview={node.preview} kind={node.kind} image={node.image} />
          )
        }
        end={state.keyOf !== undefined && <PropSettingsSlot propKey={settingsKeyOf(node, state.keyOf)} onOpen={state.openSettings} />}
        onToggle={() => toggle(node)}
        // The root carries what has to happen before this path means
        // anything — a collection the page doesn't read yet needs its query
        // written first. A row kept only so a list beneath it can be reached
        // opens instead of being chosen — there is no looping over an object.
        onPick={() => (node.pickable === false ? toggle(node) : onPick(node.path, needOf(from)))}
      />
      {isOpen &&
        (shown !== undefined ? (
          <>
            {shown.rows.map((child) => (
              <DataRow key={child.path} node={child} depth={depth + 1} showPath={false} root={from} state={state} onPick={onPick} onStepItem={onStepItem} />
            ))}
            {shown.unread && (
              <div className="dp-loading" style={{ paddingLeft: dataRowIndentPx(depth + 1) }}>
                Reading one entry…
              </div>
            )}
          </>
        ) : node.children?.length ? (
          node.children.map((child) => (
            <DataRow key={child.path} node={child} depth={depth + 1} showPath={false} root={from} state={state} onPick={onPick} onStepItem={onStepItem} />
          ))
        ) : node.lazy ? (
          <div className="dp-loading" style={{ paddingLeft: dataRowIndentPx(depth + 1) }}>
            Reading one entry…
          </div>
        ) : undefined)}
    </React.Fragment>
  );
}
// What a root row leads with: a prop's kind, or the CMS mark on a collection —
// a collection is a CMS collection to the person reading the list, as in the
// left rail. Its section heading carries Astro's.
function DataRowLead({ node, depth }: { readonly node: PickerNode; readonly depth: number }) {
  if (depth > 0) {
    return undefined;
  }
  if (node.section === 'props') {
    return <PropKindIcon kind={node.kind} />;
  }
  if (node.section === 'collections') {
    return (
      <span className="dp-kind-icon" title="Content collection">
        <CmsIcon size={12} />
      </span>
    );
  }
  return undefined;
}

// The end of every row of a picker that can open settings, filled only on a
// prop's: the slot is there either way, so showing the gear moves nothing and
// the column of values beside it stays one column.
function PropSettingsSlot({ propKey, onOpen }: { readonly propKey: string | undefined; readonly onOpen: (key: string) => void }) {
  return (
    <span className="dp-settings-slot">
      {propKey !== undefined && (
        <button
          type="button"
          className="dp-settings"
          aria-label={`Edit ${propKey} settings`}
          title="Edit settings"
          // Pressing it keeps the caret in the field, as pressing the row does.
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            // The row picks on click; this opens settings and leaves the binding alone.
            event.stopPropagation();
            onOpen(propKey);
          }}
        >
          <GearIcon size={12} />
        </button>
      )}
    </span>
  );
}
// Roots in order, with a heading wherever the section changes — the
// collections at the foot are a different kind of thing from what is already
// in scope, and reading as one list would hide that.
function DataRoots({
  nodes,
  origin,
  folding,
  state,
  onPick,
  onStepItem,
}: {
  readonly nodes: readonly PickerNode[];
  readonly origin: DataOrigin | undefined;
  readonly folding: 'folded' | 'open';
  readonly state: PickerState;
  readonly onPick: DataPickerProps['onPick'];
  readonly onStepItem: DataPickerProps['onStepItem'];
}) {
  let section: string | undefined;
  return (nodes || []).map((node) => {
    const heads = node.section && node.section !== section ? sectionHeads(node.section, section, origin) : [];
    section = node.section || section;
    const folds = folding === 'folded' && isSourceSection(section);
    // A folded group's rows are not drawn at all, so nothing in it can be reached until it is opened.
    const shown = !folds || (section !== undefined && state.sections.has(section));
    const key = section;
    return (
      <React.Fragment key={`s:${node.path}`}>
        {heads.map((head) =>
          head.kind === 'part' ? (
            <DataSubsection key={`h:${head.heading}`} heading={head.heading} />
          ) : (
            <DataSection
              key={`h:${head.heading}`}
              heading={head.heading}
              tone={isComponentSection(head.section, origin) ? 'component' : 'source'}
              icon={<SectionIcon section={head.section} />}
              collapse={folds && key !== undefined ? { open: shown, onToggle: () => state.toggleSection(key) } : undefined}
            />
          ),
        )}
        {shown && <DataRow node={node} depth={0} showPath={false} root={undefined} state={state} onPick={onPick} onStepItem={onStepItem} />}
      </React.Fragment>
    );
  });
}

/** Whether a group holds data the file does not read yet: a project data file, or the content collections. */
export function isSourceSection(section: string | undefined): boolean {
  if (section === 'collections') {
    return true;
  }
  return dataFileOfSection(section) !== undefined;
}

// The source groups that hold the binding the picker opens on: its root's group.
function sectionsHolding(tree: readonly PickerNode[], current: string | undefined): ReadonlySet<string> {
  const steps = current === undefined ? [] : [...ancestorsOf(current), current];
  const sections = new Set<string>();
  for (const node of tree) {
    if (node.section !== undefined && isSourceSection(node.section) && steps.includes(node.path)) {
      sections.add(node.section);
    }
  }
  assert(sections.size <= tree.length, 'sectionsHolding: one group per root at most');
  return sections;
}

// Where a section's data comes from, as a mark beside its heading: the
// component whose props these are, Astro for its content collections, or a
// file for a project data file.
function SectionIcon({ section }: { readonly section: string | undefined }) {
  if (section === 'props' || section === 'loop-component') {
    return <ElementComponentIcon size={11} className="dp-section-icon" />;
  }
  if (section === 'collections') {
    return <AstroIcon size={11} className="dp-section-icon" />;
  }
  // A project data file is a file, marked as the Pages panel marks one; the
  // CMS mark stays with what the CMS holds (the collections' rows).
  if (dataFileOfSection(section) !== undefined) {
    return <FileIcon size={11} className="dp-section-icon" />;
  }
  return undefined;
}

function EntryNavigation({ entries }: { readonly entries: Entries }) {
  return (
    <div className="dp-entry">
      <button type="button" className="dp-step" title="Previous entry" onMouseDown={(event) => event.preventDefault()} onClick={() => entries.onStep(-1)}>
        <ChevronLeftIcon size={12} />
      </button>
      <span className="dp-entry-label" title={entries.label}>
        {entries.label}
      </span>
      <span className="dp-entry-count">
        {entries.index + 1}/{entries.count}
      </span>
      <button type="button" className="dp-step" title="Next entry" onMouseDown={(event) => event.preventDefault()} onClick={() => entries.onStep(1)}>
        <ChevronRightIcon size={12} />
      </button>
    </div>
  );
}

// What a component prop holds, as the icon its row leads with: words, a
// number, a switch, attributes, an image or a list of items. Other kinds have
// no icon of their own.
function PropKindIcon({ kind }: { readonly kind: string }) {
  switch (kind) {
    case 'string':
    case 'text':
    case 'enum':
      return (
        <span className="dp-kind-icon" title="Text">
          <TextIcon size={11} />
        </span>
      );
    case 'number':
      return (
        <span className="dp-kind-icon" title="Number">
          <FieldNumberIcon size={11} />
        </span>
      );
    case 'boolean':
      return (
        <span className="dp-kind-icon" title="Switch">
          <FieldSwitchIcon size={11} />
        </span>
      );
    case 'rest props':
      return (
        <span className="dp-kind-icon" title="Attributes">
          <BracesIcon size={11} />
        </span>
      );
    case 'image':
    case 'image url':
      return (
        <span className="dp-kind-icon" title="Image">
          <ElementImageIcon size={11} />
        </span>
      );
    case 'list':
      return (
        <span className="dp-kind-icon" title="List">
          <RepeatIcon size={11} />
        </span>
      );
    default:
      return undefined;
  }
}
