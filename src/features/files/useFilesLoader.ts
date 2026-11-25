// Keeps the Files panel's listings current: reads every open folder that has no listing yet, reads again the folders
// main reports changed (explorerWatch.ts) and every shown folder when the window comes back, and tells main which
// folders to follow. Reads of one folder never overlap: a request while one is in flight waits for it and runs once.
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { FILE_EXPLORER_LIMITS, parentPath, type ExplorerPath } from '../../../shared/ipc/fileExplorer';
import { onWindowReturn } from '../../lib/windowReturn';
import { listFiles, onFoldersChanged, watchFolders } from './filesBridge';
import { wantedFolders } from './fileTreeModel';
import { filesView, updateFilesView, withListing, withoutListings, type FilesView } from './filesState';

export function useFilesLoader(projectPath: string, view: FilesView, onError: (folder: ExplorerPath) => void): (folders: readonly ExplorerPath[]) => void {
  const running = useRef(new Map<ExplorerPath, 'running' | 'again'>());
  const errorRef = useRef(onError);
  errorRef.current = onError;

  const read = useCallback(
    (folder: ExplorerPath): void => {
      const state = running.current.get(folder);
      if (state !== undefined) {
        running.current.set(folder, 'again');
        return;
      }
      running.current.set(folder, 'running');
      void listFiles(projectPath, folder)
        .then((listed) => {
          if (listed.ok) {
            updateFilesView(projectPath, (current) => withListing(current, listed.value));
            return;
          }
          if (listed.error.code === 'missing' || listed.error.code === 'not-directory') {
            // The folder went away: it closes, and its parent is read again to drop its row.
            updateFilesView(projectPath, (current) => ({
              ...withoutListings(current, folder),
              open: new Set([...current.open].filter((each) => each !== folder)),
            }));
            return;
          }
          errorRef.current(folder);
        })
        .catch(() => errorRef.current(folder))
        .finally(() => {
          const again = running.current.get(folder) === 'again';
          running.current.delete(folder);
          if (again) {
            read(folder);
          }
        });
    },
    [projectPath],
  );

  const refresh = useCallback(
    (folders: readonly ExplorerPath[]): void => {
      for (const folder of new Set(folders)) {
        read(folder);
      }
    },
    [read],
  );

  const wanted = useMemo(() => wantedFolders(view.open), [view.open]);
  // Open folders without a listing are read; the rest are already on screen and are only refreshed on change.
  useEffect(() => {
    const current = filesView(projectPath);
    refresh(wanted.filter((folder) => !current.listings.has(folder)));
  }, [projectPath, wanted, refresh]);

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
  useEffect(() => {
    void watchFolders(projectPath, followed).catch(() => undefined);
    // The key holds the folders; the array is rebuilt on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- followKey is the folders' identity.
  }, [projectPath, followKey]);
  useEffect(() => () => void watchFolders(projectPath, []).catch(() => undefined), [projectPath]);

  useEffect(() => {
    const shown = (folders: readonly ExplorerPath[]): readonly ExplorerPath[] => folders.filter((folder) => filesView(projectPath).listings.has(folder));
    const offChanged = onFoldersChanged((directories) => refresh(shown(directories)));
    const offReturn = onWindowReturn(() => refresh(wantedFolders(filesView(projectPath).open)));
    return () => {
      offChanged();
      offReturn();
    };
  }, [projectPath, refresh]);
  return refresh;
}
