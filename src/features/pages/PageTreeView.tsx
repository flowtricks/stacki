import { PageRenameButton } from './PageRenameButton';
import { TreeDragRow } from '../../ui/TreeDragDrop';
import { PageOrderGap } from './PageOrderGap';
import type { PageOrder } from '../../../shared/properties/pageOrder';
import { orderedPageTree } from './pageTreeOrder';
import { type PageOrderDrag } from './usePageOrderDrag';
import React from 'react';
import type { ScanPage } from '../../../shared/properties/projectScan';
import type { PageTreeNode, PageTreePage } from './pageTree';
import { isCollectionRoute } from './pageOrder';
import { countTreePages } from './pageTree';
import { pageDisplayName, pageFolderDisplayName } from '../../lib/pageName';
import { CmsIcon, FileIcon, FolderIcon, FolderOpenIcon, TrashIcon } from '../../ui/Icons';
import { allowDragEffect } from '../../editor/dragState';
import { can } from '../../../shared/properties/projectRoles';
import { useCurrentRole } from '../../lib/useCurrentRole';

export type PageEditing = { readonly kind: 'page'; readonly key: string } | { readonly kind: 'folder'; readonly key: string } | { readonly kind: 'none' };

export interface PageTreeActions {
  readonly select: (page: ScanPage) => void;
  readonly removePage: (page: ScanPage) => void;
  readonly movePage: (page: ScanPage, to: string) => void;
  readonly removeFolder: (rel: string, pageCount: number) => void;
  readonly renameFolder: (from: string, to: string) => void;
  readonly setEditing: React.Dispatch<React.SetStateAction<PageEditing>>;
  readonly toggleFolder: (rel: string) => void;
  readonly dragOver: (event: React.DragEvent<HTMLDivElement>, rel: string) => void;
  readonly drop: (event: React.DragEvent<HTMLDivElement>, rel: string) => void;
}

interface PageTreeViewProps {
  readonly order: PageOrder;
  readonly reorder: PageOrderDrag;
  readonly node: PageTreeNode;
  readonly rel: string;
  readonly depth: number;
  readonly currentPage: ScanPage | undefined;
  readonly collapsed: ReadonlySet<string>;
  readonly editing: PageEditing;
  readonly dropDirectory: string | undefined;
  readonly actions: PageTreeActions;
}

export function PageTreeView(props: PageTreeViewProps) {
  const entries = orderedPageTree(props.node, props.rel, props.order);
  const siblings = entries.map((entry) => entry.key);
  return (
    <>
      {entries.map((entry, index) => (
        <React.Fragment key={entry.key}>
          <PageOrderGap reorder={props.reorder} parent={props.rel} depth={props.depth} siblings={siblings} index={index} />
          {entry.kind === 'page' ? (
            <PageRow page={entry.page} props={props} />
          ) : (
            <FolderRows name={entry.name} node={entry.node} rel={entry.key.slice(0, -1)} props={props} />
          )}
        </React.Fragment>
      ))}
      <PageOrderGap reorder={props.reorder} parent={props.rel} depth={props.depth} siblings={siblings} index={entries.length} />
    </>
  );
}

function PageRow({ page, props }: { readonly page: PageTreePage; readonly props: PageTreeViewProps }) {
  const editing = props.editing.kind === 'page' && props.editing.key === page.path;
  const collection = isCollectionRoute(page.name);
  // Rename and delete appear only for a role that may do them (shared/properties/projectRoles.ts).
  const role = useCurrentRole();
  const renamable = can(role, 'page:rename');
  const deletable = can(role, 'page:delete');
  return (
    <TreeDragRow
      className={`list-item ${collection ? 'collection' : ''} ${props.currentPage?.path === page.path ? 'active' : ''}`}
      style={{ paddingLeft: 8 + props.depth * 14 }}
      data-order-key={page.name}
      title={page.route}
      draggable={!editing && props.reorder.enabled}
      onDragStart={(event) => {
        startPageDrag(event, page);
        props.reorder.start(event, page.name);
      }}
      onDragEnd={props.reorder.finish}
      onClick={() => {
        if (!editing) {
          props.actions.select(page);
        }
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        if (renamable) {
          props.actions.setEditing({ kind: 'page', key: page.path });
        }
      }}
    >
      <span className="icon">{collection ? <CmsIcon size={13} /> : <FileIcon size={13} />}</span>
      <span className="page-list-copy">
        <span className="label">{pageDisplayName(page)}</span>
        <span className="sub">{page.route}</span>
      </span>
      {renamable && <PageRenameButton kind="page" rename={() => props.actions.setEditing({ kind: 'page', key: page.path })} />}
      {deletable && (
        <button
          className="row-action"
          title="Delete page"
          onClick={(event) => {
            event.stopPropagation();
            props.actions.removePage(page);
          }}
        >
          <TrashIcon size={12} />
        </button>
      )}
    </TreeDragRow>
  );
}

function FolderRows({
  name,
  node,
  rel,
  props,
}: {
  readonly name: string;
  readonly node: PageTreeNode;
  readonly rel: string;
  readonly props: PageTreeViewProps;
}) {
  const collapsed = props.collapsed.has(rel);
  const editing = props.editing.kind === 'folder' && props.editing.key === rel;
  const count = countTreePages(node);
  return (
    <React.Fragment>
      <FolderRow name={name} rel={rel} count={count} collapsed={collapsed} editing={editing} props={props} />
      {!collapsed && <PageTreeView {...props} node={node} rel={rel} depth={props.depth + 1} />}
    </React.Fragment>
  );
}

function FolderRow({
  name,
  rel,
  count,
  collapsed,
  editing,
  props,
}: {
  readonly name: string;
  readonly rel: string;
  readonly count: number;
  readonly collapsed: boolean;
  readonly editing: boolean;
  readonly props: PageTreeViewProps;
}) {
  const role = useCurrentRole();
  const renamable = can(role, 'page:rename');
  const deletable = can(role, 'page:delete');
  return (
    <TreeDragRow
      className="list-item folder"
      style={{ paddingLeft: 8 + props.depth * 14 }}
      onClick={() => {
        if (!editing) {
          props.actions.toggleFolder(rel);
        }
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        if (renamable) {
          props.actions.setEditing({ kind: 'folder', key: rel });
        }
      }}
      draggable={!editing && props.reorder.enabled}
      onDragStart={(event) => props.reorder.start(event, rel + '/')}
      onDragEnd={props.reorder.finish}
      data-order-key={rel + '/'}
      dropBehavior={folderDropBehavior(props, rel)}
    >
      <span className="icon">{collapsed ? <FolderIcon size={13} /> : <FolderOpenIcon size={13} />}</span>
      <span className="page-list-copy">
        <span className="label">{pageFolderDisplayName(name)}</span>
        <span className="sub">/{rel}</span>
      </span>
      {collapsed && count > 0 && (
        <span className="sub folder-count">
          {count} page{count === 1 ? '' : 's'}
        </span>
      )}
      {renamable && <PageRenameButton kind="folder" rename={() => props.actions.setEditing({ kind: 'folder', key: rel })} />}
      {deletable && (
        <button
          className="row-action"
          title="Delete folder"
          onClick={(event) => {
            event.stopPropagation();
            props.actions.removeFolder(rel, count);
          }}
        >
          <TrashIcon size={12} />
        </button>
      )}
    </TreeDragRow>
  );
}

function startPageDrag(event: React.DragEvent<HTMLDivElement>, page: PageTreePage): void {
  event.dataTransfer.setData('avb/page', JSON.stringify({ path: page.path, name: page.name }));
  allowDragEffect(event.dataTransfer, 'move');
}

function folderDropBehavior(props: PageTreeViewProps, rel: string) {
  return {
    active: props.dropDirectory === rel && props.reorder.target === undefined,
    accepts: (event: React.DragEvent<HTMLDivElement>) => event.dataTransfer.types.includes('avb/page'),
    enter: (event: React.DragEvent<HTMLDivElement>) => {
      props.reorder.clearTarget();
      props.actions.dragOver(event, rel);
    },
    drop: (event: React.DragEvent<HTMLDivElement>) => {
      props.reorder.finish();
      props.actions.drop(event, rel);
    },
  };
}
