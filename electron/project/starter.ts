import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

import { toRecord } from '../../shared/core/record';
import { commandNeedsShell } from '../lib/platform';
import { stopProcessTree } from '../lib/nodeTools';
import { packageManagerProgram, type PackageManager } from '../../shared/properties/packageManager';

// Starting a site from a starter.
//
// The framework publishes its own scaffolder, so the app runs that rather than
// copying files itself: `npm create lumos@latest my-site`. It is the command
// the framework's own documentation gives, which means a site started here is
// the same site as one started in a terminal — and when the starter changes
// what a new site needs, the change arrives without this app being rebuilt.
//
// What it leaves behind is files: no history, and no remote pointing at a
// repository the user cannot push to. So the first commit is made here, of the
// starter as it stands, which is what they are actually starting from.

const isWin = process.platform === 'win32';

interface Starter {
  readonly label: string;
  readonly create: string;
}

const STARTERS: Record<string, Starter> = {
  lumos: {
    // i18n-ignore: starter template name: a product term.
    label: 'Lumos',
    // Pinned to `@latest` rather than a version: the scaffolder is downloaded
    // per run, and a site started today should be started from today's.
    create: 'lumos@latest',
  },
};

// A folder name has to be a folder name; the site can be renamed later, but not
// out of a directory that already exists.
const NAME_RE = /^[A-Za-z0-9._-]+$/;

type OnLog = (text: string) => void;

// A scaffolder only downloads a template, so a run this long has stalled, and the wizard
// cannot be closed while it waits.
const RUN_TIMEOUT_MS = 5 * 60 * 1000;
/** The message of the error a stopped run rejects with, so a caller can tell a cancel from a failure. */
export const RUN_CANCELLED = 'The command was cancelled.';

/** A caller that must be able to stop a run, or give it more (or less) time than a scaffolder needs. */
interface RunOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Extra variables for this child only, laid over the app's own. */
  readonly environment?: Readonly<Record<string, string>>;
}

// The Lumos scaffolder (create-lumos 0.3.9) links its skill folders with symlinks and, where Windows refuses them
// (no Developer Mode, no admin), falls back to `copyFile` on the folder, which always fails with EPERM. This preload
// makes that one fallback copy the folder instead. It touches nothing else: files go to the original `copyFile`.
const COPY_DIRECTORIES_SHIM = `const fsp = require('node:fs/promises');
const { statSync } = require('node:fs');
const original = fsp.copyFile;
fsp.copyFile = async function copyFile(source, target, mode) {
  let directory = false;
  try {
    directory = statSync(source).isDirectory();
  } catch {
    directory = false;
  }
  if (directory) {
    return fsp.cp(source, target, { recursive: true });
  }
  return original.call(this, source, target, mode);
};
require('node:module').syncBuiltinESMExports();
`;

// NODE_OPTIONS for a scaffolder run: the shim written to the temp folder, joined to whatever the person already set.
function scaffolderEnvironment(): Readonly<Record<string, string>> {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-scaffold-'));
  const file = path.join(folder, 'copyDirectories.cjs');
  fs.writeFileSync(file, COPY_DIRECTORIES_SHIM, 'utf8');
  // Forward slashes: a backslash escapes inside the quotes NODE_OPTIONS reads.
  const preload = `--require "${file.replace(/\\/g, '/')}"`;
  const existing = process.env['NODE_OPTIONS'];
  return { NODE_OPTIONS: existing === undefined || existing.length === 0 ? preload : `${existing} ${preload}` };
}

const run = (cmd: string, args: readonly string[], cwd: string, onLog?: OnLog, options: RunOptions = {}): Promise<string> =>
  new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(cmd, [...args], {
        cwd,
        // On Windows npm is a .cmd shim, which needs a shell to be found.
        shell: commandNeedsShell(cmd),
        // Its own process group, so a stalled run is stopped with what it started.
        detached: !isWin,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          FORCE_COLOR: '0',
          NO_COLOR: '1',
          CI: '1', // npm asks before downloading a scaffolder; nobody is here to answer
          ...options.environment,
        },
      });
    } catch (error: unknown) {
      reject(new Error(`Could not run ${cmd}: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    const child = proc;
    const timeoutMs = options.timeoutMs ?? RUN_TIMEOUT_MS;
    const timer = setTimeout(() => {
      stopProcessTree(child);
      reject(new Error(`${path.basename(cmd)} ${args[0] ?? ''} took over ${Math.round(timeoutMs / 60000)} minutes and was stopped.`));
    }, timeoutMs);
    // Cancel stops the whole process tree and settles at once; the `exit` that follows is then ignored by the promise.
    const cancel = (): void => {
      clearTimeout(timer);
      stopProcessTree(child);
      reject(new Error(RUN_CANCELLED));
    };
    if (options.signal?.aborted === true) {
      cancel();
    } else {
      options.signal?.addEventListener('abort', cancel, { once: true });
    }
    let tail = '';
    const onOut = (chunk: { toString(): string }): void => {
      // Progress spinners are drawn with cursor moves and line clears; strip
      // them so the log pane reads as the plain text it renders.
      const text = chunk
        .toString()
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
        .replace(/\r/g, '\n');
      tail = (tail + text).slice(-4000);
      onLog?.(text);
    };
    proc.stdout.on('data', onOut);
    proc.stderr.on('data', onOut);
    proc.on('error', (error: Error) => {
      clearTimeout(timer);
      const code = toRecord(error)?.['code'];
      reject(
        new Error(
          code === 'ENOENT'
            ? path.basename(cmd).startsWith('npm')
              ? 'npm could not be found. Install Node.js (which includes npm) and try again.'
              : `${cmd} could not be found. Install it and try again.`
            : `Could not run ${cmd}: ${error.message}`,
        ),
      );
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(tail);
      } else {
        reject(new Error(`${cmd} ${args[0] ?? ''} exited with code ${code}.\n\n${tail}`));
      }
    });
  });

interface CreateStarterOptions {
  readonly starter?: string;
  readonly parentPath?: string;
  readonly name?: string;
  /** The npm command to run, so a test can hand it one that needs no network. */
  readonly npm?: string;
  /** The manager the person chose. Bun runs the scaffolder itself (`bun create`); the others run it through npm, which every Node install has. */
  readonly manager?: PackageManager;
  readonly onLog?: OnLog;
}

// Bun has its own `create`, which downloads and runs the scaffolder. It takes no `--yes` and no `--` separator:
// what follows the folder name goes to the scaffolder as it is.
function scaffolderCommand(
  manager: PackageManager | undefined,
  create: string,
  folder: string,
): { readonly label: string; readonly program: string; readonly args: readonly string[] } {
  if (manager === 'bun') {
    return { label: 'bun', program: packageManagerProgram('bun', { windows: isWin }), args: ['create', create, folder, '--no-install'] };
  }
  return { label: 'npm', program: packageManagerProgram('npm', { windows: isWin }), args: ['create', create, folder, '--yes', '--', '--no-install'] };
}

/**
 * Runs a starter's scaffolder in `parentPath` to make `parentPath/name`.
 * Installing what it needs and its first commit (`startSiteHistory`) are the
 * caller's — this is the part that has to be right before anything is
 * installed into it.
 */
async function createStarter({ starter = 'lumos', parentPath, name, npm, manager, onLog }: CreateStarterOptions = {}): Promise<{
  ok: boolean;
  projectPath: string;
}> {
  const template = STARTERS[starter];
  if (!template) {
    throw new Error(`${starter} is not a starter this app knows.`);
  }
  const directory = newSiteDirectory(parentPath, name);
  const folder = path.basename(directory);

  // `--no-install`: the app installs afterwards, where a failure is an error
  // the wizard can show rather than a line in a log that scrolled past.
  const command = scaffolderCommand(manager, template.create, folder);
  onLog?.(`> ${command.label} create ${template.create} ${folder}\n\n`);
  await run(npm || command.program, command.args, path.dirname(directory), onLog, { environment: scaffolderEnvironment() });

  if (!fs.existsSync(path.join(directory, 'package.json'))) {
    throw new Error('The starter finished but there is no package.json in it.');
  }

  // The package is the site, so it takes the site's name. The scaffolder does
  // this too; doing it here is what makes it a promise this app keeps rather
  // than one it hopes for.
  try {
    const file = path.join(directory, 'package.json');
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    const pkg = toRecord(raw);
    if (pkg) {
      pkg['name'] = folder.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
      fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    }
  } catch {
    /* an unusual package.json is not worth failing the site over */
  }

  return { ok: true, projectPath: directory };
}

/**
 * Gives a new site a history of its own: one commit of the site as it stands.
 * The caller runs it after the install, so the lockfile is part of that commit.
 */
async function startSiteHistory(directory: string, label: string, onLog?: OnLog): Promise<void> {
  // A scaffolder that started a history of its own has already done this, and
  // its first commit is the one to keep.
  if (fs.existsSync(path.join(directory, '.git'))) {
    return;
  }
  onLog?.('\n> starting a history for this site\n');
  try {
    await run('git', ['init', '-b', 'main'], directory);
    await run('git', ['add', '-A'], directory);
    // A first-time Git installation has no author configured yet. Give only
    // this generated commit a neutral identity; do not change the user's
    // repository or global configuration behind their back.
    await run(
      'git',
      ['-c', 'user.name=Stacki', '-c', 'user.email=stacki@local.invalid', 'commit', '-m', `Start ${path.basename(directory)} from ${label}`],
      directory,
    );
  } catch (error: unknown) {
    // A site with no git still runs; say so rather than throwing it away.
    const reason = error instanceof Error ? error.message : String(error);
    onLog?.(`\n(could not start a git history: ${reason})\n`);
  }
}

/**
 * The folder a new site gets, `parentPath/name`, which must not exist yet. The
 * starter and the Astro wizard both use it, so the name rules and their
 * messages are the same in either flow.
 */
function newSiteDirectory(parentPath: string | undefined, name: string | undefined): string {
  if (!parentPath || !fs.existsSync(parentPath)) {
    throw new Error('Choose where the site should go first.');
  }
  const folder = String(name || '').trim();
  if (!folder) {
    throw new Error('Give the site a name.');
  }
  if (!NAME_RE.test(folder)) {
    throw new Error('Use letters, numbers, dashes, dots or underscores for the folder name.');
  }
  const directory = path.join(parentPath, folder);
  if (fs.existsSync(directory)) {
    throw new Error(`${folder} already exists in that folder.`);
  }
  return directory;
}

export { createStarter, newSiteDirectory, run as runCreateCommand, scaffolderEnvironment, startSiteHistory, STARTERS };
