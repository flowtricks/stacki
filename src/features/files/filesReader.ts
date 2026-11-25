// Reads folder listings into the per-project view (filesState.ts), for the keeper (FilesKeeper.tsx), the panel's Refresh
// and its file actions. Reads of one folder never overlap: a request while one is in flight waits for it and runs once.
// A read ends in every case: with a listing, with the folder gone, or as a failure, which includes no answer within
// `FILES_READ_TIMEOUT_MS` (a main process that never replies must not leave the panel on its placeholder rows). A
// listing that arrives after that is still shown unless a newer read of the folder has started since.
//
// Bound: one entry per folder with a read in flight; the callers ask for the shown folders (at most
// `watchDirectoriesMax` and the root) and the folders an action touched.
import { assert } from '../../../shared/core/assert';
import { EXPLORER_ROOT, type ExplorerListing, type ExplorerPath, type ExplorerResult } from '../../../shared/ipc/fileExplorer';
import { listFiles } from './filesBridge';
import { updateFilesView, withFailure, withListing, withoutListings, type FilesView } from './filesState';

export const FILES_READ_TIMEOUT_MS = 10_000;
// Reads one request chain makes at most: the first and one more for each time another was asked for while one was in
// flight. A folder that changes without pause stops here, and its next change starts a new chain.
const FOLDER_READS_MAX = 100;

interface Flight {
  again: boolean;
}

const running = new Map<string, Flight>();
// The newest read of each folder in flight or timed out: an older answer arriving late is dropped.
const newest = new Map<string, symbol>();

export function isReadingFolder(projectPath: string, folder: ExplorerPath): boolean {
  return running.has(`${projectPath}\n${folder}`);
}

export function refreshFolders(projectPath: string, folders: readonly ExplorerPath[]): void {
  for (const folder of new Set(folders)) {
    const key = `${projectPath}\n${folder}`;
    const pending = running.get(key);
    if (pending === undefined) {
      void readFolder(projectPath, folder, key);
    } else {
      pending.again = true;
    }
  }
}

// Owns the folder's slot in `running` until nothing more is asked of it. The first read starts before this returns.
async function readFolder(projectPath: string, folder: ExplorerPath, key: string): Promise<void> {
  assert(!running.has(key), 'readFolder: reads of one folder never overlap');
  const flight: Flight = { again: true };
  running.set(key, flight);
  for (let reads = 0; flight.again && reads < FOLDER_READS_MAX; reads += 1) {
    flight.again = false;
    await readOnce(projectPath, folder, key);
  }
  running.delete(key);
}

// Settles when the read is answered or its time is up, whichever is first. It never rejects.
function readOnce(projectPath: string, folder: ExplorerPath, key: string): Promise<void> {
  const read = Symbol(key);
  newest.set(key, read);
  const fail = (): void => updateFilesView(projectPath, (view) => withFailure(view, folder));
  return new Promise((settle) => {
    const timer = setTimeout(() => {
      fail();
      settle();
    }, FILES_READ_TIMEOUT_MS);
    void listFiles(projectPath, folder)
      .then((listed) => {
        if (newest.get(key) === read) {
          updateFilesView(projectPath, (view) => withAnswer(view, folder, listed));
        }
      })
      .catch(() => {
        if (newest.get(key) === read) {
          fail();
        }
      })
      .finally(() => {
        clearTimeout(timer);
        if (newest.get(key) === read) {
          newest.delete(key);
        }
        settle();
      });
  });
}

function withAnswer(view: FilesView, folder: ExplorerPath, listed: ExplorerResult<ExplorerListing>): FilesView {
  if (listed.ok) {
    return withListing(view, listed.value);
  }
  const gone = listed.error.code === 'missing' || listed.error.code === 'not-directory';
  // The root cannot close, so a missing root is a failure like any other.
  if (!gone || folder === EXPLORER_ROOT) {
    return withFailure(view, folder);
  }
  // The folder went away: it closes; the watcher on its parent drops its row.
  return { ...withoutListings(view, folder), open: new Set([...view.open].filter((each) => each !== folder)) };
}
