// Adding EmDash to an existing Astro project, the contract. The procedure is EmDash's own guide "Add EmDash to an existing
// Astro project" (docs/src/content/docs/existing-project.mdx in github.com/emdash-cms/emdash, MIT): install five packages,
// register the Node adapter, React and emdash() in the Astro config, create src/live.config.ts with the `_emdash` live
// collection, generate a local encryption key, and keep the database, uploads and .env out of git.
//
// What Stacki does itself, and why that part only: the install (one package manager command, run from this module's
// vetted arguments with no shell), the new src/live.config.ts when the project has none (a file Stacki writes whole, never
// over an existing one), and the .gitignore lines. The Astro config is the person's own code and EmDash documents it as
// "keep what is there and add these entries", which Stacki has no safe editor for, so it stays a shown step, as does merging
// into an existing live config, the key command and the setup wizard. Nothing here is a success until detection
// (`detectEmDash`) finds EmDash set up after the run.
//
// Everything that crosses to the renderer passes the parsers below (AGENTS.md rule 5).

import { assert } from '../core/assert';
import { boolean, list, object, pathText, record, text } from '../core/boundary';
import { parseEmDashProject, type EmDashProject } from './emdash';
import { PACKAGE_MANAGERS, type PackageManager } from './packageManager';

export const EMDASH_INSTALL_LIMITS = {
  /** The streamed log kept for the dialog; older text is dropped from the front. */
  logCharsMax: 64_000,
  /** A package install that takes this long has stalled; it is stopped and said so. */
  runMsMax: 10 * 60 * 1000,
  /** Files named in a plan or a result. */
  filesMax: 16,
  /** What the error classifier reads: the end of the output, where the reason is. */
  outputTailCharsMax: 4000,
} as const satisfies Record<string, number>;

/** The five packages EmDash's guide installs (React is for the admin panel even when the public site has none). */
export const EMDASH_PACKAGES = ['emdash', '@astrojs/node', '@astrojs/react', 'react', 'react-dom'] as const;

export const EMDASH_LIVE_CONFIG_FILE = 'src/live.config.ts';
/** The guide's own file, written only when the project has no live config at all. */
export const EMDASH_LIVE_CONFIG_TEXT = [
  'import { defineLiveCollection } from "astro:content";',
  'import { emdashLoader } from "emdash/runtime";',
  '',
  'export const collections = {',
  '\t_emdash: defineLiveCollection({ loader: emdashLoader() }),',
  '};',
  '',
].join('\n');
/** The paths the guide says to keep out of git (EmDash's local database, its media folder and the key file). */
export const EMDASH_IGNORE_LINES = ['data.db', 'uploads/', '.env'] as const;
/** The guide's key command. Stacki runs it itself (its output is never shown, so a key is never on screen) only when the project has no .env yet. */
export const EMDASH_SECRETS_COMMAND = 'npx emdash secrets generate --write .env';
export const EMDASH_SECRETS_ARGUMENTS = ['emdash', 'secrets', 'generate', '--write', '.env'] as const;
/** The commit made first when the project has uncommitted work, so everything before EmDash stays one step back in History. */
export const EMDASH_SAVE_MESSAGE = 'Before Adding EmDash';
/** The guide's Astro config, shown for the person to merge. */
export const EMDASH_CONFIG_EXAMPLE = [
  'import node from "@astrojs/node";',
  'import react from "@astrojs/react";',
  'import { defineConfig } from "astro/config";',
  'import emdash, { local } from "emdash/astro";',
  'import { sqlite } from "emdash/db";',
  '',
  'export default defineConfig({',
  '  output: "server",',
  '  adapter: node({ mode: "standalone" }),',
  '  integrations: [',
  '    react(),',
  '    emdash({',
  '      database: sqlite({ url: "file:./data.db" }),',
  '      storage: local({ directory: "./uploads", baseUrl: "/_emdash/api/media/file" }),',
  '    }),',
  '  ],',
  '});',
].join('\n');

export const EMDASH_MANUAL_STEPS = ['astroConfig', 'liveConfig', 'secrets', 'admin'] as const;
export type EmDashManualStep = (typeof EMDASH_MANUAL_STEPS)[number];

export const EMDASH_INSTALL_WARNINGS = ['otherAdapter'] as const;
export type EmDashInstallWarning = (typeof EMDASH_INSTALL_WARNINGS)[number];

/** Why nothing can be added: the plan is `unavailable` and the dialog says which. */
/** What the run did to the Astro config: wrote a new one, merged EmDash into the person's, found it already there, or left it alone and why. */
export const EMDASH_CONFIG_OUTCOMES = ['created', 'merged', 'unchanged', 'otherAdapter', 'unusualShape'] as const;
export type EmDashConfigOutcome = (typeof EMDASH_CONFIG_OUTCOMES)[number];

export const EMDASH_INSTALL_REFUSALS = ['noPackageJson', 'notAstro', 'astroTooOld', 'alreadyInstalled', 'busy', 'notConfirmed'] as const;
export type EmDashInstallRefusal = (typeof EMDASH_INSTALL_REFUSALS)[number];

export const EMDASH_INSTALL_FAILURES = [
  'saveFailed',
  'noNetwork',
  'managerMissing',
  'peerConflict',
  'engineMismatch',
  'permission',
  'timeout',
  'other',
] as const;
export type EmDashInstallFailure = (typeof EMDASH_INSTALL_FAILURES)[number];

export interface EmDashInstallFile {
  /** Project-relative, forward slashes. */
  readonly path: string;
  readonly change: 'edit' | 'create';
}

export type EmDashInstallPlan =
  | { readonly kind: 'unavailable'; readonly reason: EmDashInstallRefusal }
  | {
      readonly kind: 'ready';
      readonly manager: PackageManager;
      /** The command exactly as it will run, for display and for the confirmation to name. */
      readonly command: string;
      readonly files: readonly EmDashInstallFile[];
      /** The working tree has changes: the run saves them as one commit named EMDASH_SAVE_MESSAGE before installing. */
      readonly saveFirst: boolean;
      readonly warnings: readonly EmDashInstallWarning[];
    };

export type EmDashInstallResult =
  | { readonly kind: 'refused'; readonly reason: EmDashInstallRefusal }
  /** The command succeeded. `complete` is true only when detection then finds EmDash set up with nothing left to do. */
  | {
      readonly kind: 'installed';
      readonly complete: boolean;
      /** The earlier work was saved as a commit first. */
      readonly saved: boolean;
      /** Stacki ran EmDash's key command; false when a .env already existed or the command did not finish. */
      readonly keyGenerated: boolean;
      readonly config: EmDashConfigOutcome;
      /** The config's `output` was static or unset and is now server: the site renders pages on request. */
      readonly onDemand: boolean;
      readonly project: EmDashProject;
      readonly changedFiles: readonly string[];
      readonly manual: readonly EmDashManualStep[];
    }
  | { readonly kind: 'failed'; readonly reason: EmDashInstallFailure; readonly changedFiles: readonly string[] }
  | { readonly kind: 'cancelled'; readonly changedFiles: readonly string[] };

/** Which of the guide's steps the project still needs, from what detection reports. */
export function manualStepsFor(project: EmDashProject): readonly EmDashManualStep[] {
  const steps: EmDashManualStep[] = [];
  if (project.kind === 'absent') {
    return ['astroConfig', 'secrets', 'admin'];
  }
  if (project.problems.includes('noIntegration') || project.problems.includes('staticOutput') || project.problems.includes('notInstalled')) {
    steps.push('astroConfig');
  }
  if (project.problems.includes('noLiveCollection')) {
    steps.push('liveConfig');
  }
  if (project.problems.includes('noDatabase')) {
    steps.push('secrets', 'admin');
  }
  return steps;
}

/** Set up as the guide's end state, as far as Stacki can tell: installed, wired into the config and the live collection, server output. */
export function emDashIsWired(project: EmDashProject): boolean {
  if (project.kind === 'absent') {
    return false;
  }
  const blocking = ['notInstalled', 'noIntegration', 'noLiveCollection', 'staticOutput'] as const;
  return !blocking.some((problem) => project.problems.includes(problem));
}

/** Reads the end of a failed command's output for the reason, so the dialog says it in words. Total: unknown output is `other`. */
export function classifyInstallFailure(output: string): EmDashInstallFailure {
  const tail = output.slice(-EMDASH_INSTALL_LIMITS.outputTailCharsMax);
  assert(tail.length <= EMDASH_INSTALL_LIMITS.outputTailCharsMax, 'The classified output is bounded');
  if (/took over \d+ minutes and was stopped/i.test(tail)) {
    return 'timeout';
  }
  if (/could not be found|ENOENT|not recognized as an internal/i.test(tail)) {
    return 'managerMissing';
  }
  if (/ERESOLVE|peer dep|unable to resolve dependency tree|ERR_PNPM_PEER/i.test(tail)) {
    return 'peerConflict';
  }
  if (/EBADENGINE|Unsupported engine|engine "node"|The engine "node" is incompatible/i.test(tail)) {
    return 'engineMismatch';
  }
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|network|getaddrinfo|FETCH_ERROR/i.test(tail)) {
    return 'noNetwork';
  }
  if (/EACCES|EPERM|permission denied/i.test(tail)) {
    return 'permission';
  }
  return 'other';
}

function oneOf<T extends string>(allowed: readonly T[], what: string): (input: unknown) => T {
  return (input: unknown): T => {
    const found = allowed.find((candidate) => candidate === input);
    if (found === undefined) {
      throw new Error(`EmDash install: unknown ${what}`);
    }
    return found;
  };
}

const parseFiles = list(
  object({
    path: pathText,
    change: oneOf(['edit', 'create'] as const, 'file change'),
  }),
);
const parseChangedFiles = list(pathText);

function bounded<T>(items: readonly T[], what: string): readonly T[] {
  if (items.length > EMDASH_INSTALL_LIMITS.filesMax) {
    throw new Error(`EmDash install: too many ${what}`);
  }
  return items;
}

export function parseEmDashInstallPlan(input: unknown): EmDashInstallPlan {
  const value = record(input);
  if (value['kind'] === 'unavailable') {
    return { kind: 'unavailable', reason: oneOf(EMDASH_INSTALL_REFUSALS, 'refusal')(value['reason']) };
  }
  if (value['kind'] !== 'ready') {
    throw new Error('EmDash install: unknown plan');
  }
  return {
    kind: 'ready',
    manager: oneOf(PACKAGE_MANAGERS, 'package manager')(value['manager']),
    command: text(value['command']),
    files: bounded(parseFiles(value['files']), 'files'),
    saveFirst: boolean(value['saveFirst']),
    warnings: list(oneOf(EMDASH_INSTALL_WARNINGS, 'warning'))(value['warnings']),
  };
}

export function parseEmDashInstallResult(input: unknown): EmDashInstallResult {
  const value = record(input);
  switch (value['kind']) {
    case 'refused':
      return { kind: 'refused', reason: oneOf(EMDASH_INSTALL_REFUSALS, 'refusal')(value['reason']) };
    case 'installed':
      return {
        kind: 'installed',
        complete: boolean(value['complete']),
        saved: boolean(value['saved']),
        keyGenerated: boolean(value['keyGenerated']),
        config: oneOf(EMDASH_CONFIG_OUTCOMES, 'config outcome')(value['config']),
        onDemand: boolean(value['onDemand']),
        project: parseEmDashProject(value['project']),
        changedFiles: bounded(parseChangedFiles(value['changedFiles']), 'files'),
        manual: list(oneOf(EMDASH_MANUAL_STEPS, 'step'))(value['manual']),
      };
    case 'failed':
      return {
        kind: 'failed',
        reason: oneOf(EMDASH_INSTALL_FAILURES, 'failure')(value['reason']),
        changedFiles: bounded(parseChangedFiles(value['changedFiles']), 'files'),
      };
    case 'cancelled':
      return { kind: 'cancelled', changedFiles: bounded(parseChangedFiles(value['changedFiles']), 'files') };
    default:
      throw new Error('EmDash install: unknown result');
  }
}

/** The request that runs it: the command the person was shown, so main refuses to run anything else. */
export const parseEmDashInstallRequest = object({ projectPath: pathText, confirmedCommand: text });

/** Appends streamed output to the kept log, dropping the oldest text past the limit. */
export function appendInstallLog(log: string, chunk: string): string {
  const joined = log + chunk;
  return joined.length > EMDASH_INSTALL_LIMITS.logCharsMax ? joined.slice(joined.length - EMDASH_INSTALL_LIMITS.logCharsMax) : joined;
}
