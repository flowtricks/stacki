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
import { PageSearchPath } from './PageSearchPath';
import { PageTreeView, type PageEditing, type PageTreeActions } from './PageTreeView';

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
  readonly onDelete: (page: ScanPage) => void;
  readonly onMovePage: (page: ScanPage, to: string) => void;
  readonly onCreateFolder: () => Promise<string | undefined>;
  readonly onRename: (change: PageRename) => Promise<void>;
  readonly onRenameFolder: (from: string, to: string) => void;
  readonly onDeleteFolder: (rel: string, pageCount: number) => void;
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

  return (
    <div className="panel-section grow">
      <PagesHeader createFolder={() => void openFolder()} createPage={() => setShowNew(true)} createTemplate={() => setShowTemplate(true)} />
      <div style={{ padding: '0 12px 8px' }}>
        <input
          value={query}
          maxLength={512}
          placeholder={translate('pages.panel.search')}
          spellCheck={false}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </div>
      <PageTreeRenameDialog editing={editing} scan={props.scan} save={props.onRename} close={() => actions.setEditing({ kind: 'none' })} />
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
        clearDrop={() => setDropDirectory(undefined)}
      />
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

function usePagesPanel(props: PagesPanelProps) {
  const translate = useTranslate();
  const [showNew, setShowNew] = useState(false);
  const [showTemplate, setShowTemplate] = useState(false);
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
    removePage: props.onDelete,
    movePage: props.onMovePage,
    removeFolder: props.onDeleteFolder,
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
        <SearchResults pages={props.searchResults} query={props.query} currentPage={props.currentPage} select={props.onSelect} />
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
}: {
  readonly pages: readonly ScanPage[];
  readonly query: string;
  readonly currentPage: ScanPage | undefined;
  readonly select: (page: ScanPage) => void;
}) {
  const translate = useTranslate();
  if (pages.length === 0) {
    return <div className="props-empty">{translate('pages.panel.noMatch', { query: query.trim() })}</div>;
  }
  return pages.map((page) => (
    <div
      key={page.path}
      className={`list-item ${isCollectionRoute(page.name) ? 'collection' : ''} ${currentPage?.path === page.path ? 'active' : ''}`}
      onClick={() => select(page)}
    >
      <span className="icon">{isCollectionRoute(page.name) ? <CmsIcon size={13} /> : <FileIcon size={13} />}</span>
      <span className="page-list-copy">
        <span className="label">{pageDisplayLabel(page, translate)}</span>
        <PageSearchPath path={page.route} query={query} />
      </span>
    </div>
  ));
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
  if (routes.length === 0) {
    return undefined;
  }
  return (
    <div className="vars-table pages-injected">
      <h3 className="list-item folder pages-injected-head">
        <span className="icon">
          <FolderIcon size={13} />
        </span>
        <span className="label">{translate('pages.injected.from', { source: routes[0]?.from ?? translate('pages.injected.integrations') })}</span>
        <span className="sub">{translate('pages.injected.previewOnly')}</span>
      </h3>
      {routes.map((route) => (
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
  actions: { readonly createPage: () => void; readonly createTemplate: () => void },
  translate: Translator = ENGLISH_TRANSLATE,
) {
  return [
    { label: translate('pages.create.page'), icon: <FileIcon size={13} />, onSelect: actions.createPage },
    { label: translate('pages.create.template'), icon: <CmsIcon size={13} />, onSelect: actions.createTemplate },
  ];
}

function PagesHeader({
  createFolder,
  createPage,
  createTemplate,
}: {
  readonly createFolder: () => void;
  readonly createPage: () => void;
  readonly createTemplate: () => void;
}) {
  // Creating pages and folders appears only for a role that may (shared/properties/projectRoles.ts).
  const translate = useTranslate();
  const creatable = can(useCurrentRole(), 'page:create');
  return (
    <div className="panel-header">
      <h2>{translate('pages.title')}</h2>
      {creatable && (
        <div style={{ display: 'flex', gap: 2 }}>
          <button className="ghost" title={translate('pages.folder.new')} onClick={createFolder}>
            <FolderPlusIcon size={13} />
          </button>
          <MoreMenu
            className="ghost"
            title={translate('pages.new.button')}
            icon={<PlusIcon size={13} />}
            width={190}
            items={pageCreateMenuItems({ createPage, createTemplate }, translate)}
          />
        </div>
      )}
    </div>
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
