// Builds an Astro project tree in a temporary folder from a declarative description.
//
// Why: Stacki must open sites however they are structured, and the structures that break
// it are rare ones (a symlink loop, a BOM, a read-only page, a config written as a function).
// A description is one object a reader can see whole, so each hostile shape is a few lines
// beside the assertion about it, and none of them needs a real project, a download or an install.
//
// How: `files` maps a project-relative POSIX path to a node. A string or byte array is a file;
// `{ symlink }` is a link written verbatim (relative to the link's own folder, as `ln -s` does,
// so `..` makes a cycle); `{ directory }` is an empty folder. `{ text, mode }` and
// `{ directory, mode }` set permissions AFTER everything is written, so a folder that is not
// readable can still be populated. `removeProject` restores access first, because `rm -r`
// cannot descend into a folder it may not read.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type FixtureNode =
  string | Uint8Array | { readonly text: string; readonly mode?: number } | { readonly symlink: string } | { readonly directory: true; readonly mode?: number };

export type FixtureFiles = Readonly<Record<string, FixtureNode>>;

export interface BuiltProject {
  /** The project folder, resolved through symlinks (macOS tmpdir is one) so paths compare equal. */
  readonly root: string;
}

/** The files every Astro project has; a shape adds to these or replaces them. */
export const ASTRO_BASE: FixtureFiles = {
  'package.json': '{"name":"site","type":"module","dependencies":{"astro":"^5.0.0"}}',
  'src/pages/index.astro': '---\n---\n<h1>Home</h1>\n',
};

const PROJECT_FOLDERS_MAX = 100000;

/** Writes `files` under a new folder in the OS temp directory and returns it. */
export function buildProject(files: FixtureFiles, prefix = 'stacki-shape-'): BuiltProject {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  buildProjectAt(root, files);
  return { root };
}

/** Writes `files` under an existing folder (a workspace's package, a nested project). */
export function buildProjectAt(root: string, files: FixtureFiles): void {
  const modes: Array<{ readonly target: string; readonly mode: number }> = [];
  const entries = Object.entries(files);
  // A folder is made once however many files it holds: thousands of files are mostly folder checks.
  const made = new Set<string>();
  if (entries.length > PROJECT_FOLDERS_MAX) {
    throw new Error('Assertion failed: a fixture describes fewer than 100000 entries');
  }
  for (const [relative, node] of entries) {
    if (relative.startsWith('/') || relative.split('/').includes('..')) {
      throw new Error(`Assertion failed: fixture path ${relative} stays inside the project`);
    }
    const target = path.join(root, ...relative.split('/'));
    const parent = path.dirname(target);
    if (!made.has(parent)) {
      fs.mkdirSync(parent, { recursive: true });
      made.add(parent);
    }
    if (typeof node === 'string' || node instanceof Uint8Array) {
      fs.writeFileSync(target, node);
    } else if ('symlink' in node) {
      fs.symlinkSync(node.symlink, target);
    } else if ('directory' in node) {
      fs.mkdirSync(target, { recursive: true });
      if (node.mode !== undefined) {
        modes.push({ target, mode: node.mode });
      }
    } else {
      fs.writeFileSync(target, node.text);
      if (node.mode !== undefined) {
        modes.push({ target, mode: node.mode });
      }
    }
  }
  // Deepest first: a locked parent must not stop a child from being locked.
  for (const { target, mode } of modes.sort((first, second) => second.target.length - first.target.length)) {
    fs.chmodSync(target, mode);
  }
}

/** Deletes a built project, first making every folder and file in it accessible again. */
export function removeProject(root: string): void {
  restoreAccess(root);
  fs.rmSync(root, { recursive: true, force: true });
}

// A walk over what exists now, bounded by the tree itself: `visited` holds each real
// folder once, so a symlink cycle ends the walk instead of extending it.
function restoreAccess(root: string): void {
  const visited = new Set<string>();
  const pending = [root];
  while (pending.length > 0) {
    const folder = pending.pop();
    if (folder === undefined || visited.has(folder)) {
      continue;
    }
    visited.add(folder);
    try {
      fs.chmodSync(folder, 0o755);
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const child = path.join(folder, entry.name);
        if (entry.isDirectory()) {
          pending.push(child);
        } else if (entry.isFile()) {
          fs.chmodSync(child, 0o644);
        }
      }
    } catch {
      // Vanished or still unreadable: the removal that follows reports whatever remains.
    }
  }
}

/** Whether the temp volume treats `Foo` and `foo` as one name (macOS and Windows default). */
export function volumeIsCaseInsensitive(): boolean {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-case-'));
  try {
    fs.writeFileSync(path.join(probe, 'Probe'), '');
    return fs.existsSync(path.join(probe, 'probe'));
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}

/** Whether this process can be stopped by permission bits (root and Windows cannot). */
export function permissionsEnforced(): boolean {
  if (process.platform === 'win32') {
    return false;
  }
  return typeof process.getuid === 'function' && process.getuid() !== 0;
}
