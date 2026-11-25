// A connected CMS's collection in the main view, laid out the way a CMS lists
// its items: a table with search, multi-select to delete, and "New item"; where
// the CMS keeps an order (Sanity's orderable plugin), rows drag into a new one.
// Opening an item narrows the table to a column of names beside its fields
// (RemoteItemFields.tsx). Field edits are drafts; deleting and reordering act as
// the CMS's own editor does (sanityEdits.ts), deleting only after a confirm.
import { useMemo, useState, type CSSProperties } from 'react';
import type { Formatters } from '../../../shared/core/i18n/format';
import { useFormat, useLocale, useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import type { DescribedTranslator, Translator } from '../../lib/i18n/localeContext';
import { RemoteColumnPicker } from './RemoteColumnPicker';
import { RemoteCollectionSettings } from './RemoteCollectionSettings';
import { cellText, nextSort, sortItems, tableGrid, useColumnChoice, type RemoteColumn, type RemoteSort, type RemoteSortKey } from './remoteColumns';
import './remoteCms.css';
import { ChevronDownIcon, ChevronLeftIcon, CmsIcon, DragIcon, ElementImageIcon, PlusIcon, SearchIcon, TrashIcon } from '../../ui/Icons';
import { ErrorToast } from '../../ui/ErrorToast';
import { reportErrorToast } from '../../ui/errorNotices';
import { confirmDialog } from '../../ui/ConfirmDialog';
import useListReorder from '../../ui/useListReorder';
import { moveRemoteDocument } from '../../ipc/cmsConnectionsBridge';
import { deleteRemoteDocuments, remoteDocuments, remoteTemplate } from '../../ipc/remoteSource';
import { duplicateOf, RemotePendingItem, type PendingItem } from './RemotePendingItem';
import type { RemoteDocumentList, RemoteDocumentSummary, RemoteResult } from '../../../shared/properties/cmsRemote';
import { labelize } from './cmsSchema';
import { STATUS_KEYS } from './RemoteCmsBrowser';
import { isAstroContent } from '../../../shared/properties/astroContent';
import AssetThumb from '../../ui/AssetThumb';
import { ProjectImagesScope, useProjectImage } from './projectImages';
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
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  // Kept across opens and refreshed behind the view: a delete, a drag or a save
  // shows its result at once and never blanks the list (remoteCmsCache.ts).
  // The fields shown as columns: the list is read with their values (remoteColumns.ts).
  const [columns, setColumns] = useColumnChoice(`${connection.id}:${collection}`);
  const names = columns.map((column) => column.name);
  const { result, retry, replace } = useRemote(DOCUMENT_LISTS, `${listKey(connection.id, collection)}${names.length > 0 ? `|${names.join(',')}` : ''}`, () =>
    remoteDocuments(projectPath, connection.id, collection, names),
  );
  const list = result?.ok ? result.value : undefined;
  const reload = retry;
  // The column waits for the list, so a collection of one item never flashes it.
  // A content collection keeps its column, so a second entry can always be added.
  const single = isAstroContent(connection) ? list === undefined : list === undefined || list.documents.length <= 1;
  // A new item, or a copy, being made: in memory until Create (RemotePendingItem.tsx).
  const [pending, setPending] = useState<PendingItem | undefined>(undefined);
  // Opening any item leaves a new one uncreated.
  const openItem = (item: RemoteDocumentSummary | undefined) => {
    setPending(undefined);
    props.onSelect({ ...selection, item: item && { id: item.id, title: item.title } });
  };
  const startNew = () => void newItem({ ...props, setPending }, translate, translateDescribed);
  return (
    <ProjectImagesScope projectPath={projectPath} source={connection}>
      <div className={`cms-view remote-cms-view ${props.hidden ? 'hidden' : ''}`}>
        {selection.mode === 'settings' ? (
          <RemoteCollectionSettings projectPath={projectPath} selection={selection} onSelect={props.onSelect} onSaved={reload} />
        ) : selection.item !== undefined || pending !== undefined ? (
          <OpenItem {...props} list={list} single={single} pending={pending} setPending={setPending} openItem={openItem} reload={reload} onCreate={startNew} />
        ) : (
          <Loading result={result} retry={retry}>
            {(loaded) => (
              <ItemTable
                {...props}
                columns={columns}
                onColumns={setColumns}
                list={loaded}
                onOpen={openItem}
                onMoved={replace}
                reload={reload}
                onCreate={startNew}
              />
            )}
          </Loading>
        )}
      </div>
    </ProjectImagesScope>
  );
}

// An item open beside the column of names: a stored one, or one being made.
function OpenItem(
  props: Props & {
    readonly list: RemoteDocumentList | undefined;
    /** One item has nothing to choose between or return to: its fields fill the view. */
    readonly single: boolean;
    readonly pending: PendingItem | undefined;
    readonly setPending: (pending: PendingItem | undefined) => void;
    readonly openItem: (item: RemoteDocumentSummary | undefined) => void;
    readonly reload: () => void;
    readonly onCreate: () => void;
  },
) {
  const { projectPath, selection, pending, single } = props;
  const translate = useTranslate();
  const back = single ? undefined : () => props.openItem(undefined);
  return (
    <>
      {!single && (
        <ItemColumn
          projectPath={projectPath}
          list={props.list}
          selection={selection}
          onOpen={props.openItem}
          onCreate={props.onCreate}
          onClose={() => props.onSelect(undefined)}
        />
      )}
      {pending ? (
        <RemotePendingItem
          projectPath={projectPath}
          selection={selection}
          pending={pending}
          onChange={props.setPending}
          onBack={back}
          onCancel={() => props.setPending(undefined)}
          onCreated={(item) => {
            props.reload();
            props.openItem(item);
          }}
        />
      ) : (
        <RemoteItemFields
          projectPath={projectPath}
          selection={selection}
          onBack={back}
          onRemoved={() => props.openItem(undefined)}
          onSaved={props.reload}
          onDuplicate={(document) => props.setPending(duplicateOf(document, selection.item?.title ?? translate('cmsRemote.common.item'), translate))}
          onRenamed={(item) => {
            props.reload();
            props.onSelect({ ...selection, item });
          }}
        />
      )}
    </>
  );
}

// A new item opens as its collection's template: nothing is written until Create.
async function newItem(
  context: Props & { readonly setPending: (pending: PendingItem | undefined) => void },
  translate: Translator,
  translateDescribed: DescribedTranslator,
) {
  const { projectPath, selection } = context;
  const template = await remoteTemplate(projectPath, selection.connection.id, selection.collection);
  if (template.ok) {
    context.setPending({ title: translate('cmsRemote.view.newItem'), document: template.value });
  } else {
    // A config that will not load, a file too large to save: said where the person looks.
    reportErrorToast(translateDescribed(template));
  }
}

// The table: search, select-to-delete, new item, and drag where the CMS keeps order.
function ItemTable(
  props: Props & {
    readonly columns: readonly RemoteColumn[];
    readonly onColumns: (columns: readonly RemoteColumn[]) => void;
    readonly list: RemoteDocumentList;
    readonly onOpen: (item: RemoteDocumentSummary) => void;
    readonly onMoved: (list: RemoteDocumentList) => void;
    readonly reload: () => void;
    readonly onCreate: () => void;
  },
) {
  const { selection, list } = props;
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const icon = typeIcons(selection.connection.id).get(selection.collection);
  const files = isAstroContent(selection.connection);
  const table = useItemTable(props, translate, translateDescribed);
  const { query, setQuery, chosen, setChosen, error, shown, draggable, lead, reorder } = table;
  const pictures = list.documents.some(hasPicture);
  const shape = { files, lead, columns: props.columns };
  return (
    <div className="remote-cms-table-view">
      <TableHead
        title={labelize(selection.collection)}
        query={query}
        onQuery={setQuery}
        chosen={chosen}
        onChoose={setChosen}
        onDelete={() => void table.remove()}
        onCreate={props.onCreate}
        onClose={() => props.onSelect(undefined)}
      />
      {error && <ErrorToast message={error} />}
      <div className={tableClass(shape)} role="table" style={gridStyle(shape)}>
        {list.documents.length > 0 && <TableColumns {...props} shape={shape} table={table} />}
        {shown.map((item, index) => (
          <div
            key={item.id}
            role="row"
            className={`remote-cms-row ${reorder.rowClass(index)}`}
            {...(draggable ? reorder.rowProps(index) : {})}
            onMouseEnter={() => prefetchDocument(props.projectPath, selection.connection.id, item.id)}
            onClick={() => (chosen ? setChosen(toggled(chosen, item.id)) : props.onOpen(item))}
          >
            {lead && <RowLead chosen={chosen?.has(item.id)} draggable={draggable} />}
            <RowCells item={item} icon={icon} shape={shape} pictures={pictures} />
          </div>
        ))}
        {shown.length === 0 && <EmptyTable title={labelize(selection.collection)} query={query} onCreate={props.onCreate} onClear={() => setQuery('')} />}
      </div>
    </div>
  );
}

// The table's state: its search, what is chosen, and whether rows drag.
function useItemTable(
  props: Props & {
    readonly list: RemoteDocumentList;
    readonly onMoved: (list: RemoteDocumentList) => void;
    readonly reload: () => void;
  },
  translate: Translator,
  translateDescribed: DescribedTranslator,
) {
  const { list } = props;
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<ReadonlySet<string> | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [sort, setSort] = useState<RemoteSort | undefined>(undefined);
  const shown = useMemo(() => sortItems(matching(list.documents, query), sort), [list.documents, query, sort]);
  const choosing = { chosen, ids: shown.map((item) => item.id), onChoose: setChosen };
  // A sorted table shows an order of its own; only the CMS's order can be dragged.
  const draggable = list.orderable && query === '' && chosen === undefined && sort === undefined;
  const lead = chosen !== undefined || draggable; // Without either, rows start at the edge.
  const reorder = useListReorder({
    count: shown.length,
    disabled: !draggable,
    onMove: (from, to) => void move({ ...props, from, to, setError, translateDescribed }),
  });
  const remove = async () => {
    setChosen(undefined);
    setError(await deleteChosen({ ...props, ids: [...(chosen ?? [])], translate, translateDescribed }));
  };
  return {
    sort,
    onSort: (key: RemoteSortKey) => setSort((current) => nextSort(current, key)),
    query,
    setQuery,
    chosen,
    setChosen,
    error,
    shown,
    choosing,
    draggable,
    lead,
    reorder,
    remove,
  };
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
  const translate = useTranslate();
  const { locale } = useLocale();
  if (chosen) {
    // Choosing is its own mode: what is chosen, Delete once there is something, and Cancel.
    return (
      <div className="cms-detail-head remote-cms-toolbar is-choosing">
        <span className="cms-detail-title">
          {chosen.size === 0
            ? translate('cmsRemote.view.selectCollection', { collection: props.title })
            : translate('cmsRemote.view.selected', { count: chosen.size, collection: props.title })}
        </span>
        {chosen.size > 0 && (
          <button className="danger" onClick={props.onDelete}>
            <TrashIcon size={12} /> {translate('cmsRemote.delete.action')}
          </button>
        )}
        <button onClick={() => props.onChoose(undefined)}>{translate('ui.cancel')}</button>
      </div>
    );
  }
  return (
    <div className="cms-detail-head remote-cms-toolbar">
      {/* Beside the collections list, its row closes it again; where the list gives way,
          this is the way back to it (remoteCms.css). */}
      <button className="ghost cms-back remote-cms-collections-back" title={translate('cmsRemote.collection.allCollections')} onClick={props.onClose}>
        <ChevronLeftIcon size={13} />
      </button>
      <span className="cms-detail-title">{props.title}</span>
      <label className="remote-cms-search">
        <SearchIcon size={12} />
        <input
          value={props.query}
          placeholder={translate('cmsRemote.view.search', { collection: props.title.toLocaleLowerCase(locale) })}
          onChange={(event) => props.onQuery(event.target.value)}
        />
      </label>
      <button onClick={() => props.onChoose(new Set())}>{translate('cmsRemote.view.select')}</button>
      <button className="primary" onClick={props.onCreate}>
        <PlusIcon size={12} /> {translate('cmsRemote.view.newItem')}
      </button>
    </div>
  );
}

/** While choosing: what is chosen, the rows shown, and how to change the choice. */
interface Choosing {
  readonly chosen: ReadonlySet<string> | undefined;
  readonly ids: readonly string[];
  readonly onChoose: (chosen: ReadonlySet<string>) => void;
}

/** What decides a table's columns: files have no status, a lead holds boxes or grips. */
interface TableShape {
  readonly files: boolean;
  readonly lead: boolean;
  readonly columns: readonly RemoteColumn[];
}

// The column names, each a button that sorts by it; the pin at the end chooses
// which fields are columns. While choosing, the lead column holds a box that
// chooses every row shown, or none.
function TableColumns(
  props: Props & {
    readonly shape: TableShape;
    readonly table: {
      readonly choosing: Choosing;
      readonly sort: RemoteSort | undefined;
      readonly onSort: (key: RemoteSortKey) => void;
    };
    readonly onColumns: (columns: readonly RemoteColumn[]) => void;
  },
) {
  const { shape, table } = props;
  const translate = useTranslate();
  const sortBy = (key: RemoteSortKey, label: string) => <SortHeader label={label} sortKey={key} sort={table.sort} onSort={table.onSort} />;
  return (
    <div className="remote-cms-row remote-cms-row-head" role="row">
      {shape.lead && <LeadHeader choosing={table.choosing} />}
      {sortBy('title', translate('cmsRemote.view.columnName'))}
      {!shape.files && sortBy('status', translate('cmsRemote.view.columnStatus'))}
      {shape.columns.map((column) => (
        <SortHeader key={column.name} label={column.title} sortKey={`cell:${column.name}`} sort={table.sort} onSort={table.onSort} />
      ))}
      {sortBy('updated', translate('cmsRemote.view.columnUpdated'))}
      <RemoteColumnPicker projectPath={props.projectPath} selection={props.selection} columns={shape.columns} onColumns={props.onColumns} />
    </div>
  );
}

function LeadHeader(props: { readonly choosing: Choosing }) {
  const { chosen, ids } = props.choosing;
  const translate = useTranslate();
  if (chosen === undefined) {
    return <span />;
  }
  const all = ids.length > 0 && ids.every((id) => chosen.has(id));
  return (
    <input
      type="checkbox"
      aria-label={translate('cmsRemote.view.chooseEvery')}
      checked={all}
      onChange={() => props.choosing.onChoose(new Set(all ? [] : ids))}
    />
  );
}

// A column's name, sorting by it: an arrow shows the direction while it does.
function SortHeader(props: {
  readonly label: string;
  readonly sortKey: RemoteSortKey;
  readonly sort: RemoteSort | undefined;
  readonly onSort: (key: RemoteSortKey) => void;
}) {
  const translate = useTranslate();
  const active = props.sort?.key === props.sortKey ? props.sort.direction : undefined;
  return (
    <button
      type="button"
      className={`remote-cms-sort ${active ? `is-${active}` : ''}`}
      title={translate(active === 'ascending' ? 'cmsRemote.view.sortLargest' : 'cmsRemote.view.sortSmallest')}
      onClick={() => props.onSort(props.sortKey)}
    >
      <span>{props.label}</span>
      {active && <ChevronDownIcon size={11} />}
    </button>
  );
}

// Nothing to list: a collection with no items yet offers the first one; a search
// that matched nothing says what was searched and offers to clear it.
function EmptyTable(props: { readonly title: string; readonly query: string; readonly onCreate: () => void; readonly onClear: () => void }) {
  const translate = useTranslate();
  const { locale } = useLocale();
  const searching = props.query.trim().length > 0;
  return (
    <div className="props-empty remote-cms-empty">
      <div className="cms-empty-icon" aria-hidden="true">
        {searching ? <SearchIcon size={22} /> : <CmsIcon size={22} />}
      </div>
      <h3 className="cms-empty-title">
        {searching
          ? translate('cmsRemote.view.emptyNoMatch', { query: props.query.trim() })
          : translate('cmsRemote.view.emptyNone', { collection: props.title.toLocaleLowerCase(locale) })}
      </h3>
      <p>{translate(searching ? 'cmsRemote.view.emptySearchBody' : 'cmsRemote.view.emptyFirstBody')}</p>
      <div className="cms-empty-action">
        {searching ? (
          <button onClick={props.onClear}>{translate('cmsRemote.view.clearSearch')}</button>
        ) : (
          <button className="primary" onClick={props.onCreate}>
            <PlusIcon size={12} /> {translate('cmsRemote.view.newItem')}
          </button>
        )}
      </div>
    </div>
  );
}

// A row's preview, status and date.
function RowCells(props: { readonly item: RemoteDocumentSummary; readonly icon: string | undefined; readonly shape: TableShape; readonly pictures: boolean }) {
  const { item, shape } = props;
  const translate = useTranslate();
  const format = useFormat();
  return (
    <>
      <ItemPreview item={item} icon={props.icon} pictures={props.pictures} />
      {!shape.files && <span className={`remote-cms-status is-${item.status}`}>{translate(STATUS_KEYS[item.status])}</span>}
      {shape.columns.map((column) => (
        <span key={column.name} className="remote-cms-cell">
          {cellText(item.cells?.[column.name], { translate, format })}
        </span>
      ))}
      <span className="remote-cms-date">{shortDate(item.updatedAt, format)}</span>
      {/* Under the header's pin, so every row has the same columns. */}
      <span />
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
  readonly onClose: () => void;
}) {
  const translate = useTranslate();
  const pictures = (props.list?.documents ?? []).some(hasPicture);
  // Built from the table's own parts — its header, its Name row, its rows — so
  // opening an item leaves every name where it was, only narrower.
  return (
    <div className="cms-items remote-cms-column">
      <div className="cms-detail-head remote-cms-toolbar">
        {/* Shown only where the collections list gives way to this one (remoteCms.css). */}
        <button className="ghost remote-cms-collections-back" title={translate('cmsRemote.collection.allCollections')} onClick={props.onClose}>
          <ChevronLeftIcon size={13} />
        </button>
        <span className="cms-detail-title">{labelize(props.selection.collection)}</span>
        <button className="ghost" title={translate('cmsRemote.view.newItem')} onClick={props.onCreate}>
          <PlusIcon size={14} />
        </button>
      </div>
      <div className="remote-cms-table" role="table">
        <div className="remote-cms-row remote-cms-row-head" role="row">
          <span>{translate('cmsRemote.view.columnName')}</span>
        </div>
        {(props.list?.documents ?? []).map((item) => (
          <div
            key={item.id}
            role="row"
            className={`remote-cms-row ${item.id === props.selection.item?.id ? 'on' : ''}`}
            onMouseEnter={() => prefetchDocument(props.projectPath, props.selection.connection.id, item.id)}
            onClick={() => props.onOpen(item)}
          >
            <ItemPreview item={item} icon={typeIcons(props.selection.connection.id).get(props.selection.collection)} pictures={pictures} />
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
  /** Whether other items in the list have a picture, so one without keeps the column. */
  readonly pictures: boolean;
}) {
  const { item } = props;
  const file = useProjectImage(item.imageFile);
  const bare = !item.imageURL && !file;
  return (
    <span className="remote-cms-preview">
      {file && <AssetThumb file={file} className="remote-cms-preview-media" />}
      {bare && props.icon && (
        <span className="remote-cms-preview-media is-icon">
          <SanityTypeIcon symbol={props.icon} size={14} />
        </span>
      )}
      {bare && !props.icon && props.pictures && (
        <span className="remote-cms-preview-media is-icon is-placeholder">
          <ElementImageIcon size={14} />
        </span>
      )}
      {item.imageURL && (
        <img className="remote-cms-preview-media" src={`${item.imageURL}?w=96&h=96&fit=crop&auto=format`} alt="" loading="lazy" draggable={false} />
      )}
      <span className="remote-cms-preview-text">
        <span className="remote-cms-name">{item.title}</span>
        {item.subtitle && <span className="remote-cms-subtitle">{item.subtitle}</span>}
      </span>
    </span>
  );
}

function tableClass(table: TableShape): string {
  const files = table.files ? 'is-files' : '';
  // i18n-ignore: CSS class names.
  return `remote-cms-table has-grid ${files} ${table.lead ? 'has-lead' : ''}`;
}

// The table's grid and the width it scrolls sideways below (remoteColumns.ts), as
// variables the rows read, so many columns scroll rather than squeeze.
function gridStyle(table: TableShape): CSSProperties & { readonly '--remote-cms-grid': string; readonly '--remote-cms-width': string } {
  const grid = tableGrid({ lead: table.lead, status: !table.files, columns: table.columns.length });
  return { '--remote-cms-grid': grid.columns, '--remote-cms-width': `${grid.widthPx}px` };
}

// Whether an item has a picture of its own, a CMS link or a project file.
function hasPicture(item: RemoteDocumentSummary): boolean {
  return Boolean(item.imageURL) || item.imageFile !== undefined;
}

async function move(
  context: Props & {
    readonly list: RemoteDocumentList;
    readonly onMoved: (list: RemoteDocumentList) => void;
    readonly from: number;
    readonly to: number;
    readonly setError: (message: string | undefined) => void;
    readonly translateDescribed: DescribedTranslator;
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
  context.setError(moved.ok ? undefined : context.translateDescribed(moved));
  context.onMoved(moved.ok ? moved.value : context.list);
}

async function deleteChosen(
  context: Props & {
    readonly list: RemoteDocumentList;
    readonly ids: readonly string[];
    readonly reload: () => void;
    readonly onMoved: (list: RemoteDocumentList) => void;
    readonly translate: Translator;
    readonly translateDescribed: DescribedTranslator;
  },
): Promise<string | undefined> {
  const { translate } = context;
  const names = context.list.documents.filter((item) => context.ids.includes(item.id));
  const confirmed = await confirmDialog({
    title:
      names.length === 1
        ? translate('cmsRemote.delete.title', { title: names[0]?.title ?? '' })
        : translate('cmsRemote.delete.titleMany', { count: names.length }),
    body: deletionBody(names, context.selection.connection, translate),
    confirmLabel: translate('cmsRemote.delete.action'),
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
  return deleted.ok ? undefined : context.translateDescribed(deleted);
}

// What deleting says it does: the first five titles, "and more" past them, and where they go.
function deletionBody(names: readonly RemoteDocumentSummary[], connection: RemoteCmsSelection['connection'], translate: Translator): string {
  const titles = names
    .slice(0, 5)
    .map((item) => item.title)
    .join(', ');
  const more = names.length > 5;
  if (isAstroContent(connection)) {
    const note = translate('cmsRemote.delete.filesToTrash');
    return translate(more ? 'cmsRemote.delete.bodyProjectMore' : 'cmsRemote.delete.bodyProject', { titles, note });
  }
  return translate(more ? 'cmsRemote.delete.bodyCmsMore' : 'cmsRemote.delete.bodyCms', { titles, connection: connection.label });
}

function matching(items: readonly RemoteDocumentSummary[], query: string): readonly RemoteDocumentSummary[] {
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

function shortDate(iso: string, format: Formatters): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : format.formatDate(date, { month: 'short', day: 'numeric', year: 'numeric' });
}
