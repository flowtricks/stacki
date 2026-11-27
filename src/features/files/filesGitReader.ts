// Reads git's marks into the per-project view (filesState.ts). There is no timer here: the keeper (FilesKeeper.tsx)
// asks when the app's own git read answers (the Git panel's source, useGitInfo), when a followed folder or the git
// directory changes, and when the window comes back. One read runs at a time with at most one waiting behind it, so a
// burst costs two. The tree never waits for it: the marks on screen stay until a newer answer differs from them.
import type { FileGitStatus } from '../../../shared/ipc/fileExplorer';
import { createCoalescedRun, type CoalescedRun } from '../../lib/coalescedRun';
import { buildFileGitMarks } from './fileGitMarks';
import { readFileGitStatus } from './filesBridge';
import { updateFilesView, withGit } from './filesState';

/** Projects with a reader at once; past this the oldest is forgotten. */
const READERS_MAX = 8;
/** Failed reads in a row after which the held marks are dropped: marks that cannot be confirmed are not shown. */
const FAILURES_MAX = 2;

const readers = new Map<string, CoalescedRun<void>>();
const failures = new Map<string, number>();

export function refreshGitMarks(projectPath: string): void {
  let reader = readers.get(projectPath);
  if (reader === undefined) {
    reader = createCoalescedRun(() => readOnce(projectPath));
    readers.set(projectPath, reader);
    for (const oldest of [...readers.keys()].slice(0, Math.max(0, readers.size - READERS_MAX))) {
      readers.delete(oldest);
      failures.delete(oldest);
    }
  }
  void reader.request();
}

async function readOnce(projectPath: string): Promise<void> {
  let status: FileGitStatus;
  try {
    status = await readFileGitStatus(projectPath);
  } catch {
    // Said by the app's own git read, which fails for the same reasons (appNavigation.ts, useGitInfo).
    const failed = (failures.get(projectPath) ?? 0) + 1;
    failures.set(projectPath, failed);
    if (failed >= FAILURES_MAX) {
      updateFilesView(projectPath, (view) => withGit(view, { kind: 'none' }, buildFileGitMarks));
    }
    return;
  }
  failures.delete(projectPath);
  updateFilesView(projectPath, (view) => withGit(view, status, buildFileGitMarks));
}
