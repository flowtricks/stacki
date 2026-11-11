// A whole working tree, recorded as a git tree object without touching the
// project's index, branches or stash: the change ledger (changeLedger.ts)
// takes one when a turn starts and one when it ends, and the difference is
// every file the agent changed — including edits it made with a shell command
// (Codex's `python3 - <<'PY'`, a `sed -i`), which no tool-call event names.
//
// How: copy the project's index to a temporary file (its stat cache makes the
// next step cheap), `git add -A` against that copy (GIT_INDEX_FILE), and
// `git write-tree`. Git's own ignore rules apply, so node_modules and build
// output stay out. The blobs this writes are unreferenced objects in the
// project's object store; nothing names them, so git's garbage collection
// removes them in time. A project that is not a git repository has no
// snapshot, and the ledger falls back to the files tool calls named.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { assert } from '../../../shared/core/assert';
import { AI_LIMITS } from '../../../shared/properties/ai/aiLimits';
import { git } from '../../lib/nodeTools';

export interface TreeChange {
  /** Project-relative, forward slashes, as git names it. */
  readonly path: string;
  readonly status: 'added' | 'deleted' | 'modified';
}

export interface TreeSnapshots {
  readonly snapshot: (root: string) => Promise<string | undefined>;
  readonly changes: (root: string, before: string, after: string) => Promise<readonly TreeChange[]>;
  readonly blob: (root: string, tree: string, relative: string) => Promise<string | undefined>;
}

const TREE_HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export const GIT_SNAPSHOTS: TreeSnapshots = {
  snapshot: snapshotTree,
  changes: changedPaths,
  blob: blobAt,
};

async function snapshotTree(root: string): Promise<string | undefined> {
  let gitDirectory: string;
  try {
    gitDirectory = (await git(root, ['rev-parse', '--absolute-git-dir'], { timeout: AI_LIMITS.snapshotMsMax })).stdout.trim();
  } catch {
    return undefined; // Not a repository.
  }
  const index = path.join(os.tmpdir(), `stacki-ai-index-${randomBytes(8).toString('hex')}`);
  try {
    const projectIndex = path.join(gitDirectory, 'index');
    if (fs.existsSync(projectIndex)) {
      fs.copyFileSync(projectIndex, index);
    }
    const options = { timeout: AI_LIMITS.snapshotMsMax, env: { ...process.env, GIT_INDEX_FILE: index } };
    await git(root, ['add', '--all', '--', '.'], options);
    const tree = (await git(root, ['write-tree'], options)).stdout.trim();
    assert(TREE_HASH.test(tree), 'snapshotTree: git names a tree by its hash');
    return tree;
  } catch {
    return undefined; // A locked or broken repository: the ledger still has the files tool calls named.
  } finally {
    fs.rmSync(index, { force: true });
  }
}

async function changedPaths(root: string, before: string, after: string): Promise<readonly TreeChange[]> {
  assert(TREE_HASH.test(before), 'changedPaths: a tree hash');
  assert(TREE_HASH.test(after), 'changedPaths: a tree hash');
  if (before === after) {
    return [];
  }
  const output = (await git(root, ['diff-tree', '-r', '-z', '--no-renames', '--name-status', before, after], { timeout: AI_LIMITS.snapshotMsMax })).stdout;
  const fields = output.split('\0').filter((field) => field.length > 0);
  const changes: TreeChange[] = [];
  for (let index = 0; index + 1 < fields.length && changes.length < AI_LIMITS.ledgerFilesMax; index += 2) {
    const status = fields[index];
    const file = fields[index + 1];
    if (file === undefined) {
      break;
    }
    changes.push({ path: file, status: status === 'A' ? 'added' : status === 'D' ? 'deleted' : 'modified' });
  }
  return changes;
}

async function blobAt(root: string, tree: string, relative: string): Promise<string | undefined> {
  assert(TREE_HASH.test(tree), 'blobAt: a tree hash');
  assert(!relative.startsWith('/'), 'blobAt: a project-relative path');
  try {
    const text = (await git(root, ['cat-file', 'blob', `${tree}:${relative}`], { timeout: AI_LIMITS.snapshotMsMax, maxBuffer: AI_LIMITS.fileCharsMax * 4 }))
      .stdout;
    return text.includes('\0') || text.length > AI_LIMITS.fileCharsMax ? undefined : text;
  } catch {
    return undefined;
  }
}
