// Who decides what happens to the Files editor's unsaved text before it is replaced or closed. The editor view
// registers a settler while it is mounted; switching files, closing the editor, leaving the project and closing the
// window all ask it first, so unsaved text is never dropped without the person choosing to (save, discard or stay).
import { assert } from '../../../shared/core/assert';
import { isWithinPath, type ExplorerPath } from '../../../shared/ipc/fileExplorer';
import { filesView, updateFilesView } from './filesState';

export type Settled = 'proceed' | 'cancel';
type Settler = () => Promise<Settled>;

let settler: Settler | undefined;
// Counts every file opened in the editor, so a new opening (a new editor) is told from the same file renamed or moved
// (the same editor, its unsaved text kept): the host keys the editor view by it.
let openings = 0;

/** The editor's settler while it is mounted; returns the unregister. */
export function registerEditorSettler(next: Settler): () => void {
  settler = next;
  return () => {
    if (settler === next) {
      settler = undefined;
    }
  };
}

/** Asks the open editor to settle its unsaved text; `proceed` when there is none or the person saved or discarded it. */
export async function settleOpenEditor(): Promise<Settled> {
  return settler === undefined ? 'proceed' : settler();
}

/** Opens `path` in the editor once the file it shows now is settled. */
export async function openInEditor(projectPath: string, path: ExplorerPath): Promise<void> {
  assert(path !== '', 'openInEditor: the root is not a file');
  if (filesView(projectPath).editor?.path === path) {
    return;
  }
  if ((await settleOpenEditor()) === 'cancel') {
    return;
  }
  openings += 1;
  const opening = openings;
  updateFilesView(projectPath, (view) => ({ ...view, editor: { path, dirty: false, opening } }));
}

/** Closes the editor once its text is settled; answers whether it closed. */
export async function closeEditor(projectPath: string): Promise<boolean> {
  if ((await settleOpenEditor()) === 'cancel') {
    return false;
  }
  updateFilesView(projectPath, (view) => ({ ...view, editor: undefined }));
  return true;
}

/** Closes the editor without asking: its file was moved to the Trash with the person's confirmation. */
export function dropEditorWithin(projectPath: string, removed: readonly ExplorerPath[]): void {
  updateFilesView(projectPath, (view) => {
    const editor = view.editor;
    if (editor === undefined || !removed.some((path) => isWithinPath(path, editor.path))) {
      return view;
    }
    return { ...view, editor: undefined };
  });
}

/** Records whether the editor's text differs from the disk, for the tree's dot and the close guard. */
export function noteEditorDirty(projectPath: string, path: ExplorerPath, { dirty }: { readonly dirty: boolean }): void {
  updateFilesView(projectPath, (view) => {
    if (view.editor?.path !== path || view.editor.dirty === dirty) {
      return view;
    }
    return { ...view, editor: { ...view.editor, dirty } };
  });
}
