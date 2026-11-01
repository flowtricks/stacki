import { PageRenameButton } from '../../../vendor/stacki/src/features/pages/PageRenameButton';
import { PageOrderGap } from '../../../vendor/stacki/src/features/pages/PageOrderGap';
import { PageSearchPath } from '../../../vendor/stacki/src/features/pages/PageSearchPath';
import { Fragment, useMemo, useState } from 'react';
import {
  buildPageTree,
  pageDisplayName,
  pageFolderDisplayName,
  stripPageExtension,
  type PageTreeNode,
} from '../../../vendor/stacki/src/features/pages/pageTree';
import { orderedPageTree } from '../../../vendor/stacki/src/features/pages/pageTreeOrder';
import { type PageOrderDrag } from '../../../vendor/stacki/src/features/pages/usePageOrderDrag';
import type { PageOrder } from '../../../vendor/stacki/shared/properties/pageOrder';
import type { ScanPage } from '../../../vendor/stacki/shared/properties/projectScan';
import { comparePageNames, isCollectionRoute } from '../../../vendor/stacki/src/features/pages/pageOrder';
import { FileIcon, CollectionIcon, FolderIcon, FolderOpenIcon } from '../../../vendor/stacki/src/ui/Icons';
import type { Peer } from '../collaboration/presence';
import { routeFor } from '../project/projectClient';
import { PagePresence } from './PagePresence';

interface Props {
  readonly rename?: (kind: 'page' | 'folder', from: string) => void;
  readonly folders?: readonly string[] | undefined;
  readonly items: readonly string[];
  readonly pageMetadata?: readonly ScanPage[] | undefined;
  readonly query: string;
  readonly file: string;
  readonly peers: readonly Peer[];
  readonly open: (file: string) => void;
  readonly collection: boolean;
  readonly order: PageOrder;
  readonly reorder: PageOrderDrag;
}
export function PageFileList(props: Props) {
  const pages = useMemo(() => {
    const metadata = new Map(props.pageMetadata?.map((page) => [page.path, page]));
    return props.items.map((path) => ({
      ...metadata.get(path),
      path,
      name: path.replace(/^src\/(pages|content|data)\//, ''),
      route: routeFor(path),
    }));
  }, [props.items, props.pageMetadata]);
  const tree = useMemo(() => buildPageTree(pages, props.folders ?? []), [pages, props.folders]);
  const query = props.query.trim().toLowerCase();
  const results = pages
    .filter((page) => [page.name, pageDisplayName(page)].some((name) => name.toLowerCase().includes(query)))
    .sort((a, b) => comparePageNames(a.name, b.name));
  return (
    <div className="panel-body studio-page-list">
      {query ? (
        results.map((page) => <FileRow key={page.path} page={page} depth={0} props={props} siblings={[]} />)
      ) : (
        <PageBranch tree={tree} relative="" depth={0} props={props} />
      )}
      {query && !results.length && <div className="props-empty">No matching {props.collection ? 'items' : 'pages'}</div>}
    </div>
  );
}

function PageBranch({
  tree,
  relative,
  depth,
  props,
}: {
  readonly tree: PageTreeNode;
  readonly relative: string;
  readonly depth: number;
  readonly props: Props;
}) {
  const entries = orderedPageTree(tree, relative, props.order);
  const siblings = entries.map((entry) => entry.key);
  return (
    <>
      {entries.map((entry, index) => (
        <Fragment key={entry.key}>
          {!props.collection && <PageOrderGap reorder={props.reorder} parent={relative} depth={depth} siblings={siblings} index={index} />}
          {entry.kind === 'page' ? (
            <FileRow page={entry.page} depth={depth} props={props} siblings={siblings} />
          ) : (
            <FolderBranch name={entry.name} tree={entry.node} relative={entry.key.slice(0, -1)} depth={depth} props={props} />
          )}
        </Fragment>
      ))}
      {!props.collection && <PageOrderGap reorder={props.reorder} parent={relative} depth={depth} siblings={siblings} index={entries.length} />}
    </>
  );
}

function FolderBranch({
  name,
  tree,
  relative,
  depth,
  props,
}: {
  readonly name: string;
  readonly tree: PageTreeNode;
  readonly relative: string;
  readonly depth: number;
  readonly props: Props;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const key = relative + '/';
  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.target === event.currentTarget && event.key === 'Enter') {
            setCollapsed(!collapsed);
          }
        }}
        className="list-item folder"
        aria-expanded={!collapsed}
        data-order-key={key}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => setCollapsed(!collapsed)}
        draggable={props.reorder.enabled}
        onDragStart={(event) => props.reorder.start(event, key)}
        onDragEnd={props.reorder.finish}
      >
        <span className="icon">{collapsed ? <FolderIcon size={13} /> : <FolderOpenIcon size={13} />}</span>
        <span className="page-list-copy">
          <span className="label">{pageFolderDisplayName(name)}</span>
          <span className="sub">/{relative}</span>
        </span>
        {!props.collection && props.rename && <PageRenameButton kind="folder" rename={() => props.rename?.('folder', relative)} />}
      </div>
      {!collapsed && <PageBranch tree={tree} relative={relative} depth={depth + 1} props={props} />}
    </>
  );
}

function FileRow({
  page,
  depth,
  props,
  siblings,
}: {
  readonly page: ScanPage;
  readonly depth: number;
  readonly props: Props;
  readonly siblings: readonly string[];
}) {
  const collection = props.collection || isCollectionRoute(page.path);
  const reorder = props.reorder;
  return (
    <div
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && event.key === 'Enter') {
          props.open(page.path);
        }
      }}
      data-file={page.path}
      data-order-key={page.name}
      aria-label={page.name}
      aria-current={props.file === page.path ? 'page' : undefined}
      className={`list-item file-row ${collection ? 'collection' : ''} ${props.file === page.path ? 'active' : ''}`}
      style={{ paddingLeft: 8 + depth * 14 }}
      title={props.collection ? page.path : page.route}
      onClick={() => props.open(page.path)}
      draggable={reorder.enabled && siblings.length > 0}
      onDragStart={(event) => reorder.start(event, page.name)}
      onDragEnd={reorder.finish}
    >
      <span className="icon">{collection ? <CollectionIcon size={13} /> : <FileIcon size={13} />}</span>
      <span className="page-list-copy">
        <span className="label file-row-name">{props.collection ? stripPageExtension(page.name.split('/').at(-1) ?? page.name) : pageDisplayName(page)}</span>
        {!props.collection && <PageSearchPath path={page.route} query={props.query} />}
      </span>
      {!props.collection && <PagePresence peers={props.peers} page={page.path} />}
      {!props.collection && props.rename && <PageRenameButton kind="page" rename={() => props.rename?.('page', page.name)} />}
    </div>
  );
}
