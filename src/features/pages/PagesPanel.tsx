import { PageTreeRenameDialog } from './PageTreeRenameDialog';
import { can } from '../../../shared/properties/projectRoles';
import { useCurrentRole } from '../../lib/useCurrentRole';
import type { PageRename } from '../../../shared/properties/pageRename';
import { useTreeDragCleanup } from '../../ui/TreeDragDrop';
import { useProjectPageOrder } from './pageOrderPersistence';
import { usePageOrderDrag } from './usePageOrderDrag';
import { PageOrderNotice } from './PageOrderNotice';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { WireInjectedRoute } from '../../../shared/ipc/ipcResults';
import type { ScanPage, ScanResult } from '../../../shared/properties/projectScan';
import { buildPageTree, collectPageTreeDirectories, pageDirectory, parsePageDragText } from './pageTree';
import { pageDisplayLabel } from '../../lib/pageName';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { ENGLISH_TRANSLATE } from '../../../shared/properties/i18n/englishTranslator';
import type { Translator } from '../../../shared/properties/i18n/messageRef';
import { comparePageNames, isCollectionRoute } from './pageOrder';
import { CmsIcon, FileIcon, FolderIcon, FolderPlusIcon, PlusIcon } from '../../ui/Icons';
import MoreMenu from '../../ui/MoreMenu';
import type { ConnectionKeyCopy, PageTemplateDraft } from '../../../shared/properties/pageTemplate';
import { NewPageModal } from './PageDialogs';
import { PageTemplateDialog, type ConnectSanity } from './PageTemplateDialog';
import { EmDashTemplateDialog } from './EmDashTemplateDialog';
import { EMDASH_HOST, readEmDashProject } from '../../ipc/emdashBridge';
import { PageSearchPath } from './PageSearchPath';
import { PageTreeView, type PageEditing, type PageSelectionView, type PageTreeActions } from './PageTreeView';
import { PageSelectBox, PageSelectionBar } from './PageSelectionBar';
import { usePageBulkRemoveFlow, type PageBulkRemoveHost } from './PageBulkRemoveFlow';
import { usePageSelection, type PageSelectionModel } from './usePageSelection';
import { selectionCount, selectionTargets } from './pageSelection';
import './pageSelect.css';

interface PagesPanelProps {
  readonly projectPath?: string;
  readonly scan: Pick<ScanResult, 'pages' | 'pageFolders' | 'layouts'>;
  readonly currentPage: ScanPage | undefined;
  readonly injectedRoutes?: readonly WireInjectedRoute[];
  readonly onSelectRoute?: (route: WireInjectedRoute) => void;
  readonly onSelect: (page: ScanPage) => void;
  readonly onCreate: (name: string, layout: string | undefined) => void;
  /** Creates a page template, answering what went wrong, if anything. */
  readonly onCreateTemplate: (draft: PageTemplateDraft, keyCopy: ConnectionKeyCopy | undefined) => Promise<string | undefined>;
  readonly connectSanity: ConnectSanity;
  readonly onMovePage: (page: ScanPage, to: string) => void;
  readonly onCreateFolder: () => Promise<string | undefined>;
  readonly onRename: (change: PageRename) => Promise<void>;
  readonly onRenameFolder: (from: string, to: string) => void;
  /** Deletes the ticked pages and folders as one undoable step (Select mode); without it the panel has no Select button. */
  readonly bulkRemove?: PageBulkRemoveHost;
  /** Draws the Page settings dialog for a page (the gear on its row); without it the row opens the rename dialog. */
  readonly renderPageSettings?: (page: ScanPage, close: () => void) => React.ReactNode;
}

export default function PagesPanel(props: PagesPanelProps) {
  const translate = useTranslate();
  const ordering = useProjectPageOrder(props.projectPath);
  const reorder = usePageOrderDrag({
    order: ordering.state.order,
    enabled: ordering.state.kind === 'ready',
    save: ordering.save,
  });
  const model = usePagesPanel(props);
  const {
    showNew,
    setShowNew,
    showTemplate,
    setShowTemplate,
    showEmDash,
    setShowEmDash,
    emdashPresent,
    query,
    setQuery,
    tree,
    searchResults,
    collapsed,
    editing,
    dropDirectory,
    setDropDirectory,
    actions,
    openFolder,
  } = model;
  const selection = usePageSelection({ tree, order: ordering.state.order, collapsed, searchResults });
  const removal = usePageBulkRemoveFlow(props.bulkRemove, selection.stop);
  const selectionView = useSelectionView(selection);
  const keys = usePageSelectionKeys(selection);

  return (
    <div className={`panel-section grow ${selection.active ? 'pages-select-mode' : ''}`} tabIndex={selection.active ? -1 : undefined} onKeyDown={keys}>
      <PagesHeader
        createFolder={() => void openFolder()}
        createPage={() => setShowNew(true)}
        createTemplate={() => setShowTemplate(true)}
        createEmDashTemplate={emdashPresent ? () => setShowEmDash(true) : undefined}
        selecting={selection.active}
        toggleSelecting={props.bulkRemove === undefined ? undefined : selection.active ? selection.stop : selection.start}
      />
      <div style={{ padding: '0 12px 8px' }}>
        <input
          value={query}
          maxLength={512}
          placeholder={translate('pages.panel.search')}
          spellCheck={false}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </div>
      <PageEditingDialog editing={editing} props={props} close={() => actions.setEditing({ kind: 'none' })} />
      <PageOrderNotice state={ordering.state} reload={ordering.reload} />
      <PageBody
        order={ordering.state.order}
        reorder={reorder}
        {...props}
        tree={tree}
        query={query}
        searchResults={searchResults}
        collapsed={collapsed}
        editing={editing}
        dropDirectory={dropDirectory}
        actions={actions}
        selection={selectionView}
        clearDrop={() => setDropDirectory(undefined)}
      />
      {selection.active && (
        <PageSelectionBar
          count={selectionCount(selection.selected)}
          allShown={selection.allShown}
          someShown={selection.selected.size > 0}
          busy={removal.busy}
          toggleAll={selection.toggleAll}
          remove={() => void removal.run(selectionTargets(selection.selected))}
          cancel={selection.stop}
        />
      )}
      {showNew && (
        <NewPageModal
          layouts={props.scan.layouts}
          onClose={() => setShowNew(false)}
          onCreate={(name, layout) => {
            setShowNew(false);
            props.onCreate(name, layout);
          }}
        />
      )}
      {showEmDash && props.projectPath !== undefined && (
        <EmDashTemplateDialog
          projectPath={props.projectPath}
          layouts={props.scan.layouts}
          onClose={() => setShowEmDash(false)}
          onCreate={(draft) => props.onCreateTemplate(draft, undefined)}
        />
      )}
      {showTemplate && props.projectPath !== undefined && (
        <PageTemplateDialog
          projectPath={props.projectPath}
          layouts={props.scan.layouts}
          onClose={() => setShowTemplate(false)}
          onCreate={props.onCreateTemplate}
          connectSanity={props.connectSanity}
        />
      )}
    </div>
  );
}

// A page opens its settings where the host draws them; a folder, or a host without settings, opens the rename dialog.
function PageEditingDialog({ editing, props, close }: { readonly editing: PageEditing; readonly props: PagesPanelProps; readonly close: () => void }) {
  const render = props.renderPageSettings;
  if (editing.kind === 'page' && render !== undefined) {
    const page = props.scan.pages.find((entry) => entry.path === editing.key);
    return page === undefined ? undefined : <React.Fragment key={page.path}>{render(page, close)}</React.Fragment>;
  }
  return <PageTreeRenameDialog editing={editing} scan={props.scan} save={props.onRename} close={close} />;
}

function usePagesPanel(props: PagesPanelProps) {
  const translate = useTranslate();
  const [showNew, setShowNew] = useState(false);
  const [showTemplate, setShowTemplate] = useState(false);
  const [showEmDash, setShowEmDash] = useState(false);
  const emdashPresent = useEmDashPresent(props.projectPath);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [editing, setEditing] = useState<PageEditing>({ kind: 'none' });
  const [dropDirectory, setDropDirectory] = useState<string | undefined>(undefined);
  useTreeDragCleanup(() => setDropDirectory(undefined));
  const tree = useMemo(() => buildPageTree(props.scan.pages, props.scan.pageFolders), [props.scan.pageFolders, props.scan.pages]);
  const directories = useMemo(() => collectPageTreeDirectories(tree), [tree]);
  const searchResults = useMemo(() => pagesForQuery(props.scan.pages, query, translate), [props.scan.pages, query, translate]);
  const { onCreateFolder } = props;

  useEffect(() => {
    setCollapsed((previous) => new Set([...previous].filter((rel) => directories.has(rel))));
    setEditing((previous) => validEditing(previous, props.scan.pages, directories));
    setDropDirectory((previous) => (previous !== undefined && directories.has(previous) ? previous : undefined));
  }, [directories, props.scan.pages]);

  const actions = usePageTreeActions(props, setCollapsed, setEditing, setDropDirectory);
  const openFolder = useCallback(async () => {
    const rel = await onCreateFolder();
    if (rel) {
      setEditing({ kind: 'folder', key: rel });
    }
  }, [onCreateFolder]);

  return {
    showNew,
    setShowNew,
    showTemplate,
    setShowTemplate,
    showEmDash,
    setShowEmDash,
    emdashPresent,
    query,
    setQuery,
    tree,
    searchResults,
    collapsed,
    editing,
    dropDirectory,
    setDropDirectory,
    actions,
    openFolder,
  };
}

function usePageTreeActions(
  props: PagesPanelProps,
  setCollapsed: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>,
  setEditing: React.Dispatch<React.SetStateAction<PageEditing>>,
  setDropDirectory: React.Dispatch<React.SetStateAction<string | undefined>>,
): PageTreeActions {
  const toggleFolder = useCallback(
    (rel: string) => {
      setCollapsed((previous) => {
        const next = new Set(previous);
        if (next.has(rel)) {
          next.delete(rel);
        } else {
          next.add(rel);
        }
        return next;
      });
    },
    [setCollapsed],
  );
  const dragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>, rel: string) => {
      if (event.dataTransfer.types.includes('avb/page')) {
        event.preventDefault();
        event.stopPropagation();
        setDropDirectory(rel);
      }
    },
    [setDropDirectory],
  );
  const drop = useCallback(
    (event: React.DragEvent<HTMLDivElement>, rel: string) => {
      event.preventDefault();
      event.stopPropagation();
      setDropDirectory(undefined);
      moveDroppedPage(event, rel, props.scan.pages, props.onMovePage);
    },
    [props.onMovePage, props.scan.pages, setDropDirectory],
  );
  return {
    select: props.onSelect,
    movePage: props.onMovePage,
    renameFolder: props.onRenameFolder,
    setEditing,
    toggleFolder,
    dragOver,
    drop,
  };
}

function moveDroppedPage(
  event: React.DragEvent<HTMLDivElement>,
  rel: string,
  pages: readonly ScanPage[],
  movePage: (page: ScanPage, to: string) => void,
): void {
  const payload = parsePageDragText(event.dataTransfer.getData('avb/page'));
  if (!payload || pageDirectory(payload.name) === rel) {
    return;
  }
  const page = pages.find((item) => item.path === payload.path && item.name === payload.name);
  const base = page?.name.split('/').at(-1);
  if (page && base) {
    movePage(page, rel ? `${rel}/${base}` : base);
  }
}

interface PageBodyProps extends PagesPanelProps {
  readonly order: import('../../../shared/properties/pageOrder').PageOrder;
  readonly reorder: import('./usePageOrderDrag').PageOrderDrag;
  readonly tree: ReturnType<typeof buildPageTree>;
  readonly query: string;
  readonly searchResults: readonly ScanPage[] | undefined;
  readonly collapsed: ReadonlySet<string>;
  readonly editing: PageEditing;
  readonly dropDirectory: string | undefined;
  readonly actions: PageTreeActions;
  readonly selection: PageSelectionView | undefined;
  readonly clearDrop: () => void;
}

function PageBody(props: PageBodyProps) {
  const translate = useTranslate();
  return (
    <div
      className={`panel-body ${props.dropDirectory === '' && props.reorder.target === undefined ? 'pages-root-drop' : ''}`}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) {
          props.clearDrop();
        }
      }}
      onDragOver={(event) => props.searchResults === undefined && props.actions.dragOver(event, '')}
      onDrop={(event) => props.searchResults === undefined && props.actions.drop(event, '')}
    >
      {props.searchResults ? (
        <SearchResults pages={props.searchResults} query={props.query} currentPage={props.currentPage} select={props.onSelect} selection={props.selection} />
      ) : (
        <>
          <PageTreeView
            order={props.order}
            reorder={props.reorder}
            node={props.tree}
            rel=""
            depth={0}
            currentPage={props.currentPage}
            collapsed={props.collapsed}
            editing={props.editing}
            dropDirectory={props.dropDirectory}
            actions={props.actions}
            selection={props.selection}
          />
          {props.scan.pages.length === 0 && props.scan.pageFolders.length === 0 && (props.injectedRoutes?.length ?? 0) === 0 && (
            <div className="props-empty">{translate('pages.panel.empty')}</div>
          )}
          <InjectedRoutes routes={props.injectedRoutes ?? []} currentPage={props.currentPage} select={props.onSelectRoute} />
        </>
      )}
    </div>
  );
}

function SearchResults({
  pages,
  query,
  currentPage,
  select,
  selection,
}: {
  readonly pages: readonly ScanPage[];
  readonly query: string;
  readonly currentPage: ScanPage | undefined;
  readonly select: (page: ScanPage) => void;
  readonly selection: PageSelectionView | undefined;
}) {
  const translate = useTranslate();
  if (pages.length === 0) {
    return <div className="props-empty">{translate('pages.panel.noMatch', { query: query.trim() })}</div>;
  }
  return pages.map((page) => {
    const refusal = selection?.index.refused.get(page.name);
    const ticked = selection?.selected.has(page.name) === true;
    return (
      <div
        key={page.path}
        className={`list-item ${isCollectionRoute(page.name) ? 'collection' : ''} ${selection === undefined && currentPage?.path === page.path ? 'active' : ''} ${selection === undefined ? '' : `page-selecting ${ticked ? 'page-selected' : ''} ${refusal === undefined ? '' : 'page-refused'}`}`}
        title={refusal === undefined ? undefined : translate('pages.settings.delete.homeRefused')}
        onClick={(event) => (selection === undefined ? select(page) : selection.click(page.name, event.shiftKey))}
      >
        {selection !== undefined && (
          <PageSelectBox
            checked={ticked}
            partial={false}
            refusal={refusal}
            label={translate('pages.select.row', { name: pageDisplayLabel(page, translate) })}
          />
        )}
        <span className="icon">{isCollectionRoute(page.name) ? <CmsIcon size={13} /> : <FileIcon size={13} />}</span>
        <span className="page-list-copy">
          <span className="label">{pageDisplayLabel(page, translate)}</span>
          <PageSearchPath path={page.route} query={query} />
        </span>
      </div>
    );
  });
}

function InjectedRoutes({
  routes,
  currentPage,
  select,
}: {
  readonly routes: readonly WireInjectedRoute[];
  readonly currentPage: ScanPage | undefined;
  readonly select: ((route: WireInjectedRoute) => void) | undefined;
}) {
  const translate = useTranslate();
  // Collapsed until asked: these are an integration's pages, which are not the project's own.
  const [open, setOpen] = useState(false);
  if (routes.length === 0) {
    return undefined;
  }
  return (
    <div className="vars-table pages-injected">
      <h3
        className="list-item folder pages-injected-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setOpen(!open);
          }
        }}
      >
        <span className="icon">
          <FolderIcon size={13} />
        </span>
        <span className="label">{translate('pages.injected.from', { source: routes[0]?.from ?? translate('pages.injected.integrations') })}</span>
        <span className="sub">{translate('pages.injected.count', { count: String(routes.length) })}</span>
      </h3>
      {open &&
        routes.map((route) => (
          <div
            key={route.route}
            className={`list-item ${currentPage?.route === route.route ? 'active' : ''}`}
            style={{ paddingLeft: 22 }}
            title={`${route.route}${route.entrypoint ? `\n${route.entrypoint}` : ''}`}
            onClick={() => select?.(route)}
          >
            <span className="icon">
              <FileIcon size={13} />
            </span>
            <span className="label">{route.route}</span>
          </div>
        ))}
    </div>
  );
}

// The two things `+` makes. A template gets the CMS icon its rows have in the tree.
export function pageCreateMenuItems(
  actions: { readonly createPage: () => void; readonly createTemplate: () => void; readonly createEmDashTemplate?: (() => void) | undefined },
  translate: Translator = ENGLISH_TRANSLATE,
) {
  const emdash = actions.createEmDashTemplate;
  return [
    { label: translate('pages.create.page'), icon: <FileIcon size={13} />, onSelect: actions.createPage },
    { label: translate('pages.create.template'), icon: <CmsIcon size={13} />, onSelect: actions.createTemplate },
    // Only a project that uses EmDash is offered its template: its types come from EmDash itself.
    ...(emdash === undefined ? [] : [{ label: translate('emdash.template.menu'), icon: <CmsIcon size={13} />, onSelect: emdash }]),
  ];
}

/** Whether the project uses EmDash, read once per project; false where the host cannot read it. */
function useEmDashPresent(projectPath: string | undefined): boolean {
  const [present, setPresent] = useState(false);
  useEffect(() => {
    let current = true;
    if (EMDASH_HOST.available && projectPath !== undefined) {
      readEmDashProject(projectPath).then(
        (project) => current && setPresent(project.kind === 'present'),
        () => current && setPresent(false),
      );
    }
    return () => {
      current = false;
    };
  }, [projectPath]);
  return present;
}

function PagesHeader({
  createFolder,
  createPage,
  createTemplate,
  createEmDashTemplate,
  selecting,
  toggleSelecting,
}: {
  readonly createFolder: () => void;
  readonly createPage: () => void;
  readonly createTemplate: () => void;
  readonly createEmDashTemplate: (() => void) | undefined;
  readonly selecting: boolean;
  /** Turns Select mode on or off; absent where the host cannot delete several pages. */
  readonly toggleSelecting: (() => void) | undefined;
}) {
  // Creating and deleting pages appear only for a role that may (shared/properties/projectRoles.ts).
  const translate = useTranslate();
  const role = useCurrentRole();
  const creatable = can(role, 'page:create');
  const deletable = can(role, 'page:delete') && toggleSelecting !== undefined;
  return (
    <div className="panel-header">
      <h2>{translate('pages.title')}</h2>
      {(creatable || deletable) && (
        <div style={{ display: 'flex', gap: 2 }}>
          {deletable && (
            <button
              className="asset-select-link"
              aria-label={translate(selecting ? 'pages.select.stop' : 'pages.select.start')}
              aria-pressed={selecting}
              title={translate(selecting ? 'pages.select.stopTitle' : 'pages.select.startTitle')}
              onClick={toggleSelecting}
            >
              {translate(selecting ? 'pages.select.stop' : 'pages.select.start')}
            </button>
          )}
          {creatable && !selecting && (
            <>
              <button className="ghost" title={translate('pages.folder.new')} onClick={createFolder}>
                <FolderPlusIcon size={13} />
              </button>
              <MoreMenu
                className="ghost"
                title={translate('pages.new.button')}
                icon={<PlusIcon size={13} />}
                width={190}
                items={pageCreateMenuItems({ createPage, createTemplate, createEmDashTemplate }, translate)}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

// What the rows draw of the mode: nothing at all while it is off, so an ordinary panel does no selection work.
function useSelectionView(selection: PageSelectionModel): PageSelectionView | undefined {
  const { active, selected, partial, index, click } = selection;
  return useMemo(() => (active ? { selected, partial, index, click } : undefined), [active, click, index, partial, selected]);
}

// Esc leaves the mode; Cmd or Ctrl and A ticks every row shown, unless a text field has the keys (the search box keeps its own select all).
function usePageSelectionKeys(selection: PageSelectionModel) {
  const { active, stop, selectAll } = selection;
  return useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (!active) {
        return;
      }
      if (event.key === 'Escape') {
        event.stopPropagation();
        stop();
        return;
      }
      const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a' && !typing) {
        event.preventDefault();
        selectAll();
      }
    },
    [active, selectAll, stop],
  );
}

function pagesForQuery(pages: readonly ScanPage[], query: string, translate: Translator): readonly ScanPage[] | undefined {
  const clean = query.trim().toLowerCase();
  if (!clean) {
    return undefined;
  }
  return pages
    .filter((page) => [page.name, page.route, pageDisplayLabel(page, translate)].some((value) => value.toLowerCase().includes(clean)))
    .sort((left, right) => comparePageNames(left.name, right.name));
}

function validEditing(editing: PageEditing, pages: readonly ScanPage[], directories: ReadonlySet<string>): PageEditing {
  if (editing.kind === 'page') {
    return pages.some((page) => page.path === editing.key) ? editing : { kind: 'none' };
  }
  if (editing.kind === 'folder') {
    return directories.has(editing.key) ? editing : { kind: 'none' };
  }
  return editing;
}
