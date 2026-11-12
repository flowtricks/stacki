// Files a contributor keeps in the checkout and tells git to ignore for this clone
// only: `.git/info/exclude` (a local notes folder, say) and the global excludes file.
// The policy scan and `check:changed` already list files through git, so they never see
// these. ESLint and Prettier walk the folder instead, and neither reads these lists, so
// a notes folder with a stray `.ts` or `.json` failed the gate for a person who had done
// nothing wrong (issue #78). This module is the one place that names those files, for
// the ESLint config and for the Prettier runner (formatTree.mts).
//
// Only these two sources count, not `.gitignore`: ESLint and Prettier already treat the
// repository's own ignore rules as they always did, so a clean checkout is checked
// exactly as before.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert } from './assert.mts';
import { runChild } from './child.mts';
import { POLICY_LIMITS } from './limits.mts';

/**
 * Untracked paths that only a local exclude list ignores, repository-relative with forward
 * slashes; a folder git collapsed to one entry ends with a slash. Empty when `root` is not
 * a git checkout (a source archive), where there is no local list to honour.
 */
export function localExcludedPaths(root: string): readonly string[] {
  assert(path.isAbsolute(root), 'localExcludedPaths: the root is absolute');
  const lists = localExcludeFiles(root);
  if (lists.length === 0) {
    return [];
  }
  const listing = runChild('git', ['ls-files', '-z', '--others', '--ignored', '--directory', ...lists.map((list) => `--exclude-from=${list}`)], { cwd: root });
  if (listing.status !== 0) {
    return [];
  }
  const found = listing.stdout.split('\0').filter((entry) => entry.length > 0);
  assert(found.length <= POLICY_LIMITS.scanFilesMax, 'localExcludedPaths: more excluded paths than the limit');
  return found;
}

/**
 * ESLint `ignores` globs for those paths. ESLint resolves them against the config's folder,
 * which is the repository root, so a path means what git meant by it.
 */
export function eslintIgnoresFor(excluded: readonly string[]): readonly string[] {
  return excluded.map((entry) => {
    const escaped = entry.replace(/[\\*?[\]{}()!+@]/g, (character) => `\\${character}`);
    return escaped.endsWith('/') ? `${escaped}**` : escaped;
  });
}

// The exclude lists that exist: the clone's own, then the user's global one.
function localExcludeFiles(root: string): readonly string[] {
  const candidates: string[] = [];
  const own = runChild('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: root });
  if (own.status === 0 && own.stdout.trim().length > 0) {
    candidates.push(path.resolve(root, own.stdout.trim()));
  }
  const configured = runChild('git', ['config', '--path', '--get', 'core.excludesFile'], { cwd: root });
  if (configured.status === 0 && configured.stdout.trim().length > 0) {
    candidates.push(path.resolve(root, configured.stdout.trim()));
  } else {
    // Git's own default when core.excludesFile is unset.
    const configHome = process.env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config');
    candidates.push(path.join(configHome, 'git', 'ignore'));
  }
  return candidates.filter((candidate) => fs.statSync(candidate, { throwIfNoEntry: false })?.isFile() === true);
}
