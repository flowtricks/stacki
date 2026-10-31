// A connected CMS's collection in the main view, laid out the way a CMS lists
// its items: a table with search, multi-select to delete, and "New item"; where
// the CMS keeps an order (Sanity's orderable plugin), rows drag into a new one.
// Opening an item narrows the table to a column of names beside its fields
// (RemoteItemFields.tsx). Field edits are drafts; deleting and reordering act as
// the CMS's own editor does (sanityEdits.ts), deleting only after a confirm.
import { useMemo, useState } from 'react';
import './remoteCms.css';
import { CloseIcon, DragIcon, PlusIcon, SearchIcon, TrashIcon } from '../../ui/Icons';
import { ErrorToast } from '../../ui/ErrorToast';
import { confirmDialog } from '../../ui/ConfirmDialog';
import useListReorder from '../../ui/useListReorder';
import {
  createRemoteDocument,
  deleteRemoteDocuments,
  moveRemoteDocument,
  remoteDocuments,
} from '../../ipc/cmsConnectionsBridge';
import type {
  RemoteDocumentList,
  RemoteDocumentSummary,
  RemoteResult,
} from '../../../shared/properties/cmsRemote';
import { labelize } from './cmsSchema';
import { STATUS_LABELS } from './RemoteCmsBrowser';
import { RemoteItemFields } from './RemoteItemFields';
import { Loading, useRemote, type RemoteCmsSelection } from './remoteCmsShared';
import { DOCUMENT_LISTS, listKey, prefetchDocument } from './remoteCmsCache';
import { SanityTypeIcon, typeIcons } from './SanityTypeIcon';

interface Props {
  readonly projectPath: string;
  readonly selection: RemoteCmsSelection;
  readonly hidden: boolean;
  readonly onSelect: (selection: RemoteCmsSelection | undefined) => void;
}

export function RemoteCmsView(props: Props) {
  const { projectPath, selection } = props;
  const { connection, collection } = selection;
  // Kept across opens and refreshed behind the view: a delete, a drag or a save
  // shows its result at once and never blanks the list (remoteCmsCache.ts).
  const { result, retry, replace } = useRemote(
    DOCUMENT_LISTS,
    listKey(connection.id, collection),
    () => remoteDocuments(projectPath, connection.id, collection),
  );
  const list = result?.ok ? result.value : undefined;
  const reload = retry;
  // The column waits for the list, so a collection of one item never flashes it.
  const single = list === undefined || list.documents.length <= 1;
  const openItem = (item: RemoteDocumentSummary | undefined) =>
    props.onSelect({ ...selection, item: item && { id: item.id, title: item.title } });
  return (
    <div className={`cms-view ${props.hidden ? 'hidden' : ''}`}>
      {selection.item ? (
        <>
          {/* One item has nothing to choose between or return to: its fields fill the view. */}
          {!single && (
            <ItemColumn
              projectPath={projectPath}
              list={list}
              selection={selection}
              onOpen={openItem}
              onCreate={() => void create({ ...props, reload, openItem })}
            />
          )}
          <RemoteItemFields
            projectPath={projectPath}
            selection={selection}
            onBack={single ? undefined : () => openItem(undefined)}
            onRemoved={() => openItem(undefined)}
            onSaved={reload}
          />
        </>
      ) : (
        <Loading result={result} retry={retry}>
          {(loaded) => (
            <ItemTable
              {...props}
              list={loaded}
              onOpen={openItem}
              onMoved={replace}
              reload={reload}
              onCreate={() => void create({ ...props, reload, openItem })}
            />
          )}
        </Loading>
      )}
    </div>
  );
}

async function create(
  context: Props & {
    readonly reload: () => void;
    readonly openItem: (item: RemoteDocumentSummary | undefined) => void;
  },
) {
  const { projectPath, selection } = context;
  const made = await createRemoteDocument(
    projectPath,
    selection.connection.id,
    selection.collection,
  );
  if (made.ok) {
    context.reload();
    context.openItem(made.value);
  }
}

// The table: search, select-to-delete, new item, and drag where the CMS keeps order.
function ItemTable(
  props: Props & {
    readonly list: RemoteDocumentList;
    readonly onOpen: (item: RemoteDocumentSummary) => void;
    readonly onMoved: (list: RemoteDocumentList) => void;
    readonly reload: () => void;
    readonly onCreate: () => void;
  },
) {
  const { selection, list } = props;
  const icon = typeIcons(selection.connection.id).get(selection.collection);
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<ReadonlySet<string> | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const shown = useMemo(() => matching(list.documents, query), [list.documents, query]);
  const draggable = list.orderable && query === '' && chosen === undefined;
  const reorder = useListReorder({
    count: shown.length,
    disabled: !draggable,
    onMove: (from, to) => void move({ ...props, from, to, setError }),
  });
  const remove = async () => {
    const ids = [...(chosen ?? [])];
    setChosen(undefined);
    setError(await deleteChosen({ ...props, ids }));
  };
  return (
    <div className="remote-cms-table-view">
      <TableHead
        title={labelize(selection.collection)}
        query={query}
        onQuery={setQuery}
        chosen={chosen}
        onChoose={setChosen}
        onDelete={() => void remove()}
        onCreate={props.onCreate}
        onClose={() => props.onSelect(undefined)}
      />
      {error && <ErrorToast message={error} />}
      <div className="remote-cms-table" role="table">
        <div className="remote-cms-row remote-cms-row-head" role="row">
          <span />
          <span>Name</span>
          <span>Status</span>
          <span>Updated</span>
        </div>
        {shown.map((item, index) => (
          <div
            key={item.id}
            role="row"
            className={`remote-cms-row ${reorder.rowClass(index)}`}
            {...(draggable ? reorder.rowProps(index) : {})}
            onMouseEnter={() =>
              prefetchDocument(props.projectPath, selection.connection.id, item.id)
            }
            onClick={() => (chosen ? setChosen(toggled(chosen, item.id)) : props.onOpen(item))}
          >
            <RowLead chosen={chosen?.has(item.id)} draggable={draggable} />
            <RowCells item={item} icon={icon} />
          </div>
        ))}
        {shown.length === 0 && <p className="remote-cms-note">No items match “{query}”.</p>}
      </div>
    </div>
  );
}

function TableHead(props: {
  readonly title: string;
  readonly query: string;
  readonly onQuery: (query: string) => void;
  readonly chosen: ReadonlySet<string> | undefined;
  readonly onChoose: (chosen: ReadonlySet<string> | undefined) => void;
  readonly onDelete: () => void;
  readonly onCreate: () => void;
  readonly onClose: () => void;
}) {
  const { chosen } = props;
  return (
    <div className="cms-detail-head remote-cms-toolbar">
      <button className="ghost cms-back" title="Close" onClick={props.onClose}>
        <CloseIcon size={13} />
      </button>
      <span className="cms-detail-title">{props.title}</span>
      <label className="remote-cms-search">
        <SearchIcon size={12} />
        <input
          value={props.query}
          placeholder={`Search ${props.title.toLowerCase()}…`}
          onChange={(event) => props.onQuery(event.target.value)}
        />
      </label>
      {chosen ? (
        <>
          <button className="danger" disabled={chosen.size === 0} onClick={props.onDelete}>
            <TrashIcon size={12} /> Delete {chosen.size || ''}
          </button>
          <button onClick={() => props.onChoose(undefined)}>Done</button>
        </>
      ) : (
        <button onClick={() => props.onChoose(new Set())}>Select…</button>
      )}
      <button className="primary" onClick={props.onCreate}>
        <PlusIcon size={12} /> New item
      </button>
    </div>
  );
}

// A row's preview, status and date.
function RowCells(props: {
  readonly item: RemoteDocumentSummary;
  readonly icon: string | undefined;
}) {
  const { item } = props;
  return (
    <>
      <ItemPreview item={item} icon={props.icon} />
      <span className={`remote-cms-status is-${item.status}`}>{STATUS_LABELS[item.status]}</span>
      <span className="remote-cms-date">{shortDate(item.updatedAt)}</span>
    </>
  );
}

function RowLead(props: { readonly chosen: boolean | undefined; readonly draggable: boolean }) {
  if (props.chosen !== undefined) {
    return <input type="checkbox" readOnly checked={props.chosen} tabIndex={-1} />;
  }
  return <span className="remote-cms-grip">{props.draggable && <DragIcon size={12} />}</span>;
}

// The narrow column beside an open item: names only, the open one lit.
function ItemColumn(props: {
  readonly projectPath: string;
  readonly list: RemoteDocumentList | undefined;
  readonly selection: RemoteCmsSelection;
  readonly onOpen: (item: RemoteDocumentSummary) => void;
  readonly onCreate: () => void;
}) {
  return (
    <div className="cms-items">
      <div className="cms-items-head">
        <span className="cms-items-title">{labelize(props.selection.collection)}</span>
        <button className="ghost" title="New item" onClick={props.onCreate}>
          <PlusIcon size={14} />
        </button>
      </div>
      <div className="cms-item-list">
        {(props.list?.documents ?? []).map((item) => (
          <div
            key={item.id}
            className={`cms-item ${item.id === props.selection.item?.id ? 'on' : ''}`}
            onMouseEnter={() =>
              prefetchDocument(props.projectPath, props.selection.connection.id, item.id)
            }
            onClick={() => props.onOpen(item)}
          >
            <ItemPreview
              item={item}
              icon={typeIcons(props.selection.connection.id).get(props.selection.collection)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// An item as the CMS's own list shows it: its picture, its title, and the line under it.
function ItemPreview(props: {
  readonly item: RemoteDocumentSummary;
  /** The type's Sanity icon, shown where the item has no picture, as the Studio does. */
  readonly icon: string | undefined;
}) {
  const { item } = props;
  return (
    <span className="remote-cms-preview">
      {!item.imageURL && props.icon && (
        <span className="remote-cms-preview-media is-icon">
          <SanityTypeIcon symbol={props.icon} size={14} />
        </span>
      )}
      {item.imageURL && (
        <img
          className="remote-cms-preview-media"
          src={`${item.imageURL}?w=96&h=96&fit=crop&auto=format`}
          alt=""
          loading="lazy"
          draggable={false}
        />
      )}
      <span className="remote-cms-preview-text">
        <span className="remote-cms-name">{item.title}</span>
        {item.subtitle && <span className="remote-cms-subtitle">{item.subtitle}</span>}
      </span>
    </span>
  );
}

async function move(
  context: Props & {
    readonly list: RemoteDocumentList;
    readonly onMoved: (list: RemoteDocumentList) => void;
    readonly from: number;
    readonly to: number;
    readonly setError: (message: string | undefined) => void;
  },
) {
  const { documents } = context.list;
  const item = documents[context.from];
  if (!item || context.from === context.to || context.from + 1 === context.to) {
    return;
  }
  const rest = documents.filter((entry) => entry.id !== item.id);
  const at = context.to > context.from ? context.to - 1 : context.to;
  // Shown in its new place at once; the CMS's own order replaces it on reply.
  context.onMoved({ ...context.list, documents: [...rest.slice(0, at), item, ...rest.slice(at)] });
  const moved = await moveRemoteDocument(context.projectPath, context.selection.connection.id, {
    collection: context.selection.collection,
    id: item.id,
    after: rest[at - 1]?.id,
    before: rest[at]?.id,
  });
  context.setError(moved.ok ? undefined : moved.message);
  context.onMoved(moved.ok ? moved.value : context.list);
}

async function deleteChosen(
  context: Props & {
    readonly list: RemoteDocumentList;
    readonly ids: readonly string[];
    readonly reload: () => void;
    readonly onMoved: (list: RemoteDocumentList) => void;
  },
): Promise<string | undefined> {
  const names = context.list.documents.filter((item) => context.ids.includes(item.id));
  const confirmed = await confirmDialog({
    title: names.length === 1 ? `Delete “${names[0]?.title}”?` : `Delete ${names.length} items?`,
    body:
      `${names
        .slice(0, 5)
        .map((item) => item.title)
        .join(', ')}` +
      `${names.length > 5 ? ' and more' : ''} will be deleted from ` +
      `${context.selection.connection.label}, published and draft. Sanity keeps their history.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!confirmed || names.length === 0) {
    return undefined;
  }
  // Gone from the list at once; the CMS's own list replaces this on reply.
  context.onMoved({
    ...context.list,
    documents: context.list.documents.filter((item) => !context.ids.includes(item.id)),
  });
  const deleted: RemoteResult<number> = await deleteRemoteDocuments(
    context.projectPath,
    context.selection.connection.id,
    names.map((item) => item.id),
  );
  context.reload();
  return deleted.ok ? undefined : deleted.message;
}

function matching(
  items: readonly RemoteDocumentSummary[],
  query: string,
): readonly RemoteDocumentSummary[] {
  const words = query.toLowerCase().trim();
  return words ? items.filter((item) => item.title.toLowerCase().includes(words)) : items;
}

function toggled(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set);
  if (!next.delete(id)) {
    next.add(id);
  }
  return next;
}

function shortDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
