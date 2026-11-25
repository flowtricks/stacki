import { PageRenameButton } from './PageRenameButton';
import { PageSettingsButton } from './PageSettingsButton';
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
import { pageDisplayLabel, pageFolderDisplayName } from '../../lib/pageName';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { CmsIcon, FileIcon, FolderIcon, FolderOpenIcon, HomeIcon } from '../../ui/Icons';
import { isHomePage } from '../../../shared/properties/pageSettings';
import { allowDragEffect } from '../../editor/dragState';
import { can } from '../../../shared/properties/projectRoles';
import { useCurrentRole } from '../../lib/useCurrentRole';
import { PageSelectBox } from './PageSelectionBar';
import type { Selection, SelectionIndex } from './pageSelection';

export type PageEditing = { readonly kind: 'page'; readonly key: string } | { readonly kind: 'folder'; readonly key: string } | { readonly kind: 'none' };

/** Select mode as the rows draw it: what is ticked, and the click that ticks. Absent when the mode is off. */
export interface PageSelectionView {
  readonly selected: Selection;
  readonly partial: ReadonlySet<string>;
  readonly index: SelectionIndex;
  readonly click: (key: string, extend: boolean) => void;
}

export interface PageTreeActions {
  readonly select: (page: ScanPage) => void;
  readonly movePage: (page: ScanPage, to: string) => void;
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
  readonly selection: PageSelectionView | undefined;
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
  const translate = useTranslate();
  const selection = props.selection;
  const refusal = selection?.index.refused.get(page.name);
  return (
    <TreeDragRow
      className={`list-item ${collection ? 'collection' : ''} ${selection === undefined && props.currentPage?.path === page.path ? 'active' : ''} ${selectionClasses(selection, page.name)}`}
      style={{ paddingInlineStart: 8 + props.depth * 14 }}
      data-order-key={page.name}
      title={refusal === undefined ? page.route : translate('pages.settings.delete.homeRefused')}
      draggable={!editing && props.reorder.enabled && selection === undefined}
      onDragStart={(event) => {
        startPageDrag(event, page);
        props.reorder.start(event, page.name);
      }}
      onDragEnd={props.reorder.finish}
      onClick={(event) => {
        if (selection !== undefined) {
          selection.click(page.name, event.shiftKey);
        } else if (!editing) {
          props.actions.select(page);
        }
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        if (selection === undefined) {
          props.actions.setEditing({ kind: 'page', key: page.path });
        }
      }}
    >
      {selection !== undefined && (
        <PageSelectBox
          checked={selection.selected.has(page.name)}
          partial={false}
          refusal={refusal}
          label={translate('pages.select.row', { name: pageDisplayLabel(page, translate) })}
        />
      )}
      <span className="icon">{pageRowIcon(page.name, { collection })}</span>
      <span className="page-list-copy">
        <span className="label">{pageDisplayLabel(page, translate)}</span>
        <span className="sub">{page.route}</span>
      </span>
      {selection === undefined && <PageSettingsButton open={() => props.actions.setEditing({ kind: 'page', key: page.path })} />}
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
  const translate = useTranslate();
  const role = useCurrentRole();
  const renamable = can(role, 'page:rename');
  const selection = props.selection;
  const key = rel + '/';
  return (
    <TreeDragRow
      className={`list-item folder ${selectionClasses(selection, key)}`}
      style={{ paddingInlineStart: 8 + props.depth * 14 }}
      onClick={(event) => {
        if (selection !== undefined) {
          selection.click(key, event.shiftKey);
        } else if (!editing) {
          props.actions.toggleFolder(rel);
        }
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        if (renamable && selection === undefined) {
          props.actions.setEditing({ kind: 'folder', key: rel });
        }
      }}
      draggable={!editing && props.reorder.enabled && selection === undefined}
      onDragStart={(event) => props.reorder.start(event, rel + '/')}
      onDragEnd={props.reorder.finish}
      data-order-key={rel + '/'}
      dropBehavior={folderDropBehavior(props, rel)}
    >
      {selection !== undefined && (
        <PageSelectBox
          checked={selection.selected.has(key)}
          partial={selection.partial.has(key)}
          refusal={undefined}
          label={translate('pages.select.folderRow', { name: pageFolderDisplayName(name) })}
        />
      )}
      <FolderGlyph collapsed={collapsed} toggle={selection === undefined ? undefined : () => props.actions.toggleFolder(rel)} />
      <span className="page-list-copy">
        <span className="label">{pageFolderDisplayName(name)}</span>
        <span className="sub">/{rel}</span>
      </span>
      {collapsed && count > 0 && <span className="sub folder-count">{translate('pages.folder.count', { count })}</span>}
      {renamable && selection === undefined && <PageRenameButton kind="folder" rename={() => props.actions.setEditing({ kind: 'folder', key: rel })} />}
    </TreeDragRow>
  );
}

// In Select mode a click on the row ticks the folder, so showing or hiding its pages moves to its own icon.
function FolderGlyph({ collapsed, toggle }: { readonly collapsed: boolean; readonly toggle: (() => void) | undefined }) {
  const translate = useTranslate();
  const glyph = collapsed ? <FolderIcon size={13} /> : <FolderOpenIcon size={13} />;
  if (toggle === undefined) {
    return <span className="icon">{glyph}</span>;
  }
  return (
    <span
      className="icon page-select-folder-toggle"
      role="button"
      title={translate('pages.select.folderToggle')}
      aria-label={translate('pages.select.folderToggle')}
      aria-expanded={!collapsed}
      onClick={(event) => {
        event.stopPropagation();
        toggle();
      }}
    >
      {glyph}
    </span>
  );
}

function selectionClasses(selection: PageSelectionView | undefined, key: string): string {
  if (selection === undefined) {
    return '';
  }
  const refused = selection.index.refused.has(key) ? 'page-refused' : '';
  return `page-selecting ${selection.selected.has(key) ? 'page-selected' : ''} ${refused}`;
}

// The homepage's row carries the house, the icon Page settings shows on its Homepage badge.
function pageRowIcon(name: string, { collection }: { readonly collection: boolean }) {
  if (collection) {
    return <CmsIcon size={13} />;
  }
  return isHomePage(name) ? <HomeIcon size={13} /> : <FileIcon size={13} />;
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
