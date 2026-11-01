import type { ScanPage, ScanResult } from '../../../shared/properties/projectScan';
import type { PageRename } from '../../../shared/properties/pageRename';
import { RenamePageDialog } from './RenamePageDialog';
import type { PageEditing } from './PageTreeView';
import { buildPageTree, collectPageTreeDirectories } from './pageTree';

export function PageTreeRenameDialog({
  editing,
  scan,
  save,
  close,
}: {
  readonly editing: PageEditing;
  readonly scan: Pick<ScanResult, 'pages' | 'pageFolders'>;
  readonly save: (change: PageRename) => Promise<void>;
  readonly close: () => void;
}) {
  if (editing.kind === 'none') {
    return undefined;
  }
  const item = renameItem(editing, scan.pages);
  if (!item) {
    return undefined;
  }
  const folders = [...collectPageTreeDirectories(buildPageTree(scan.pages, scan.pageFolders))];
  return (
    <RenamePageDialog
      key={item.kind + ':' + item.from}
      item={item}
      inventory={{ pages: scan.pages.map((page) => page.name), folders }}
      save={save}
      close={close}
    />
  );
}
function renameItem(editing: Exclude<PageEditing, { readonly kind: 'none' }>, pages: readonly ScanPage[]) {
  if (editing.kind === 'folder') {
    return { kind: 'folder', from: editing.key } as const;
  }
  const page = pages.find((entry) => entry.path === editing.key);
  return page ? { kind: 'page' as const, from: page.name } : undefined;
}
