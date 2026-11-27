// Which git mark each row of the Files panel wears, as values (built from the answer in shared/ipc/fileExplorer.ts,
// "Git marks"). The rules are VS Code's Explorer's, with one difference stated here:
//
//   - a changed file wears its own letter; a folder git reports whole (untracked) hands its letter to everything inside;
//   - a folder holding changes wears a dot in the colour of the strongest one (`FILE_GIT_STATES`' order);
//   - an ignored entry, and everything inside it, is dimmed and nothing else;
//   - a deleted file has no row. VS Code does not mark the folders above it; here they do get the dot, because
//     otherwise nothing in the tree would say the project changed. The folder a renamed file left is marked the same way.
//
// Names are compared in one Unicode form (NFC): git writes composed accents where a macOS disk may hold them decomposed.
import { assert } from '../../../shared/core/assert';
import type { GitMark } from '../../ui/GitStatus';
import {
  FILE_EXPLORER_LIMITS,
  isProtectedPath,
  parentPath,
  type ExplorerPath,
  FILE_GIT_STATES,
  type FileGitState,
  type FileGitStatus,
} from '../../../shared/ipc/fileExplorer';

type Repository = Extract<FileGitStatus, { readonly kind: 'repository' }>;

export interface FileGitMarks {
  readonly whole: Repository['whole'];
  /** Changed entries by name: a file's own change, or a folder's (untracked as a whole, or a submodule). */
  readonly changes: ReadonlyMap<string, { readonly state: FileGitState; readonly folder: boolean; readonly from: ExplorerPath | undefined }>;
  /** Every folder above a change, with the strongest state below it. */
  readonly containing: ReadonlyMap<string, FileGitState>;
  readonly ignored: ReadonlySet<string>;
  /** The ignored entries that are folders: what is inside them is ignored too. */
  readonly ignoredFolders: ReadonlySet<string>;
}

const STRENGTH: ReadonlyMap<FileGitState, number> = new Map(FILE_GIT_STATES.map((state, index) => [state, FILE_GIT_STATES.length - index]));

export function strongerGitState(left: FileGitState | undefined, right: FileGitState): FileGitState {
  if (left === undefined) {
    return right;
  }
  return (STRENGTH.get(right) ?? 0) > (STRENGTH.get(left) ?? 0) ? right : left;
}

const key = (path: string): string => path.normalize('NFC');

export function buildFileGitMarks(status: Repository): FileGitMarks {
  const changes = new Map<string, { readonly state: FileGitState; readonly folder: boolean; readonly from: ExplorerPath | undefined }>();
  const containing = new Map<string, FileGitState>();
  const markAbove = (path: ExplorerPath, state: FileGitState): void => {
    let parent = parentPath(path);
    // Bounded by the path's own segment bound.
    for (let depth = 0; depth < FILE_EXPLORER_LIMITS.pathSegmentsMax && parent !== undefined && parent !== ''; depth++) {
      containing.set(key(parent), strongerGitState(containing.get(key(parent)), state));
      parent = parentPath(parent);
    }
  };
  // A path git names twice (removed from the index and still on disk) keeps its later record, the working tree's.
  for (const change of status.changes) {
    changes.set(key(change.path), { state: change.state, folder: change.folder, from: change.from });
    markAbove(change.path, change.state);
    if (change.state === 'renamed' && change.from !== undefined) {
      markAbove(change.from, 'renamed');
    }
  }
  const ignored = new Set(status.ignored.map((entry) => key(entry.path)));
  const ignoredFolders = new Set(status.ignored.filter((entry) => entry.folder).map((entry) => key(entry.path)));
  assert(ignoredFolders.size <= ignored.size, 'buildFileGitMarks: an ignored folder is an ignored entry');
  return { whole: status.whole, changes, containing, ignored, ignoredFolders };
}

/** The mark of the entry at `path`; undefined for an unchanged one, and always outside a repository. */
export function fileGitMark(marks: FileGitMarks | undefined, path: ExplorerPath, { folder }: { readonly folder: boolean }): GitMark | undefined {
  // `.git` and Stacki's write staging are not the project's files: git has nothing to say about them.
  if (marks === undefined || path === '' || isProtectedPath(path)) {
    return undefined;
  }
  const name = key(path);
  const above = ancestorsOf(name);
  if (marks.whole === 'ignored' || marks.ignored.has(name) || above.some((each) => marks.ignoredFolders.has(each))) {
    return { kind: 'ignored' };
  }
  const own = marks.changes.get(name);
  if (own !== undefined && !folder) {
    return { kind: 'change', state: own.state, from: own.from };
  }
  const inWholeFolder = marks.whole === 'untracked' || above.some((each) => marks.changes.get(each)?.folder === true);
  if (inWholeFolder) {
    return folder ? { kind: 'contains', state: 'untracked' } : { kind: 'change', state: 'untracked', from: undefined };
  }
  if (!folder) {
    return undefined;
  }
  const below = marks.containing.get(name);
  const state = own === undefined ? below : strongerGitState(below, own.state);
  return state === undefined ? undefined : { kind: 'contains', state };
}

function ancestorsOf(name: string): readonly string[] {
  const segments = name.split('/');
  assert(segments.length <= FILE_EXPLORER_LIMITS.pathSegmentsMax, 'fileGitMark: the path is within its segment bound');
  return segments.slice(0, -1).map((_segment, index) => segments.slice(0, index + 1).join('/'));
}
