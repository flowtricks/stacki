// The Cloudflare publishing tool (Wrangler), installed by Stacki into a folder Stacki owns, so a person who has never
// opened a terminal can connect Cloudflare with one click. Why an app-owned folder rather than the site or a global
// install: a global install can need sudo and differs on every machine; installing into the site edits the person's
// package.json behind their back. One pinned version under the app's own data folder serves every site.
//
// How an install stays safe and whole:
// - The version is pinned and the tarball's integrity is pinned beside it. npm checks every tarball against the
//   registry's hash, and after the install the lockfile's hash for Wrangler must equal the pinned one, so a registry or
//   mirror serving other bytes is refused.
// - npm runs with `--ignore-scripts`: signing in, listing accounts and deploying need no install script, and skipping
//   them means no package code runs while installing.
// - npm writes into a fresh staging folder; only a verified install is renamed into place, so an interrupted, offline
//   or failed install never leaves a half-written tool where detection would find it.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { assert } from '../../shared/core/assert';
import { toRecord } from '../../shared/core/record';
import { err, ok, type Result } from '../../shared/core/result';
import { toolPathHome } from '../lib/nodeTools';

/** The Wrangler Stacki installs: the version Studio ships with, and the sha512 npm's registry publishes for its tarball. */
export const WRANGLER_PIN = {
  name: 'wrangler',
  version: '4.151.1',
  integrity: 'sha512-OAsa9UAHZshM6mq2PXcVoyxXgWThAanZMBc/IirtqEWd/BauRtmUKzAniOu/pU0pd3pxKuMZ2vsbF4eo6RiNDA==',
} as const;

// Bounds beside the code that enforces them (shared/core/limits.ts changes only with a person's approval).
const TOOL_INSTALL_LIMITS = {
  // A package manifest is a few kilobytes; anything far larger is not the file it claims to be.
  manifestBytesMax: 65_536,
  // Wrangler's whole dependency tree locks in well under a megabyte; sixteen leaves room for growth.
  lockfileBytesMax: 16_777_216,
  // Leftover staging and version folders swept per install; more than this means something else writes here.
  sweptEntriesMax: 64,
} as const;

const STAGING_PREFIX = '.staging-';

// The tools folder this process uses. Worked out from the home folder on first use; a test points it at a temporary
// folder so no test can read or write the person's real tools.
let toolsDirectoryOverride: string | undefined = undefined;
export function setAppToolsDirectory(directory: string | undefined): void {
  assert(directory === undefined || path.isAbsolute(directory), 'The tools folder override is absolute');
  toolsDirectoryOverride = directory;
}
export function appToolsDirectory(): string {
  return toolsDirectoryOverride ?? publishToolsDirectory(toolPathHome ?? homedir(), process.platform, process.env);
}

/** The folder Stacki keeps its own tools in: the app's data folder, worked out without Electron so Studio shares it. */
export function publishToolsDirectory(home: string, platform: NodeJS.Platform, environment: Readonly<Record<string, string | undefined>>): string {
  // The target platform's own path rules, so Windows paths are worked out correctly wherever this runs.
  const paths = platform === 'win32' ? path.win32 : path.posix;
  assert(paths.isAbsolute(home), 'The tools folder starts from an absolute home');
  const directory = paths.join(toolsBase(home, platform, environment, paths), 'Stacki', 'tools');
  assert(paths.isAbsolute(directory), 'The tools folder is absolute');
  return directory;
}

function toolsBase(home: string, platform: NodeJS.Platform, environment: Readonly<Record<string, string | undefined>>, paths: path.PlatformPath): string {
  if (platform === 'darwin') {
    return paths.join(home, 'Library', 'Application Support');
  }
  if (platform === 'win32') {
    const appData = environment['APPDATA'];
    // Only an absolute APPDATA counts: a relative one would land the tools wherever the app was started.
    return appData !== undefined && paths.isAbsolute(appData) ? appData : paths.join(home, 'AppData', 'Roaming');
  }
  const config = environment['XDG_CONFIG_HOME'];
  return config !== undefined && paths.isAbsolute(config) ? config : paths.join(home, '.config');
}

/** The folder one pinned Wrangler lives in; its node_modules holds the package. */
export function wranglerToolRoot(tools: string): string {
  assert(path.isAbsolute(tools), 'The tools folder is absolute');
  return path.join(tools, WRANGLER_PIN.name, WRANGLER_PIN.version);
}

export type ToolCheck =
  { readonly kind: 'ready' } | { readonly kind: 'missing' } | { readonly kind: 'mismatch'; readonly version: string } | { readonly kind: 'corrupt' };

/** Whether the app-owned Wrangler is there, whole, and the pinned version. */
export function checkAppWrangler(tools: string): ToolCheck {
  const manifest = path.join(wranglerToolRoot(tools), 'node_modules', WRANGLER_PIN.name, 'package.json');
  if (!existsSync(manifest)) {
    return { kind: 'missing' };
  }
  const value = readBoundedJSON(manifest, TOOL_INSTALL_LIMITS.manifestBytesMax);
  if (value === undefined) {
    return { kind: 'corrupt' };
  }
  const fields = toRecord(value);
  if (fields === undefined) {
    return { kind: 'corrupt' };
  }
  if (fields['name'] !== WRANGLER_PIN.name) {
    return { kind: 'corrupt' };
  }
  const version = fields['version'];
  if (typeof version !== 'string') {
    return { kind: 'corrupt' };
  }
  if (version !== WRANGLER_PIN.version) {
    return { kind: 'mismatch', version: version.slice(0, 64) };
  }
  return { kind: 'ready' };
}

/** One planned install: npm runs in `staging`, and a verified result is renamed to `target`. */
export interface ToolInstallPlan {
  readonly tools: string;
  readonly staging: string;
  readonly target: string;
  readonly arguments: readonly string[];
}

export type ToolInstallFailure = 'disk' | 'verify';

/**
 * The plan for installing the pinned Wrangler: a staging folder beside the target (same disk, so the final rename is
 * atomic), and npm's arguments. Every setting that matters is passed explicitly, so a person's own npm config (a global
 * prefix, no lockfile, install scripts) cannot change where or how the tool lands.
 */
export function wranglerInstallPlan(tools: string, nonce: string): ToolInstallPlan {
  assert(/^[a-zA-Z0-9-]{1,64}$/.test(nonce), 'A staging nonce is a plain token');
  const target = wranglerToolRoot(tools);
  const staging = path.join(path.dirname(target), `${STAGING_PREFIX}${nonce}`);
  assert(path.dirname(staging) === path.dirname(target), 'Staging sits beside the target');
  return {
    tools,
    staging,
    target,
    arguments: [
      'install',
      '--prefix',
      staging,
      '--global=false',
      '--package-lock=true',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-update-notifier',
      '--omit=dev',
      '--loglevel=error',
    ],
  };
}

/** Sweeps what an earlier install left behind, then creates the staging folder npm installs into. */
export function prepareWranglerInstall(tools: string, nonce: string = randomUUID()): Result<ToolInstallPlan, ToolInstallFailure> {
  const plan = wranglerInstallPlan(tools, nonce);
  try {
    sweepToolFolder(path.dirname(plan.target), plan.target);
    mkdirSync(plan.staging, { recursive: true });
    const manifest = { name: 'stacki-publish-tools', private: true, dependencies: { [WRANGLER_PIN.name]: WRANGLER_PIN.version } };
    writeFileSync(path.join(plan.staging, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`, { flag: 'wx' });
  } catch {
    discardWranglerInstall(plan);
    return err('disk');
  }
  assert(existsSync(path.join(plan.staging, 'package.json')), 'The staging manifest was written');
  return ok(plan);
}

/**
 * Verifies a finished npm run and moves it into place. The lockfile must name the pinned version with the pinned hash,
 * and the installed manifest must agree; anything else is discarded and reported, never used.
 */
export function finishWranglerInstall(plan: ToolInstallPlan): Result<void, ToolInstallFailure> {
  assert(existsSync(plan.staging), 'A finished install has its staging folder');
  if (!stagedWranglerVerified(plan.staging)) {
    discardWranglerInstall(plan);
    return err('verify');
  }
  try {
    // A target already there is an older partial or damaged copy (a whole one would have been used, not reinstalled).
    rmSync(plan.target, { recursive: true, force: true });
    renameSync(plan.staging, plan.target);
  } catch {
    discardWranglerInstall(plan);
    return err('disk');
  }
  assert(!existsSync(plan.staging), 'The staging folder became the target');
  const check = checkAppWrangler(plan.tools);
  assert(check.kind === 'ready', 'A verified install is detected as ready');
  return ok(undefined);
}

/** Removes a staging folder that will not be used. Never touches the target. */
export function discardWranglerInstall(plan: Pick<ToolInstallPlan, 'staging' | 'target'>): void {
  assert(plan.staging !== plan.target, 'Discarding never removes the installed tool');
  assert(path.basename(plan.staging).startsWith(STAGING_PREFIX), 'Only staging folders are discarded');
  try {
    rmSync(plan.staging, { recursive: true, force: true });
  } catch {
    // A folder that cannot be removed now is swept by the next install.
  }
}

function stagedWranglerVerified(staging: string): boolean {
  const lockfile = toRecord(readBoundedJSON(path.join(staging, 'package-lock.json'), TOOL_INSTALL_LIMITS.lockfileBytesMax));
  const locked = toRecord(toRecord(lockfile?.['packages'])?.[`node_modules/${WRANGLER_PIN.name}`]);
  if (locked === undefined) {
    return false;
  }
  if (locked['version'] !== WRANGLER_PIN.version) {
    return false;
  }
  if (locked['integrity'] !== WRANGLER_PIN.integrity) {
    return false;
  }
  const manifest = toRecord(readBoundedJSON(path.join(staging, 'node_modules', WRANGLER_PIN.name, 'package.json'), TOOL_INSTALL_LIMITS.manifestBytesMax));
  return manifest?.['version'] === WRANGLER_PIN.version;
}

// Old staging folders and other Wrangler versions under the tool folder; the current target stays.
function sweepToolFolder(folder: string, target: string): void {
  let entries: readonly string[];
  try {
    entries = readdirSync(folder);
  } catch {
    return;
  }
  for (const name of entries.slice(0, TOOL_INSTALL_LIMITS.sweptEntriesMax)) {
    const entry = path.join(folder, name);
    if (entry === target) {
      continue;
    }
    if (name.startsWith(STAGING_PREFIX) || /^\d+\.\d+\.\d+/.test(name)) {
      rmSync(entry, { recursive: true, force: true });
    }
  }
}

function readBoundedJSON(file: string, bytesMax: number): unknown {
  try {
    if (statSync(file).size > bytesMax) {
      return undefined;
    }
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return typeof value === 'object' && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
}
