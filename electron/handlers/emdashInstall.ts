// Adding EmDash to the open Astro project, the main-process half (the contract and the procedure's sources are in
// shared/properties/emdashInstall.ts).
//
// Safety, in the order a run goes:
// - The plan is computed from the project's own files and shown first: the exact command and every file that can change.
// - A run names the command the person was shown (`confirmedCommand`) and main refuses anything but the command it would
//   plan itself, so nothing runs that the dialog did not display, and nothing runs from a message that only claims consent.
// - The command is a fixed program and an argument array built here from fixed package names and the project's own package
//   manager: no shell string, no value from the renderer or from project files reaches it, and its cwd is the project.
// - Output is streamed through the one runner the app already uses for `npm create` (starter.ts), bounded in size and time.
// - Nothing is reverted. A failed or cancelled run reports which files changed, by comparing them before and after.
// - Success is claimed only after detection re-reads the project (`detectEmDash`).

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { assert } from '../../shared/core/assert';
import type { EmDashProject } from '../../shared/properties/emdash';
import {
  EMDASH_IGNORE_LINES,
  EMDASH_INSTALL_LIMITS,
  EMDASH_LIVE_CONFIG_FILE,
  EMDASH_LIVE_CONFIG_TEXT,
  EMDASH_INIT_ARGUMENTS,
  EMDASH_SAVE_MESSAGE,
  EMDASH_SECRETS_ARGUMENTS,
  EMDASH_PACKAGES,
  classifyInstallFailure,
  emDashIsWired,
  manualStepsFor,
  type EmDashInstallFile,
  type EmDashInstallPlan,
  type EmDashInstallResult,
  type EmDashInstallWarning,
  type EmDashConfigOutcome,
  type EmDashPreviewState,
} from '../../shared/properties/emdashInstall';
import { PNPM_TOLERATE_IGNORED_BUILDS, detectPackageManager } from '../project/packageManager';
import type { PackageManager } from '../../shared/properties/packageManager';
import { RUN_CANCELLED, runCreateCommand } from '../project/starter';
import { ensureToolPath, git } from '../lib/nodeTools';
import { commit } from '../git/gitSnapshot';
import { MAIN_LIMITS } from '../lib/mainLimits';
import type { MainHost } from './mainHost';
import { mergeEmDashConfig, newEmDashConfig, emDashConfigIsWired } from '../parse/emdashConfig';
import { detectEmDash } from '../content/emdashProject';

const LIVE_CONFIG_FILES = ['src/live.config.ts', 'src/live.config.js', 'src/live.config.mjs', 'src/live.config.mts'] as const;
const ASTRO_CONFIG_FILES = ['astro.config.mjs', 'astro.config.ts', 'astro.config.js', 'astro.config.mts', 'astro.config.cjs'] as const;
const LOCKFILES: Readonly<Record<PackageManager, readonly string[]>> = {
  npm: ['package-lock.json'],
  pnpm: ['pnpm-lock.yaml'],
  yarn: ['yarn.lock'],
  bun: ['bun.lock', 'bun.lockb'],
};
/** The first major version of Astro the guide supports. */
const ASTRO_MAJOR_MIN = 6;
const FILE_BYTES_MAX = 4 * 1024 * 1024;

export interface EmDashInstallDeps {
  /** The streaming runner: program, arguments, folder, output callback, and the bounds. Injected so a test runs no process. */
  readonly runCommand: (
    program: string,
    args: readonly string[],
    cwd: string,
    onLog: (text: string) => void,
    options: { readonly signal: AbortSignal; readonly timeoutMs: number },
  ) => Promise<string>;
  /** Whether the project's git working tree has changes; undefined when it is not a repository or git is missing. */
  readonly gitDirty: (root: string) => Promise<boolean | undefined>;
  /** Saves everything as one commit with this message, through the app's own commit path; rejects when git refuses. */
  readonly commitAll: (root: string, message: string) => Promise<void>;
  readonly detect: (root: string) => Promise<EmDashProject>;
  /** The check the written config must pass when read back; injected so a test can force the rollback. */
  readonly verifyConfig: (text: string) => boolean;
  /** Restarts the project's running preview so it loads the new integration; its address, or undefined when none of ours runs. */
  readonly restartPreview: (root: string) => Promise<string | undefined>;
  /** Whether the address answers with anything but a server error. */
  readonly answers: (url: string) => Promise<boolean>;
  /** Waits this long between asks; injected so a test does not sleep. */
  readonly pause: (milliseconds: number) => Promise<void>;
}

export const DEFAULT_INSTALL_DEPS: EmDashInstallDeps = {
  runCommand: (program, args, cwd, onLog, options) => {
    // The package manager is a Node shim; a GUI launch has no PATH for it until this runs (nodeTools.ts).
    ensureToolPath();
    return runCreateCommand(program, args, cwd, onLog, options);
  },
  gitDirty: async (root) => {
    try {
      const { stdout } = await git(root, ['status', '--porcelain'], { timeout: 15_000 });
      return stdout.trim().length > 0;
    } catch {
      return undefined;
    }
  },
  commitAll: async (root, message) => {
    await commit(git, { projectPath: root, message });
  },
  detect: detectEmDash,
  verifyConfig: emDashConfigIsWired,
  // The real preview is main's; the handler registration replaces this (registerEmDashInstallHandlers).
  restartPreview: async () => undefined,
  answers: async (url) => {
    try {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      return response.status < 500;
    } catch {
      return false;
    }
  },
  pause: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

/** The package manager's arguments that add the guide's five packages. Fixed names only. */
export function addArguments(manager: PackageManager): readonly string[] {
  switch (manager) {
    case 'npm':
      return ['install', ...EMDASH_PACKAGES, '--no-audit', '--no-fund'];
    case 'pnpm':
      return ['add', ...EMDASH_PACKAGES, PNPM_TOLERATE_IGNORED_BUILDS];
    case 'yarn':
    case 'bun':
      return ['add', ...EMDASH_PACKAGES];
    default: {
      const exhaustive: never = manager;
      return exhaustive;
    }
  }
}

/** The command as the dialog shows it and as the run must be confirmed against. */
export function installCommandText(manager: PackageManager): string {
  return `${manager} ${addArguments(manager).join(' ')}`;
}

export async function planEmDashInstall(root: string, deps: Pick<EmDashInstallDeps, 'gitDirty'> = DEFAULT_INSTALL_DEPS): Promise<EmDashInstallPlan> {
  assert(path.isAbsolute(root), 'The install plan starts from an absolute project folder');
  const manifest = readJsonRecord(path.join(root, 'package.json'));
  if (manifest === undefined) {
    return { kind: 'unavailable', reason: 'noPackageJson' };
  }
  const dependencies = { ...recordOf(manifest['devDependencies']), ...recordOf(manifest['dependencies']) };
  if (!('astro' in dependencies)) {
    return { kind: 'unavailable', reason: 'notAstro' };
  }
  const major = astroMajor(root, dependencies['astro']);
  if (major !== undefined && major < ASTRO_MAJOR_MIN) {
    return { kind: 'unavailable', reason: 'astroTooOld' };
  }
  if ('emdash' in dependencies) {
    return { kind: 'unavailable', reason: 'alreadyInstalled' };
  }
  const manager = detectPackageManager(root);
  const files: EmDashInstallFile[] = [{ path: 'package.json', change: 'edit' }];
  const lockfile = LOCKFILES[manager].find((name) => fs.existsSync(path.join(root, name)));
  files.push({ path: lockfile ?? LOCKFILES[manager][0] ?? 'package-lock.json', change: lockfile === undefined ? 'create' : 'edit' });
  const live = LIVE_CONFIG_FILES.find((name) => fs.existsSync(path.join(root, name)));
  const configFile = ASTRO_CONFIG_FILES.find((name) => fs.existsSync(path.join(root, name)));
  files.push({ path: configFile ?? ASTRO_CONFIG_FILES[0], change: configFile === undefined ? 'create' : 'edit' });
  if (live === undefined) {
    files.push({ path: EMDASH_LIVE_CONFIG_FILE, change: 'create' });
  }
  const missingLines = missingIgnoreLines(root);
  if (missingLines.length > 0) {
    files.push({ path: '.gitignore', change: fs.existsSync(path.join(root, '.gitignore')) ? 'edit' : 'create' });
  }
  const warnings: EmDashInstallWarning[] = [];
  const saveFirst = (await deps.gitDirty(root)) === true;
  const config = firstText(root, ASTRO_CONFIG_FILES);
  if (config !== undefined && /\badapter\s*:/.test(config) && !/@astrojs\/node/.test(config)) {
    warnings.push('otherAdapter');
  }
  assert(files.length <= EMDASH_INSTALL_LIMITS.filesMax, 'The plan names a bounded number of files');
  return { kind: 'ready', manager, command: installCommandText(manager), files, saveFirst, warnings };
}

// One run at a time, for the whole app: a second request while one is out is refused, not queued.
let running: { readonly root: string; readonly controller: AbortController } | undefined;

/** Stops the run for this project, if there is one. Idempotent. */
export function cancelEmDashInstall(root: string): void {
  if (running?.root === root) {
    running.controller.abort();
  }
}

export interface EmDashInstallRequest {
  /** The command the person was shown; the run refuses to be anything else. */
  readonly confirmedCommand: string;
  readonly deps?: EmDashInstallDeps;
  readonly onLog: (text: string) => void;
}

export async function runEmDashInstall(root: string, request: EmDashInstallRequest): Promise<EmDashInstallResult> {
  const { confirmedCommand, onLog } = request;
  const deps = request.deps ?? DEFAULT_INSTALL_DEPS;
  assert(path.isAbsolute(root), 'The install starts from an absolute project folder');
  if (running !== undefined) {
    return { kind: 'refused', reason: 'busy' };
  }
  const plan = await planEmDashInstall(root, deps);
  if (plan.kind === 'unavailable') {
    return { kind: 'refused', reason: plan.reason };
  }
  if (plan.command !== confirmedCommand) {
    return { kind: 'refused', reason: 'notConfirmed' };
  }
  if (running !== undefined) {
    return { kind: 'refused', reason: 'busy' };
  }
  const controller = new AbortController();
  running = { root, controller };
  try {
    // Earlier work is saved first, as one commit, so it is one step back in History whatever the install does. Through the
    // app's own commit path, with the person's own git identity; never a push, never an amend. If git refuses (no identity,
    // a hook, a merge in progress), nothing is installed.
    if (plan.saveFirst) {
      onLog(`> ${EMDASH_SAVE_MESSAGE}\n\n`);
      try {
        await deps.commitAll(root, EMDASH_SAVE_MESSAGE);
      } catch {
        return { kind: 'failed', reason: 'saveFailed', changedFiles: [] };
      }
    }
    const before = snapshot(root);
    const installed = await install(root, plan, { controller, deps, onLog, before });
    if (installed.kind !== 'done') {
      return installed.result;
    }
    const preview = await restartAndWait(root, deps, onLog);
    const project = await deps.detect(root);
    return {
      kind: 'installed',
      complete: emDashIsWired(project),
      saved: plan.saveFirst,
      keyGenerated: installed.keyGenerated,
      databaseReady: installed.databaseReady,
      preview: preview.state,
      adminUrl: preview.adminUrl,
      config: installed.config,
      onDemand: installed.onDemand,
      project,
      changedFiles: changedSince(root, before),
      manual: manualStepsFor(project).filter((step) => step === 'astroConfig' || step === 'liveConfig'),
    };
  } finally {
    running = undefined;
  }
}

// The preview is restarted by main's own dev-server code (Astro never loads an integration added to a running server), then
// asked, on a bounded schedule, until the EmDash admin answers. A project whose preview is not running is left that way: the
// preview starts for the person when they open the project, and nothing here starts a second server.
async function restartAndWait(
  root: string,
  deps: EmDashInstallDeps,
  onLog: (text: string) => void,
): Promise<{ readonly state: EmDashPreviewState; readonly adminUrl: string | undefined }> {
  const origin = await deps.restartPreview(root);
  if (origin === undefined) {
    return { state: 'notRunning', adminUrl: undefined };
  }
  const adminUrl = `${origin.replace(/\/$/, '')}/_emdash/admin/`;
  const asks = Math.ceil(EMDASH_INSTALL_LIMITS.devServerWaitMsMax / EMDASH_INSTALL_LIMITS.devServerPollMs);
  for (let ask = 0; ask < asks; ask += 1) {
    if (await deps.answers(adminUrl)) {
      onLog('\n> the preview is back and EmDash answers\n');
      return { state: 'running', adminUrl };
    }
    await deps.pause(EMDASH_INSTALL_LIMITS.devServerPollMs);
  }
  return { state: 'failed', adminUrl: undefined };
}

type InstallStep =
  | { readonly kind: 'done'; readonly keyGenerated: boolean; readonly databaseReady: boolean; readonly config: EmDashConfigOutcome; readonly onDemand: boolean }
  | { readonly kind: 'stopped'; readonly result: EmDashInstallResult };

// The package manager command, then the two files Stacki writes itself (never over a file that exists), then EmDash's own
// key command when the project has no .env yet. A failure or a cancel stops here with the files that changed, reverting none.
async function install(
  root: string,
  plan: Extract<EmDashInstallPlan, { readonly kind: 'ready' }>,
  context: {
    readonly controller: AbortController;
    readonly deps: EmDashInstallDeps;
    readonly onLog: (text: string) => void;
    readonly before: ReadonlyMap<string, string>;
  },
): Promise<InstallStep> {
  const windows = process.platform === 'win32';
  let config: { readonly outcome: EmDashConfigOutcome; readonly onDemand: boolean } = { outcome: 'unchanged', onDemand: false };
  const options = { signal: context.controller.signal, timeoutMs: EMDASH_INSTALL_LIMITS.runMsMax };
  try {
    context.onLog(`> ${plan.command}\n\n`);
    await context.deps.runCommand(windows ? `${plan.manager}.cmd` : plan.manager, addArguments(plan.manager), root, context.onLog, options);
    writeLiveConfigIfAbsent(root);
    appendIgnoreLines(root);
    config = registerInAstroConfig(root, context.deps.verifyConfig);
  } catch (error: unknown) {
    const changedFiles = changedSince(root, context.before);
    const message = error instanceof Error ? error.message : String(error);
    if (context.controller.signal.aborted || message === RUN_CANCELLED) {
      return { kind: 'stopped', result: { kind: 'cancelled', changedFiles } };
    }
    return { kind: 'stopped', result: { kind: 'failed', reason: classifyInstallFailure(message), changedFiles } };
  }
  // The key is a secret EmDash's own command writes into .env; its output is not logged, so no key is ever shown. A run
  // that fails here is not a failed install: the step stays on the checklist.
  let keyGenerated = false;
  if (!fs.existsSync(path.join(root, '.env'))) {
    try {
      await context.deps.runCommand(windows ? 'npx.cmd' : 'npx', EMDASH_SECRETS_ARGUMENTS, root, () => undefined, options);
      keyGenerated = fs.existsSync(path.join(root, '.env'));
    } catch {
      keyGenerated = false;
    }
  }
  // EmDash's own `init` creates and migrates the local database, so the first visit has one and nothing asks the person to
  // run a server to get it. Not a failure if it does not finish: the preview creates the database on its first request.
  let databaseReady = false;
  try {
    await context.deps.runCommand(windows ? 'npx.cmd' : 'npx', EMDASH_INIT_ARGUMENTS, root, context.onLog, options);
    databaseReady = fs.existsSync(path.join(root, 'data.db'));
  } catch {
    databaseReady = false;
  }
  return { kind: 'done', keyGenerated, databaseReady, config: config.outcome, onDemand: config.onDemand };
}

// Registers EmDash in the project's Astro config: merged into the person's own (every untouched byte kept), or the guide's
// complete config when there is none. The merged text was already verified by the parser; it is written to a temporary file
// and moved into place, read back and checked once more, and the original bytes are put back if that check fails.
function registerInAstroConfig(root: string, verifyConfig: (text: string) => boolean): { readonly outcome: EmDashConfigOutcome; readonly onDemand: boolean } {
  const name = ASTRO_CONFIG_FILES.find((candidate) => fs.existsSync(path.join(root, candidate)));
  if (name === undefined) {
    writeAtomically(path.join(root, ASTRO_CONFIG_FILES[0]), newEmDashConfig());
    return { outcome: 'created', onDemand: true };
  }
  const target = path.join(root, name);
  const original = fs.readFileSync(target);
  const merged = mergeEmDashConfig(original.toString('utf8'));
  switch (merged.kind) {
    case 'unchanged':
      return { outcome: 'unchanged', onDemand: false };
    case 'otherAdapter':
    case 'unusualShape':
      return { outcome: merged.kind, onDemand: false };
    case 'merged': {
      writeAtomically(target, merged.text);
      if (!verifyConfig(fs.readFileSync(target, 'utf8'))) {
        fs.writeFileSync(target, original);
        return { outcome: 'unusualShape', onDemand: false };
      }
      return { outcome: 'merged', onDemand: merged.onDemand };
    }
    default: {
      const exhaustive: never = merged;
      return exhaustive;
    }
  }
}

function writeAtomically(target: string, text: string): void {
  const temporary = `${target}.stacki-${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, { flag: 'wx' });
  fs.renameSync(temporary, target);
}

function writeLiveConfigIfAbsent(root: string): void {
  if (LIVE_CONFIG_FILES.some((name) => fs.existsSync(path.join(root, name)))) {
    return;
  }
  const target = path.join(root, EMDASH_LIVE_CONFIG_FILE);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // `wx`: fails rather than overwrite, should a file appear between the check and the write.
  fs.writeFileSync(target, EMDASH_LIVE_CONFIG_TEXT, { flag: 'wx' });
}

function appendIgnoreLines(root: string): void {
  const missing = missingIgnoreLines(root);
  if (missing.length === 0) {
    return;
  }
  const target = path.join(root, '.gitignore');
  const existing = readText(target) ?? '';
  const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  fs.appendFileSync(target, `${separator}${missing.join('\n')}\n`);
}

function missingIgnoreLines(root: string): readonly string[] {
  const present = new Set(
    (readText(path.join(root, '.gitignore')) ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^\//, ''))
      .filter((line) => line.length > 0),
  );
  return EMDASH_IGNORE_LINES.filter((line) => !present.has(line) && !present.has(line.replace(/\/$/, '')));
}

// What a run can change, by content hash before and after (a missing file is its own value).
function watchedFiles(root: string): readonly string[] {
  const lockfiles = Object.values(LOCKFILES).flat();
  return ['package.json', '.env', ...lockfiles, ...LIVE_CONFIG_FILES, '.gitignore', ...ASTRO_CONFIG_FILES]
    .filter((name, index, all) => all.indexOf(name) === index)
    .map((name) => path.join(root, name));
}

function snapshot(root: string): ReadonlyMap<string, string> {
  const hashes = new Map<string, string>();
  for (const file of watchedFiles(root)) {
    hashes.set(file, hashOf(file));
  }
  return hashes;
}

function changedSince(root: string, before: ReadonlyMap<string, string>): readonly string[] {
  const changed: string[] = [];
  for (const [file, hash] of before) {
    if (hashOf(file) !== hash) {
      changed.push(path.relative(root, file).split(path.sep).join('/'));
    }
  }
  assert(changed.length <= EMDASH_INSTALL_LIMITS.filesMax, 'The changed files stay within the limit');
  return changed;
}

function hashOf(file: string): string {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return 'missing';
  }
}

function readText(file: string): string | undefined {
  try {
    if (fs.statSync(file).size > FILE_BYTES_MAX) {
      return undefined;
    }
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function firstText(root: string, names: readonly string[]): string | undefined {
  for (const name of names) {
    const found = readText(path.join(root, name));
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function readJsonRecord(file: string): Record<string, unknown> | undefined {
  const source = readText(file);
  if (source === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(source);
    return recordOf(parsed);
  } catch {
    return undefined;
  }
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

// The installed Astro when it is there, else the first number in the declared range ("^5.1.0" is 5); a range that names
// none ("latest", "workspace:*") is unknown and does not block.
function astroMajor(root: string, declared: unknown): number | undefined {
  const installed = readJsonRecord(path.join(root, 'node_modules', 'astro', 'package.json'))?.['version'];
  const source = typeof installed === 'string' ? installed : typeof declared === 'string' ? declared : '';
  const match = /(\d+)\./.exec(source) ?? /^\D*(\d+)$/.exec(source);
  return match?.[1] === undefined ? undefined : Number.parseInt(match[1], 10);
}

/** The three channels: the plan (read only), the run (which names the command shown) and its cancel. */
export function registerEmDashInstallHandlers(
  { ipcMain, send }: Pick<MainHost, 'ipcMain' | 'send'>,
  previews: {
    readonly current: () => { readonly url: string; readonly projectPath: string } | undefined;
    readonly restart: (projectPath: string) => Promise<string | undefined>;
  },
): void {
  const deps: EmDashInstallDeps = { ...DEFAULT_INSTALL_DEPS, restartPreview: previews.restart };
  ipcMain.handle('emdash:installPlan', (_event, { projectPath }) => planEmDashInstall(path.resolve(projectPath)));
  ipcMain.handle('emdash:install', (_event, { projectPath, confirmedCommand }) =>
    runEmDashInstall(path.resolve(projectPath), {
      confirmedCommand,
      deps,
      onLog: (text) => send('emdash:installLog', text.slice(0, MAIN_LIMITS.logChunkCharsMax)),
    }),
  );
  ipcMain.handle('emdash:adminUrl', (_event, { projectPath }) => {
    const preview = previews.current();
    return { url: preview !== undefined && path.resolve(preview.projectPath) === path.resolve(projectPath) ? preview.url : undefined };
  });
  ipcMain.handle('emdash:installCancel', (_event, { projectPath }) => {
    cancelEmDashInstall(path.resolve(projectPath));
    return { ok: true } as const;
  });
}
