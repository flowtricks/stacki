// Keeps the Files panel's listings ready and current for as long as the project is open, whether or not the panel is:
// the app shell mounts this (it draws nothing), so the first frame of the panel is the real tree (docs/ui-loading.md).
// It reads the root and the folders left open as soon as the project opens, reads again the folders main reports changed
// (explorerWatch.ts) and every shown folder when the window comes back, and tells main which folders to follow. Only
// open folders are ever read, so a closed `node_modules` costs nothing.
//
// It keeps the git marks current the same way (filesGitReader.ts), with no timer of its own: they are read again each
// time the app's git read answers (`gitSignal`: the Git panel's source, which runs after saves, git actions, on window
// return and routinely), on every change main reports, the git directory's included, and on window return.
import { useEffect, useMemo, useRef } from 'react';
import { FILE_EXPLORER_LIMITS, parentPath, type ExplorerPath } from '../../../shared/ipc/fileExplorer';
import { onWindowReturn } from '../../lib/windowReturn';
import { onFoldersChanged, watchFolders } from './filesBridge';
import { refreshGitMarks } from './filesGitReader';
import { isReadingFolder, refreshFolders } from './filesReader';
import { wantedFolders } from './fileTreeModel';
import { filesView, useFilesView } from './filesState';

export function FilesKeeper({
  projectPath,
  gitSignal,
}: {
  readonly projectPath: string;
  /** Whatever the app's last git read answered: a new value means git was just read, and the marks are read with it. */
  readonly gitSignal: unknown;
}) {
  useEffect(() => refreshGitMarks(projectPath), [projectPath, gitSignal]);
  const view = useFilesView(projectPath);
  const wanted = useMemo(() => wantedFolders(view.open), [view.open]);

  // What main follows: the shown folders and the open file's folder, bounded.
  const editorFolder = view.editor === undefined ? undefined : parentPath(view.editor.path);
  const followed = useMemo(() => {
    const folders = new Set(wanted);
    if (editorFolder !== undefined) {
      folders.add(editorFolder);
    }
    return [...folders].slice(0, FILE_EXPLORER_LIMITS.watchDirectoriesMax);
  }, [wanted, editorFolder]);
  const followKey = followed.join('\n');
  // Before the reads below, so a change made while a folder is being read is still heard.
  useEffect(() => {
    // A main process without the watcher leaves the tree to Refresh and the reads on window return.
    void watchFolders(projectPath, followed).catch(() => undefined);
    // The key holds the folders; the array is rebuilt on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- followKey is the folders' identity.
  }, [projectPath, followKey]);
  useEffect(() => () => void watchFolders(projectPath, []).catch(() => undefined), [projectPath]);

  // A folder that starts being shown is read even when a listing is held: nothing followed it while it was closed, and
  // the held listing stays on screen meanwhile. A shown folder whose listing was dropped (its entry moved) is read
  // again; a failed one waits to be asked.
  const shownBefore = useRef<ReadonlySet<ExplorerPath>>(new Set());
  useEffect(() => {
    const before = shownBefore.current;
    shownBefore.current = new Set(wanted);
    const current = filesView(projectPath);
    const dropped = (folder: ExplorerPath): boolean => {
      if (current.listings.has(folder) || current.failed.has(folder)) {
        return false;
      }
      return !isReadingFolder(projectPath, folder);
    };
    refreshFolders(
      projectPath,
      wanted.filter((folder) => !before.has(folder) || dropped(folder)),
    );
  }, [projectPath, wanted, view.listings]);

  useEffect(() => {
    const held = (folder: ExplorerPath): boolean => filesView(projectPath).listings.has(folder) || filesView(projectPath).failed.has(folder);
    const offChanged = onFoldersChanged((directories) => {
      refreshFolders(projectPath, directories.filter(held));
      refreshGitMarks(projectPath);
    });
    const offReturn = onWindowReturn(() => {
      refreshFolders(projectPath, wantedFolders(filesView(projectPath).open));
      refreshGitMarks(projectPath);
    });
    return () => {
      offChanged();
      offReturn();
    };
  }, [projectPath]);
  return undefined;
}
