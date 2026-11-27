// Design mode (experimental, removable: docs/design-mode/REMOVE.md): the sandbox, a copy of the project the window
// opens while Design mode is on.
//
// Where: Stacki's own data folder, `design-sandboxes/<random id>/`, never inside the project. The folder and every
// folder above the copy that this module creates are readable by the person only (0700), so the copy of the
// project's `.env` it holds is no more exposed than the project itself.
//
// What: one copy, `site/<project name>/`, which the window opens and every panel writes to. Only what the preview
// renders is copied: dependency, build, cache and history folders are skipped at every depth (DESIGN_SKIPPED_NAMES),
// so a project that holds a second app with its own node_modules costs nothing for it. The project's own top-level
// node_modules is cloned in one call (`cp -c`, copy-on-write on macOS: seconds, and no disk until a file changes;
// Windows and Linux copy it file by file, copy-on-write where the file system can),
// because Astro resolves packages by walking up from the project; a symlinked one would let the dev server write its
// caches into the project's own. The project itself stands as the original the frames are compared with (read only,
// never written: the fence refuses it), so nothing is copied twice.
//
// How: a preflight walks the project first, with hard bounds on files, bytes and time (DESIGN_SANDBOX_LIMITS), and
// refuses at once, naming the largest folder, before anything is copied. The walk and the copy are asynchronous with
// a bounded number of operations in flight, so the main process keeps answering the window, and both stop when the
// person cancels.
//
// A project whose files link outside it (a symlink to another folder, a node_modules that lives in a parent folder)
// is refused: the copy could not be sealed, because a write through such a link would land outside it.
//
// Lifetime: removed when the mode ends, when the app quits, and, for a copy a crash left behind, the next time the
// app starts (`sweepSandboxes`), along with any dev server still running from it (designLeftovers.ts), so the `.env`
// it holds never outlives the session that needed it. Where a copy cannot be deleted yet (a process that will not
// stop, a file the system holds locked), its secret files are deleted on their own, and the folder stays: it is the
// record by which every later start and session tries again.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isPathWithin } from '../../lib/platform';
import { stopServersIn, type StopOutcome } from './designLeftovers';
import type { DesignEnterRefusal } from '../../../shared/ipc/designSession';

export const DESIGN_SANDBOX_LIMITS = {
  /** Files copied from the project, skipped folders aside. A site has hundreds; past this it is something else. */
  sourceFilesMax: 20_000,
  sourceBytesMax: 512 * 1024 * 1024,
  /** How long the preflight may walk before it refuses: the person is waiting. */
  preflightMsMax: 8_000,
  /** Folders deep, below the project. */
  walkDepthMax: 64,
  /** File system operations in flight at once, during the walk and the copy. */
  operationsInFlightMax: 16,
  /** How long cloning node_modules may take. */
  cloneTimeoutMs: 300_000,
  /** Sandboxes swept at once; more is a leak, not a session. */
  sandboxesMax: 64,
  /** Retries of a delete the system refuses for the moment (a locked file), waiting longer each time: 3 s in all. */
  removeRetriesMax: 5,
  removeRetryMs: 200,
  /** Entries looked at while deleting a copy's secret files on their own. */
  scrubEntriesMax: 80_000,
  /** How far a file's time may lag the clock: Linux stamps files from a clock a few milliseconds behind. */
  clockSlackMs: 1_000,
} as const satisfies Record<string, number>;

/** Folders that are dependencies, builds, caches or history, at any depth: never copied, never compared. */
export const DESIGN_SKIPPED_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  '.astro',
  '.vercel',
  '.netlify',
  '.output',
  '.cache',
  '.turbo',
  '.next',
  '.svelte-kit',
  '.parcel-cache',
  '.wrangler',
  'coverage',
]);
/** Folders skipped by their path's ending, at any depth: generated checkouts and agents' worktrees. */
export const DESIGN_SKIPPED_ENDINGS: readonly string[] = ['.stacki/preview', '.claude/worktrees'];

export interface DesignSandbox {
  readonly root: string;
  /** The original the frames are compared with: the project itself, only ever read. */
  readonly base: string;
  readonly live: string;
  /** When the copy finished, less clockSlackMs: a live file changed after this may differ from the original. */
  readonly copiedAtMs: number;
}

export type SandboxResult =
  { readonly ok: true; readonly sandbox: DesignSandbox } | { readonly ok: false; readonly reason: DesignEnterRefusal; readonly folder?: string | undefined };

/** Lets the person stop a copy under way. */
export interface DesignCancel {
  readonly cancelled: () => boolean;
}

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

/** Whether `rel` (project-relative, forward slashes) is a dependency, build or cache folder or inside one. */
export function isSkippedPath(rel: string): boolean {
  const parts = rel.split('/');
  // Inside the site's own public/ and src/, a folder is the site's whatever it is called: `public/work/dist/a.png`
  // is a picture the page shows. Only packages and history are left out there.
  const own = parts[0] === 'public' || parts[0] === 'src';
  if (parts.some((part) => (own ? part === 'node_modules' || part === '.git' : DESIGN_SKIPPED_NAMES.has(part)))) {
    return true;
  }
  return DESIGN_SKIPPED_ENDINGS.some((ending) => rel === ending || rel.endsWith(`/${ending}`) || rel.startsWith(`${ending}/`) || rel.includes(`/${ending}/`));
}

/** Copies the project into a new sandbox. On any refusal, failure or cancel nothing of it is left on disk. */
export async function createSandbox(input: {
  readonly appDataRoot: string;
  readonly realRoot: string;
  readonly cancel?: DesignCancel;
}): Promise<SandboxResult> {
  const realRoot = await fs.promises.realpath(input.realRoot);
  const cancel = input.cancel ?? { cancelled: () => false };
  if (!fs.existsSync(path.join(realRoot, 'node_modules', 'astro', 'package.json'))) {
    // Its packages are installed in a folder above it (a workspace), which a copy elsewhere cannot reach.
    return { ok: false, reason: 'outside-link' };
  }
  // Nothing is made before the preflight answers: a refusal leaves no trace.
  const plan = await planCopy(realRoot, cancel);
  if (!plan.ok) {
    return plan;
  }
  const parent = sandboxesRoot(input.appDataRoot);
  ensurePrivateDirectory(parent);
  const root = path.join(parent, randomUUID());
  ensurePrivateDirectory(root);
  if (isPathWithin(realRoot, fs.realpathSync.native(root))) {
    throw new Error('Assertion failed: createSandbox: the sandbox is outside the project');
  }
  // The copy keeps the project's folder name, so the window's title and project menu name the person's site.
  const live = path.join(root, 'site', path.basename(realRoot));
  const outcome = await fillSandbox({ realRoot, live, entries: plan.entries, cancel });
  if (outcome !== 'done') {
    await discardSandbox(root, { kind: 'stopped', signalled: 0 });
    return { ok: false, reason: outcome };
  }
  return { ok: true, sandbox: { root, base: realRoot, live, copiedAtMs: Date.now() - DESIGN_SANDBOX_LIMITS.clockSlackMs } };
}

async function fillSandbox(input: {
  readonly realRoot: string;
  readonly live: string;
  readonly entries: readonly CopyEntry[];
  readonly cancel: DesignCancel;
}): Promise<'done' | DesignEnterRefusal> {
  const { realRoot, live, entries, cancel } = input;
  try {
    await fs.promises.mkdir(path.dirname(live), { mode: PRIVATE_MODE });
    await copyPlanned(realRoot, live, entries, cancel);
    if (cancel.cancelled()) {
      return 'cancelled';
    }
    await cloneModules(path.join(realRoot, 'node_modules'), path.join(live, 'node_modules'));
    if (cancel.cancelled()) {
      return 'cancelled';
    }
    return (await modulesSealed(path.join(live, 'node_modules'), live)) ? 'done' : 'outside-link';
  } catch {
    return cancel.cancelled() ? 'cancelled' : 'copy-failed';
  }
}

type CopyEntry =
  | { readonly rel: string; readonly kind: 'directory' | 'file' }
  | { readonly rel: string; readonly kind: 'link'; readonly target: string; readonly leadsTo: 'folder' | 'file' };
type CopyPlan =
  | { readonly ok: true; readonly entries: readonly CopyEntry[] }
  | { readonly ok: false; readonly reason: DesignEnterRefusal; readonly folder?: string | undefined };

/**
 * The preflight: every folder, file and link to copy, in an order where a folder comes before what it holds, within
 * the bounds. Past a bound it refuses with the top-level folder that holds the most files.
 */
async function planCopy(realRoot: string, cancel: DesignCancel): Promise<CopyPlan> {
  const startedMs = Date.now();
  const entries: CopyEntry[] = [];
  const filesByTop = new Map<string, number>();
  let bytes = 0;
  let refusal: CopyPlan | undefined = undefined;
  let level: readonly string[] = [''];
  for (let depth = 0; level.length > 0 && refusal === undefined; depth += 1) {
    if (depth > DESIGN_SANDBOX_LIMITS.walkDepthMax) {
      return { ok: false, reason: 'too-large', folder: largestFolder(filesByTop) };
    }
    const next: string[] = [];
    await inBatches(level, async (folder) => {
      if (refusal !== undefined) {
        return;
      }
      for (const dirent of await fs.promises.readdir(path.join(realRoot, folder), { withFileTypes: true })) {
        const rel = folder === '' ? dirent.name : `${folder}/${dirent.name}`;
        if (isSkippedPath(rel)) {
          continue;
        }
        const planned = await planEntry(realRoot, rel, dirent);
        if (planned === 'outside') {
          refusal = { ok: false, reason: 'outside-link' };
          return;
        }
        entries.push(planned);
        if (planned.kind === 'directory') {
          next.push(rel);
        } else if (planned.kind === 'file') {
          bytes += (await fs.promises.stat(path.join(realRoot, rel))).size;
          const top = rel.split('/')[0] ?? rel;
          filesByTop.set(top, (filesByTop.get(top) ?? 0) + 1);
        }
      }
    });
    refusal = refusal ?? boundRefusal({ entries: entries.length, bytes, startedMs, filesByTop, cancel });
    level = next;
  }
  if (refusal !== undefined) {
    return refusal;
  }
  return { ok: true, entries: entries.sort((left, right) => depthOf(left.rel) - depthOf(right.rel)) };
}

function boundRefusal(input: {
  readonly entries: number;
  readonly bytes: number;
  readonly startedMs: number;
  readonly filesByTop: ReadonlyMap<string, number>;
  readonly cancel: DesignCancel;
}): CopyPlan | undefined {
  if (input.cancel.cancelled()) {
    return { ok: false, reason: 'cancelled' };
  }
  const over =
    input.entries > DESIGN_SANDBOX_LIMITS.sourceFilesMax ||
    input.bytes > DESIGN_SANDBOX_LIMITS.sourceBytesMax ||
    Date.now() - input.startedMs > DESIGN_SANDBOX_LIMITS.preflightMsMax;
  return over ? { ok: false, reason: 'too-large', folder: largestFolder(input.filesByTop) } : undefined;
}

function largestFolder(filesByTop: ReadonlyMap<string, number>): string | undefined {
  let largest: { readonly name: string; readonly files: number } | undefined = undefined;
  for (const [name, files] of filesByTop) {
    if (largest === undefined || files > largest.files) {
      largest = { name, files };
    }
  }
  return largest?.name;
}

/** Runs `work` on every item, with at most operationsInFlightMax at once. */
async function inBatches<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const lanes = Array.from({ length: Math.min(DESIGN_SANDBOX_LIMITS.operationsInFlightMax, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      if (item !== undefined) {
        await work(item);
      }
    }
  });
  await Promise.all(lanes);
}

function depthOf(rel: string): number {
  return rel.split('/').length;
}

async function planEntry(realRoot: string, rel: string, dirent: fs.Dirent): Promise<CopyEntry | 'outside'> {
  if (dirent.isSymbolicLink()) {
    const source = path.join(realRoot, rel);
    const resolved = path.resolve(path.dirname(source), await fs.promises.readlink(source));
    if (!isPathWithin(realRoot, resolved)) {
      return 'outside';
    }
    // Kept as a link, relative, so in the copy it names the copy's own file.
    const leadsTo = (await isFolder(resolved)) ? 'folder' : 'file';
    return { rel, kind: 'link', target: path.relative(path.dirname(source), resolved), leadsTo };
  }
  if (dirent.isDirectory()) {
    return { rel, kind: 'directory' };
  }
  return { rel, kind: 'file' };
}

async function isFolder(target: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function copyPlanned(realRoot: string, target: string, entries: readonly CopyEntry[], cancel: DesignCancel): Promise<void> {
  await fs.promises.mkdir(target, { mode: PRIVATE_MODE });
  // Folders first, in order (a folder before what it holds), then files and links, a bounded number at once.
  for (const entry of entries) {
    if (entry.kind === 'directory') {
      await fs.promises.mkdir(path.join(target, entry.rel));
    }
  }
  await inBatches(
    entries.filter((entry) => entry.kind !== 'directory'),
    async (entry) => {
      if (cancel.cancelled()) {
        return;
      }
      const destination = path.join(target, entry.rel);
      if (entry.kind === 'link') {
        const link = linkToMake(entry, destination);
        await fs.promises.symlink(link.target, destination, link.type);
      } else {
        // Copy-on-write where the file system can (APFS, Btrfs, ReFS), a plain copy elsewhere.
        await fs.promises.copyFile(path.join(realRoot, entry.rel), destination, fs.constants.COPYFILE_FICLONE);
      }
    },
  );
}

// Windows lets anyone make a junction, which names a folder by its whole path, and only some people a symbolic link:
// a folder is linked by a junction into the copy, so a project with a folder linked inside it can still be copied.
function linkToMake(entry: Extract<CopyEntry, { kind: 'link' }>, destination: string): { readonly target: string; readonly type: 'junction' | undefined } {
  if (process.platform === 'win32' && entry.leadsTo === 'folder') {
    return { target: path.resolve(path.dirname(destination), entry.target), type: 'junction' };
  }
  return { target: entry.target, type: undefined };
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
export async function modulesSealed(modules: string, live: string): Promise<boolean> {
  const realLive = await fs.promises.realpath(live);
  const folders = [modules];
  for (const dirent of await fs.promises.readdir(modules, { withFileTypes: true })) {
    if (dirent.isDirectory() && dirent.name.startsWith('@')) {
      folders.push(path.join(modules, dirent.name));
    }
  }
  for (const folder of folders) {
    for (const dirent of await fs.promises.readdir(folder, { withFileTypes: true })) {
      if (!dirent.isSymbolicLink()) {
        continue;
      }
      const real = await linkTarget(path.join(folder, dirent.name));
      if (real !== undefined && !isPathWithin(realLive, real)) {
        return false;
      }
    }
  }
  return true;
}

// A link whose target is missing points nowhere a write could follow.
async function linkTarget(link: string): Promise<string | undefined> {
  try {
    return await fs.promises.realpath(link);
  } catch {
    return undefined;
  }
}

/** Refusals that may pass: a file or folder held for the moment, or too many files open at once. */
const TRANSIENT_REMOVE_CODES: ReadonlySet<unknown> = new Set(['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM']);

/**
 * Deletes a folder without holding the main process: the files go in the background. Rejects where one will not go.
 *
 * The retries are this function's own, round the whole delete. Node's `maxRetries` applies again at every folder
 * level, each retry of a folder running its children's retries over, so one held folder a few levels down kept the
 * delete (and the secret files' own deletion, and the next session) waiting for minutes, not seconds.
 */
export async function removeSandboxAsync(root: string): Promise<void> {
  for (let retried = 0; retried < DESIGN_SANDBOX_LIMITS.removeRetriesMax; retried += 1) {
    try {
      await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 0 });
      return;
    } catch (error: unknown) {
      const code: unknown = error instanceof Error && 'code' in error ? error.code : undefined;
      if (!TRANSIENT_REMOVE_CODES.has(code)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, (retried + 1) * DESIGN_SANDBOX_LIMITS.removeRetryMs));
    }
  }
  // The attempt after the last retry: its refusal is the caller's.
  await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 0 });
}

/** A file whose content is a secret: never kept in a draft, and deleted on its own from a copy that cannot go yet. */
export function isSecretFile(rel: string): boolean {
  const name = rel.split('/').at(-1) ?? rel;
  if (name.startsWith('.env') || name === '.dev.vars') {
    return true;
  }
  return /\.(pem|key|p12|pfx)$/i.test(name);
}

/**
 * Deletes the secret files of a copy one by one, packages aside, so they go even while the rest cannot. Links are not
 * followed. Synchronous, for the app's quit. Returns how many are still there (at least one past the entry bound).
 */
export function scrubSecrets(root: string): number {
  const pending: { readonly folder: string; readonly depth: number }[] = [{ folder: root, depth: 0 }];
  let looked = 0;
  let left = 0;
  // Each turn takes one folder off the list, and the list only grows within the entry bound.
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const entry of entriesOf(next.folder)) {
      looked += 1;
      if (looked > DESIGN_SANDBOX_LIMITS.scrubEntriesMax) {
        return left + 1;
      }
      const full = path.join(next.folder, entry.name);
      if (entry.isDirectory()) {
        // The copy sits two folders (`site/<name>/`) below the sandbox's root.
        if (entry.name !== 'node_modules' && next.depth < DESIGN_SANDBOX_LIMITS.walkDepthMax + 2) {
          pending.push({ folder: full, depth: next.depth + 1 });
        }
      } else if (isSecretFile(entry.name)) {
        left += deleteFile(full);
      }
    }
  }
  return left;
}

function entriesOf(folder: string): readonly fs.Dirent[] {
  try {
    return fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** 0 once the file is gone, 1 while it is not. */
function deleteFile(file: string): 0 | 1 {
  try {
    fs.rmSync(file, { force: true });
    return 0;
  } catch {
    return 1;
  }
}

export type DiscardOutcome = 'removed' | 'kept';

/**
 * Deletes a sandbox, given what stopping its processes did. It is kept while one still runs from it (deleting would
 * lose the only record by which a later start finds that process) or while a file will not go; its secret files are
 * deleted either way, and the next sweep tries again. Where the processes could not be read, deleting is still tried:
 * the copy is what must not stay. Never rejects.
 */
export async function discardSandbox(root: string, stop: StopOutcome): Promise<DiscardOutcome> {
  let why = stop.kind === 'running' ? `process ${stop.pids.join(', ')} still runs from it` : '';
  if (stop.kind !== 'running') {
    try {
      await removeSandboxAsync(root);
      return 'removed';
    } catch (error: unknown) {
      why = stop.kind === 'unlisted' ? `${String(error)}; processes unread: ${stop.detail}` : String(error);
    }
  }
  const left = scrubSecrets(root);
  console.warn(`[design] a copy is kept for a later start to delete (${left} secret files left in it): ${why}`); // i18n-ignore: developer log text.
  return 'kept';
}

/**
 * Removes a sandbox as the app quits, when nothing can be awaited. Its secret files go first. On macOS and Linux a
 * detached `rm` finishes after the app has gone; on Windows the removal is synchronous, and where the dev server has
 * not let go yet the copy stays for the next start: quitting never fails over it.
 */
export function removeSandboxAtQuit(root: string): void {
  scrubSecrets(root);
  if (process.platform === 'win32') {
    try {
      const retries = { maxRetries: DESIGN_SANDBOX_LIMITS.removeRetriesMax, retryDelay: DESIGN_SANDBOX_LIMITS.removeRetryMs };
      fs.rmSync(root, { recursive: true, force: true, ...retries });
    } catch (error: unknown) {
      console.warn(`[design] a copy is kept for a later start to delete: ${String(error)}`); // i18n-ignore: developer log text.
    }
    return;
  }
  const child = spawn('rm', ['-rf', root], { detached: true, stdio: 'ignore' });
  // A spawn that fails leaves the copy for the next start; without a listener it would crash the quit.
  child.once('error', () => undefined);
  child.unref();
}

/**
 * Removes every sandbox but `keep`: at startup, the copies a crash left behind, with the `.env` they hold, after
 * stopping any dev server still running from one. Each is handled on its own, so one that cannot go yet holds back
 * no other. Returns how many were removed.
 */
export async function sweepSandboxes(appDataRoot: string, keep: string | undefined = undefined): Promise<number> {
  const parent = sandboxesRoot(appDataRoot);
  if (!fs.existsSync(parent)) {
    return 0;
  }
  const names = (await fs.promises.readdir(parent)).slice(0, DESIGN_SANDBOX_LIMITS.sandboxesMax);
  const swept = names.map((name) => path.join(parent, name)).filter((root) => keep === undefined || path.resolve(keep) !== path.resolve(root));
  let removed = 0;
  for (const root of swept) {
    const outcome = await discardSandbox(root, await stopServersIn(root));
    removed += outcome === 'removed' ? 1 : 0;
  }
  return removed;
}
