// Design mode (experimental, removable: docs/design-mode/REMOVE.md): the sandbox, a copy of the project the window
// opens while Design mode is on.
//
// Where: Stacki's own data folder, `design-sandboxes/<random id>/`, never inside the project. The folder and every
// folder above the copy that this module creates are readable by the person only (0700), so the copy of the
// project's `.env` it holds is no more exposed than the project itself.
//
// What: two copies of the project's files. `base/` is the project as it was when the mode began and never changes;
// `site/<project name>/` (the live copy) is what the window has open, and every panel writes there. node_modules is cloned into the live copy only:
// Astro resolves its packages by walking up from the project, so the copy needs a real node_modules beside it, and
// a symlinked one would let the dev server write its caches into the project's own (and breaks Astro, see
// electron/preview/previewWorktree.ts). On macOS the clone is copy-on-write (`cp -c`): seconds, and no disk until
// a file changes.
//
// A project whose files link outside it (a symlink to another folder, a node_modules that lives in a parent
// folder) is refused: the copy could not be sealed, because a write through such a link would land outside it.
//
// Lifetime: removed when the mode ends, when the app quits, and, for a copy a crash left behind, the next time the
// app starts (`sweepSandboxes`), so the `.env` it holds never outlives the session that needed it.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isPathWithin } from '../../lib/platform';
import type { DesignEnterRefusal } from '../../../shared/ipc/designSession';

export const DESIGN_SANDBOX_LIMITS = {
  /** Files copied from the project, node_modules aside. A site past this is not a site Design mode is for. */
  sourceFilesMax: 40_000,
  sourceBytesMax: 2 * 1024 * 1024 * 1024,
  /** Folders deep, below the project. */
  walkDepthMax: 64,
  /** How long cloning node_modules may take. */
  cloneTimeoutMs: 300_000,
  /** Sandboxes swept at once; more is a leak, not a session. */
  sandboxesMax: 64,
} as const satisfies Record<string, number>;

/** Top-level folders that are output, caches or history, not the site: never copied, never compared. */
export const DESIGN_SKIPPED_TOP: ReadonlySet<string> = new Set(['node_modules', '.git', 'dist', '.astro', '.vercel', '.netlify', '.output', '.cache']);
/** Deeper folders of the same kind, project-relative with forward slashes. */
export const DESIGN_SKIPPED_NESTED: ReadonlySet<string> = new Set(['.stacki/preview']);

export interface DesignSandbox {
  readonly root: string;
  readonly base: string;
  readonly live: string;
  /** When the copy finished: a live file changed after this may differ from its base. */
  readonly copiedAtMs: number;
}

export type SandboxResult = { readonly ok: true; readonly sandbox: DesignSandbox } | { readonly ok: false; readonly reason: DesignEnterRefusal };

const SANDBOXES_FOLDER = 'design-sandboxes';
const PRIVATE_MODE = 0o700;

export function sandboxesRoot(appDataRoot: string): string {
  return path.join(appDataRoot, SANDBOXES_FOLDER);
}

/** Creates `directory` (and its missing parents) readable by the person only, and checks that it is. */
export function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: PRIVATE_MODE });
  if (process.platform === 'win32') {
    // A folder in the person's own profile inherits its access list, which already excludes other people.
    return;
  }
  fs.chmodSync(directory, PRIVATE_MODE);
  const mode = fs.statSync(directory).mode & 0o777;
  if (mode !== PRIVATE_MODE) {
    throw new Error(`Assertion failed: ensurePrivateDirectory: ${directory} is private (mode ${mode.toString(8)})`);
  }
}

/** Whether `rel` (project-relative, forward slashes) is output or cache, outside what a frame compares. */
export function isSkippedPath(rel: string): boolean {
  const top = rel.split('/')[0] ?? rel;
  if (DESIGN_SKIPPED_TOP.has(top)) {
    return true;
  }
  for (const nested of DESIGN_SKIPPED_NESTED) {
    if (rel === nested || rel.startsWith(`${nested}/`)) {
      return true;
    }
  }
  return false;
}

/** Copies the project into a new sandbox. On any refusal or failure nothing of it is left on disk. */
export async function createSandbox(input: { readonly appDataRoot: string; readonly realRoot: string }): Promise<SandboxResult> {
  const realRoot = fs.realpathSync(input.realRoot);
  if (!fs.existsSync(path.join(realRoot, 'node_modules', 'astro', 'package.json'))) {
    // Its packages are installed in a folder above it (a workspace), which a copy elsewhere cannot reach.
    return { ok: false, reason: 'outside-link' };
  }
  const parent = sandboxesRoot(input.appDataRoot);
  ensurePrivateDirectory(parent);
  const root = path.join(parent, randomUUID());
  ensurePrivateDirectory(root);
  if (isPathWithin(realRoot, fs.realpathSync(root))) {
    throw new Error('Assertion failed: createSandbox: the sandbox is outside the project');
  }
  // The copy keeps the project's folder name, so the window's title and project menu name the person's site.
  const sandbox = { root, base: path.join(root, 'base'), live: path.join(root, 'site', path.basename(realRoot)) };
  try {
    const plan = planCopy(realRoot);
    if (!plan.ok) {
      removeSandbox(root);
      return plan;
    }
    copyPlanned(realRoot, sandbox.base, plan.entries);
    fs.mkdirSync(path.dirname(sandbox.live), { mode: PRIVATE_MODE });
    copyPlanned(realRoot, sandbox.live, plan.entries);
    await cloneModules(path.join(realRoot, 'node_modules'), path.join(sandbox.live, 'node_modules'));
    if (!modulesSealed(path.join(sandbox.live, 'node_modules'), sandbox.live)) {
      removeSandbox(root);
      return { ok: false, reason: 'outside-link' };
    }
  } catch {
    removeSandbox(root);
    return { ok: false, reason: 'copy-failed' };
  }
  return { ok: true, sandbox: { ...sandbox, copiedAtMs: Date.now() } };
}

type CopyEntry = { readonly rel: string; readonly kind: 'directory' | 'file' } | { readonly rel: string; readonly kind: 'link'; readonly target: string };
type CopyPlan = { readonly ok: true; readonly entries: readonly CopyEntry[] } | { readonly ok: false; readonly reason: DesignEnterRefusal };

/** Every folder, file and link to copy, in an order where a folder comes before what it holds. */
function planCopy(realRoot: string): CopyPlan {
  const entries: CopyEntry[] = [];
  let bytes = 0;
  const pending: { readonly rel: string; readonly depth: number }[] = [{ rel: '', depth: 0 }];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) {
      break;
    }
    if (next.depth > DESIGN_SANDBOX_LIMITS.walkDepthMax) {
      return { ok: false, reason: 'too-large' };
    }
    for (const dirent of fs.readdirSync(path.join(realRoot, next.rel), { withFileTypes: true })) {
      const rel = next.rel === '' ? dirent.name : `${next.rel}/${dirent.name}`;
      if (isSkippedPath(rel)) {
        continue;
      }
      const planned = planEntry(realRoot, rel, dirent);
      if (planned === 'outside') {
        return { ok: false, reason: 'outside-link' };
      }
      entries.push(planned);
      if (planned.kind === 'directory') {
        pending.push({ rel, depth: next.depth + 1 });
      } else if (planned.kind === 'file') {
        bytes += fs.statSync(path.join(realRoot, rel)).size;
      }
      if (entries.length > DESIGN_SANDBOX_LIMITS.sourceFilesMax) {
        return { ok: false, reason: 'too-large' };
      }
      if (bytes > DESIGN_SANDBOX_LIMITS.sourceBytesMax) {
        return { ok: false, reason: 'too-large' };
      }
    }
  }
  return { ok: true, entries: entries.sort((left, right) => depthOf(left.rel) - depthOf(right.rel)) };
}

function depthOf(rel: string): number {
  return rel.split('/').length;
}

function planEntry(realRoot: string, rel: string, dirent: fs.Dirent): CopyEntry | 'outside' {
  if (dirent.isSymbolicLink()) {
    const source = path.join(realRoot, rel);
    const resolved = path.resolve(path.dirname(source), fs.readlinkSync(source));
    if (!isPathWithin(realRoot, resolved)) {
      return 'outside';
    }
    // Kept as a link, relative, so in the copy it names the copy's own file.
    return { rel, kind: 'link', target: path.relative(path.dirname(source), resolved) };
  }
  if (dirent.isDirectory()) {
    return { rel, kind: 'directory' };
  }
  return { rel, kind: 'file' };
}

function copyPlanned(realRoot: string, target: string, entries: readonly CopyEntry[]): void {
  fs.mkdirSync(target, { mode: PRIVATE_MODE });
  for (const entry of entries) {
    const destination = path.join(target, entry.rel);
    switch (entry.kind) {
      case 'directory':
        fs.mkdirSync(destination);
        break;
      case 'file':
        // Copy-on-write where the file system can (APFS, Btrfs, ReFS), a plain copy elsewhere.
        fs.copyFileSync(path.join(realRoot, entry.rel), destination, fs.constants.COPYFILE_FICLONE);
        break;
      case 'link':
        fs.symlinkSync(entry.target, destination);
        break;
      default: {
        const exhaustive: never = entry;
        throw new Error(`Assertion failed: copyPlanned: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
}

/** Clones node_modules. macOS clones the whole tree in one call; elsewhere Node copies it, cloning where it can. */
async function cloneModules(source: string, target: string): Promise<void> {
  if (process.platform === 'darwin') {
    await run('cp', ['-c', '-R', source, target]);
    return;
  }
  await fs.promises.cp(source, target, { recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE });
}

function run(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', timeout: DESIGN_SANDBOX_LIMITS.cloneTimeoutMs });
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${String(code)}`))));
  });
}

/** Whether every package link at the top of node_modules (where npm, pnpm and yarn put them) stays inside the copy. */
export function modulesSealed(modules: string, live: string): boolean {
  const realLive = fs.realpathSync(live);
  const folders = [modules];
  for (const dirent of fs.readdirSync(modules, { withFileTypes: true })) {
    if (dirent.isDirectory() && dirent.name.startsWith('@')) {
      folders.push(path.join(modules, dirent.name));
    }
  }
  for (const folder of folders) {
    for (const dirent of fs.readdirSync(folder, { withFileTypes: true })) {
      if (!dirent.isSymbolicLink()) {
        continue;
      }
      const link = path.join(folder, dirent.name);
      const real = linkTarget(link);
      if (real !== undefined && !isPathWithin(realLive, real)) {
        return false;
      }
    }
  }
  return true;
}

// A link whose target is missing points nowhere a write could follow.
function linkTarget(link: string): string | undefined {
  try {
    return fs.realpathSync(link);
  } catch {
    return undefined;
  }
}

export function removeSandbox(root: string): void {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/** Removes every sandbox but `keep`: at startup, the copies a crash left behind, with the `.env` they hold. */
export function sweepSandboxes(appDataRoot: string, keep: string | undefined = undefined): number {
  const parent = sandboxesRoot(appDataRoot);
  if (!fs.existsSync(parent)) {
    return 0;
  }
  const names = fs.readdirSync(parent).slice(0, DESIGN_SANDBOX_LIMITS.sandboxesMax);
  let removed = 0;
  for (const name of names) {
    const root = path.join(parent, name);
    if (keep !== undefined && path.resolve(keep) === path.resolve(root)) {
      continue;
    }
    removeSandbox(root);
    removed += 1;
  }
  return removed;
}
