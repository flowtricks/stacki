// Reading what git says about each file of the open project, for the Files panel's marks (shared/ipc/fileExplorer.ts, "Git marks").
//
// It reads the same porcelain the Git panel reads (gitHistory.ts `statusRecords`), with two differences that keep the
// answer small however large the project is: an untracked or ignored folder is one record (`--untracked-files=normal`,
// `--ignored=matching`), never a list of everything inside it. The app's git runner turns optional locks off
// (lib/nodeTools.ts), so this read never rewrites the index, never gets in the way of git in a terminal, and never
// wakes the watcher that asked for it (project/explorerWatch.ts).
//
// Paths arrive from the repository root, so a project in a subfolder of a repository has its folder removed from each.
import { assert } from '../../shared/core/assert';
import {
  parseExplorerPath,
  type ExplorerPath,
  FILE_GIT_LIMITS,
  type FileGitChange,
  type FileGitIgnored,
  type FileGitStatus,
} from '../../shared/ipc/fileExplorer';
import { toRecord } from '../../shared/core/record';
import { gitErrorDetail } from './git';
import { fileGitStateOf, statusRecords, type StatusRecord } from './gitHistory';
import type { Git } from './git';

export interface FileGitRead {
  readonly status: FileGitStatus;
  /** The folder holding this working tree's index and HEAD, to be watched; undefined outside a repository. */
  readonly gitDirectory: string | undefined;
}

const OUTSIDE_REPOSITORY: FileGitRead = { status: { kind: 'none' }, gitDirectory: undefined };

/** The records as the panel's answer, `prefix` being the project's folder inside the repository ('' at its root). */
export function describeFileGitStatus(stdout: string, prefix: string): FileGitStatus {
  assert(prefix === '' || prefix.endsWith('/'), 'describeFileGitStatus: a folder prefix ends with a slash');
  const changes: FileGitChange[] = [];
  let ignored: FileGitIgnored[] = [];
  let ignoredOverflow = false;
  let whole: 'tracked' | 'untracked' | 'ignored' = 'tracked';
  for (const entry of statusRecords(stdout)) {
    const isIgnored = entry.code === '!!';
    // A project that is itself new or ignored is reported as its own folder, or as a folder above it.
    if (entry.path.endsWith('/') && prefix.startsWith(entry.path)) {
      whole = isIgnored ? 'ignored' : 'untracked';
      continue;
    }
    const placed = placeInProject(entry, prefix);
    if (placed === undefined) {
      continue;
    }
    if (isIgnored) {
      if (ignored.length < FILE_GIT_LIMITS.ignoredMax) {
        ignored.push({ path: placed.path, folder: placed.folder });
      } else {
        ignoredOverflow = true;
      }
      continue;
    }
    if (changes.length >= FILE_GIT_LIMITS.changesMax) {
      return { kind: 'too-many', limit: FILE_GIT_LIMITS.changesMax };
    }
    changes.push({ ...placed, state: fileGitStateOf(entry.code) });
  }
  if (ignoredOverflow) {
    ignored = [];
  }
  return { kind: 'repository', whole, changes, ignored };
}

// The record's paths relative to the project; undefined for one outside it, or one whose name the Files panel cannot
// list either (a backslash or a control character).
function placeInProject(
  entry: StatusRecord,
  prefix: string,
): { readonly path: ExplorerPath; readonly folder: boolean; readonly from: ExplorerPath | undefined } | undefined {
  const folder = entry.path.endsWith('/');
  const path = projectPathOf(folder ? entry.path.slice(0, -1) : entry.path, prefix);
  if (path === undefined) {
    return undefined;
  }
  return { path, folder, from: entry.from === undefined ? undefined : projectPathOf(entry.from, prefix) };
}

function projectPathOf(rootPath: string, prefix: string): ExplorerPath | undefined {
  if (!rootPath.startsWith(prefix) || rootPath.length === prefix.length) {
    return undefined;
  }
  try {
    return parseExplorerPath(rootPath.slice(prefix.length));
  } catch {
    return undefined;
  }
}

/** What git says about the project's files now. Not being in a repository is an answer; any other failure throws. */
export async function readFileGitStatus(git: Git, projectPath: string): Promise<FileGitRead> {
  let where: readonly string[];
  try {
    where = (await git(projectPath, ['rev-parse', '--is-inside-work-tree', '--absolute-git-dir', '--show-prefix'])).stdout.split('\n');
  } catch (error: unknown) {
    if (/not a git repository|must be run in a work tree/i.test(gitErrorDetail(error))) {
      return OUTSIDE_REPOSITORY;
    }
    // No git on this machine: the same project without a repository, as far as marks go.
    if (toRecord(error)?.['code'] === 'ENOENT') {
      return OUTSIDE_REPOSITORY;
    }
    throw error;
  }
  const [inside, gitDirectory, prefix = ''] = where;
  if (inside !== 'true' || gitDirectory === undefined) {
    return OUTSIDE_REPOSITORY;
  }
  let stdout: string;
  try {
    stdout = (await git(projectPath, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignored=matching', '--', '.'])).stdout;
  } catch (error: unknown) {
    // Output past the runner's buffer is the same fact as a list past the bound.
    if (toRecord(error)?.['code'] === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return { status: { kind: 'too-many', limit: FILE_GIT_LIMITS.changesMax }, gitDirectory };
    }
    throw error;
  }
  return { status: describeFileGitStatus(stdout, prefix), gitDirectory };
}
