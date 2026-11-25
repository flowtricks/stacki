// The Files panel's operations as the person meets them: each runs main's operation, asks when a name is taken,
// reports a failure as a toast, records Undo for a rename or a move, and refreshes the folders it touched. The tree
// component only decides what was asked; everything said and asked about it is here.
import { assert } from '../../../shared/core/assert';
import {
  EXPLORER_ROOT,
  baseName,
  childPath,
  parentPath,
  parseExplorerPath,
  type CollisionChoice,
  type CreateKind,
  type ExplorerError,
  type ExplorerPath,
  type ExplorerResult,
  type TransferMode,
  type TransferPlacement,
} from '../../../shared/ipc/fileExplorer';
import type { Translator } from '../../lib/i18n/localeContext';
import { choiceDialog, confirmDialog } from '../../ui/ConfirmDialog';
import { createEntry, importEntries, renameEntry, transferEntries, trashEntries } from './filesBridge';
import { dropEditorWithin } from './fileEditorControl';
import type { FilesHost } from './filesHost';
import { filesView, updateFilesView, withMoved, withoutListings } from './filesState';

export interface FilesActionContext {
  readonly host: FilesHost;
  readonly translate: Translator;
  /** Reads these folders again (the panel's loader). */
  readonly refresh: (folders: readonly ExplorerPath[]) => void;
}

/** A failure as the sentence a toast shows: what went wrong, in the person's words, never a path or a file's text. */
export function explorerErrorText(error: ExplorerError, translate: Translator, name: string): string {
  switch (error.code) {
    case 'not-open':
      return translate('workspace.files.error.notOpen');
    case 'missing':
      return translate('workspace.files.error.missing', { name });
    case 'exists':
      return translate('workspace.files.error.exists', { name });
    case 'collision':
      return translate('workspace.files.error.collision', { names: error.names.join(', ') });
    case 'protected':
      return translate('workspace.files.error.protected', { name });
    case 'outside':
      return translate('workspace.files.error.outside', { name });
    case 'not-directory':
      return translate('workspace.files.error.notDirectory', { name });
    case 'not-file':
      return translate('workspace.files.error.notFile', { name });
    case 'into-itself':
      return translate('workspace.files.error.intoItself', { name });
    case 'too-large':
      return translate('workspace.files.error.tooLarge', { name });
    case 'too-many':
      return translate('workspace.files.error.tooMany', { name });
    case 'conflict':
      return translate('workspace.files.error.conflict', { name });
    case 'not-text':
      return translate('workspace.files.error.notText', { name });
    case 'filesystem':
      return error.detail === undefined
        ? translate('workspace.files.error.filesystem', { name })
        : translate('workspace.files.error.filesystemCode', { name, code: error.detail });
    default: {
      const exhaustive: never = error.code;
      return exhaustive;
    }
  }
}

function report(context: FilesActionContext, error: ExplorerError, name: string): void {
  context.host.showToast(explorerErrorText(error, context.translate, name), 'error');
}

/** A new file or folder named `name` in `parent`; answers its path. */
export async function createIn(context: FilesActionContext, parent: ExplorerPath, name: string, kind: CreateKind): Promise<ExplorerPath | undefined> {
  const created = await createEntry(context.host.projectPath, parent, name, kind);
  context.refresh([parent]);
  if (!created.ok) {
    report(context, created.error, name);
    return undefined;
  }
  updateFilesView(context.host.projectPath, (view) => ({
    ...view,
    open: parent === '' || view.open.has(parent) ? view.open : new Set([...view.open, parent]),
    selected: new Set([created.value.path]),
    focused: created.value.path,
    anchor: created.value.path,
  }));
  return created.value.path;
}

/** Renames an entry; a page or a component goes through the app's reference-updating rename. */
export async function renameTo(context: FilesActionContext, path: ExplorerPath, name: string): Promise<void> {
  const parent = parentPath(path);
  assert(parent !== undefined, 'renameTo: the root is never renamed');
  if (name === baseName(path)) {
    return;
  }
  const target = childPath(parent, name);
  const special = context.host.referenceMove(path, target);
  if (special !== undefined) {
    if (await special()) {
      followMove(context, path, target);
    }
    context.refresh([parent]);
    return;
  }
  const renamed = await renameEntry(context.host.projectPath, path, name);
  context.refresh([parent]);
  if (!renamed.ok) {
    report(context, renamed.error, baseName(path));
    return;
  }
  followMove(context, path, renamed.value.path);
  const label = context.translate('workspace.files.undo.rename', { name: baseName(path) });
  context.host.recordUndo({
    label,
    undo: async () => undoRename(context, renamed.value.path, baseName(path)),
    redo: async () => undoRename(context, path, name),
  });
}

async function undoRename(context: FilesActionContext, path: ExplorerPath, name: string): Promise<void> {
  const parent = parentPath(path) ?? EXPLORER_ROOT;
  const back = await renameEntry(context.host.projectPath, path, name);
  context.refresh([parent]);
  if (!back.ok) {
    report(context, back.error, baseName(path));
    return;
  }
  followMove(context, path, back.value.path);
}

// The panel's state follows a moved entry: its open folders, selection and the editor keep pointing at it.
function followMove(context: FilesActionContext, from: ExplorerPath, to: ExplorerPath): void {
  updateFilesView(context.host.projectPath, (view) => withMoved(view, from, to));
}

/** Asks what to do about taken names: replace them (old ones to the Trash), keep both, or stop. */
async function askCollision(context: FilesActionContext, names: readonly string[]): Promise<CollisionChoice | undefined> {
  const { translate } = context;
  const answer = await choiceDialog({
    title: translate('workspace.files.collision.title', { count: names.length }),
    body: translate('workspace.files.collision.body', { names: names.join(', ') }),
    choices: [
      { id: 'keep-both', label: translate('workspace.files.collision.keepBoth'), hint: translate('workspace.files.collision.keepBothHint'), recommended: true },
      { id: 'replace', label: translate('workspace.files.collision.replace'), hint: translate('workspace.files.collision.replaceHint') },
    ],
    cancelLabel: translate('workspace.files.cancel'),
  });
  return answer === 'keep-both' || answer === 'replace' ? answer : undefined;
}

// Runs an operation that may meet taken names: first refusing, then, if the person answers, with their answer.
async function withCollisions(
  context: FilesActionContext,
  first: CollisionChoice,
  run: (collision: CollisionChoice) => Promise<ExplorerResult<{ readonly placed: readonly TransferPlacement[] }>>,
): Promise<ExplorerResult<{ readonly placed: readonly TransferPlacement[] }> | undefined> {
  const tried = await run(first);
  if (tried.ok || tried.error.code !== 'collision' || first !== 'refuse') {
    return tried;
  }
  const answer = await askCollision(context, tried.error.names);
  return answer === undefined ? undefined : run(answer);
}

/** Moves or copies `paths` into `target`; a single page or component moves through the app's reference update. */
export async function transferInto(context: FilesActionContext, paths: readonly ExplorerPath[], target: ExplorerPath, mode: TransferMode): Promise<void> {
  assert(paths.length > 0, 'transferInto: something is moved');
  if (mode === 'move' && paths.length === 1) {
    const only = paths[0];
    assert(only !== undefined, 'transferInto: the one path exists');
    const special = context.host.referenceMove(only, childPath(target, baseName(only)));
    if (special !== undefined) {
      if (await special()) {
        followMove(context, only, childPath(target, baseName(only)));
      }
      context.refresh([target, parentPath(only) ?? EXPLORER_ROOT]);
      return;
    }
  }
  const { projectPath } = context.host;
  const first = sameFolderCopy(paths, target, mode) ? 'keep-both' : 'refuse';
  const done = await withCollisions(context, first, (collision) => transferEntries(projectPath, { paths, target, mode, collision }));
  context.refresh([target, ...paths.map((path) => parentPath(path) ?? EXPLORER_ROOT)]);
  if (done === undefined) {
    return;
  }
  if (!done.ok) {
    report(context, done.error, baseName(paths[0] ?? EXPLORER_ROOT));
    return;
  }
  const placed = done.value.placed;
  if (mode === 'move') {
    for (const each of placed) {
      followMove(context, toPath(each.from), each.to);
    }
    recordMoveUndo(context, placed);
  }
  updateFilesView(projectPath, (view) => ({ ...view, selected: new Set(placed.map((each) => each.to)), focused: placed[0]?.to ?? view.focused }));
}

// A copy into the folder it came from is a duplicate: it takes a free "copy" name without asking.
function sameFolderCopy(paths: readonly ExplorerPath[], target: ExplorerPath, mode: TransferMode): boolean {
  return mode === 'copy' && paths.every((path) => parentPath(path) === target);
}

// A move's `from` is the project path it was sent as, so it parses as one; an import's is an outside file and never reaches here.
function toPath(from: string): ExplorerPath {
  return parseExplorerPath(from);
}

// Undo of a plain move puts each entry back in the folder it came from, under its old name; Redo moves it again.
function recordMoveUndo(context: FilesActionContext, placed: readonly TransferPlacement[]): void {
  if (placed.length === 0) {
    return;
  }
  const { projectPath } = context.host;
  const moves = placed.map((each) => ({ from: toPath(each.from), to: each.to }));
  const label = context.translate('workspace.files.undo.move', { count: moves.length });
  const run = async (pairs: readonly { readonly from: ExplorerPath; readonly to: ExplorerPath }[]): Promise<void> => {
    for (const pair of pairs) {
      const parent = parentPath(pair.to) ?? EXPLORER_ROOT;
      const moved = await transferEntries(projectPath, { paths: [pair.from], target: parent, mode: 'move', collision: 'refuse' });
      context.refresh([parent, parentPath(pair.from) ?? EXPLORER_ROOT]);
      if (!moved.ok) {
        report(context, moved.error, baseName(pair.from));
        return;
      }
      const landed = moved.value.placed[0]?.to;
      if (landed !== undefined && landed !== pair.to) {
        // The old name was free when moving away and taken now; a move never renames, so this cannot happen silently.
        report(context, { code: 'exists', names: [], detail: undefined }, baseName(pair.to));
        return;
      }
      followMove(context, pair.from, pair.to);
    }
  };
  context.host.recordUndo({
    label,
    undo: () => run(moves.map((each) => ({ from: each.to, to: each.from }))),
    redo: () => run(moves),
  });
}

/** Moves `paths` to the operating system's Trash after the person confirms; unsaved editor text inside is named. */
export async function trashPaths(context: FilesActionContext, paths: readonly ExplorerPath[]): Promise<void> {
  assert(paths.length > 0, 'trashPaths: something is deleted');
  const { translate, host } = context;
  const view = filesView(host.projectPath);
  const editor = view.editor;
  const losesEdits = editor !== undefined && editor.dirty && paths.some((path) => path === editor.path || editor.path.startsWith(`${path}/`));
  const first = baseName(paths[0] ?? EXPLORER_ROOT);
  const confirmed = await confirmDialog({
    title:
      paths.length === 1 ? translate('workspace.files.trash.titleOne', { name: first }) : translate('workspace.files.trash.titleMany', { count: paths.length }),
    body: losesEdits ? translate('workspace.files.trash.bodyUnsaved') : translate('workspace.files.trash.body'),
    confirmLabel: translate('workspace.files.trash.confirm'),
    cancelLabel: translate('workspace.files.cancel'),
    danger: true,
  });
  if (confirmed === false) {
    return;
  }
  const trashed = await trashEntries(host.projectPath, paths);
  context.refresh(paths.map((path) => parentPath(path) ?? EXPLORER_ROOT));
  if (!trashed.ok) {
    report(context, trashed.error, first);
    return;
  }
  dropEditorWithin(host.projectPath, paths);
  updateFilesView(host.projectPath, (current) => {
    let next = current;
    for (const path of paths) {
      next = withoutListings(next, path);
    }
    return {
      ...next,
      selected: new Set(),
      open: new Set([...next.open].filter((folder) => !paths.some((path) => folder === path || folder.startsWith(`${path}/`)))),
    };
  });
  host.showToast(
    paths.length === 1
      ? translate('workspace.files.trash.doneOne', { name: first })
      : translate('workspace.files.trash.doneMany', { count: trashed.value.count }),
    'success',
  );
}

/** Copies files dropped from the operating system into `target`. */
export async function importInto(context: FilesActionContext, sources: readonly string[], target: ExplorerPath): Promise<void> {
  if (sources.length === 0) {
    return;
  }
  const { projectPath } = context.host;
  const done = await withCollisions(context, 'refuse', (collision) => importEntries(projectPath, { sources, target, collision }));
  context.refresh([target]);
  if (done === undefined) {
    return;
  }
  if (!done.ok) {
    report(context, done.error, sources[0]?.split(/[\\/]/).pop() ?? '');
    return;
  }
  updateFilesView(projectPath, (view) => ({ ...view, selected: new Set(done.value.placed.map((each) => each.to)) }));
}
