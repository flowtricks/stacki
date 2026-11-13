// The project IPC: opening and creating projects (from a dialog, the Astro
// template or a starter), and installing their dependencies.

import { gitErrorDetail } from '../git/git';
import { toRecord } from '../../shared/core/record';
import { assert } from '../../shared/core/assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { createStarter, newSiteDirectory, runCreateCommand, startSiteHistory, STARTERS } from '../project/starter';
import { isWin } from '../lib/mainHelpers';
import { ensureToolPath, run } from '../lib/nodeTools';
import { isAstroProject } from '../project/projectFiles';
import { detectPackageManager, installArguments } from '../project/packageManager';
import { packageManagerLabel, type PackageManager } from '../../shared/properties/packageManager';
import type { MainHost } from './mainHost';
import { translateMain } from '../lib/mainLocale';

export function registerProjectHandlers(host: Pick<MainHost, 'ipcMain' | 'send' | 'showOpenDialog'>): void {
  registerProjectOpenDialogHandlers(host);
  registerProjectCreateAstroHandlers(host);
  registerProjectCreateStarterHandlers(host);
}

function registerProjectOpenDialogHandlers({ ipcMain, showOpenDialog }: Pick<MainHost, 'ipcMain' | 'showOpenDialog'>): void {
  ipcMain.handle('project:openDialog', async () => {
    const result = await showOpenDialog({
      title: translateMain('dialog.open.project.title'),
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths.length) {
      return { canceled: true as const };
    }
    const directory = result.filePaths[0];
    assert(directory !== undefined, 'Accepted directory dialog must have a path');
    if (!isAstroProject(directory)) {
      return {
        canceled: false as const,
        error: 'That folder does not look like an Astro project ' + '(no astro dependency or astro.config found).',
      };
    }
    return { canceled: false as const, projectPath: directory };
  });
}

function registerProjectCreateAstroHandlers({ ipcMain, send, showOpenDialog }: Pick<MainHost, 'ipcMain' | 'send' | 'showOpenDialog'>): void {
  // Runs the real `npm create astro@latest`, answering the questions the CLI
  // would ask interactively with the choices collected in the app's wizard.
  // Output is streamed to the renderer so the user sees the same progress the
  // terminal would show. The wizard names the site, so its folder is made here,
  // empty, and create-astro runs in it with "." as the target rather than
  // guessing a name.
  ipcMain.handle('project:createAstro', async (_event, options) => {
    const { parentPath, name, template = 'basics', install = true, git = true, ai = false, packageManager = 'npm' } = options || {};
    const directory = newSiteDirectory(parentPath, name);
    ensureToolPath(); // npm is a Node shim — same PATH problem as astro
    if (install) {
      await requirePackageManager(packageManager);
    }
    fs.mkdirSync(directory);

    const args = [
      'create',
      'astro@latest',
      '.',
      '--',
      '--template',
      template,
      '--no-install', // Stacki installs, then makes the first commit (finishNewSite).
      '--no-git',
      ...(ai ? [] : ['--no-ai']),
      '--skip-houston',
      '--yes', // accept defaults for anything not covered above
    ];

    send('create:log', `> npm ${args.join(' ')}\n\n`);
    await runCreateAstroInNewFolder({ send }, directory, args);
    await finishNewSite({ send }, directory, {
      install,
      manager: packageManager,
      history: git,
      label: 'Astro', // i18n-ignore: the framework's name.
    });
    return { ok: true as const, installed: install, projectPath: directory };
  });

  // A folder to put a new project IN, rather than the project's own folder: the
  // starter arrives as a directory of its own, named by the user.
  ipcMain.handle('project:parentDialog', async () => {
    const result = await showOpenDialog({
      title: translateMain('dialog.open.siteTarget.title'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths.length) {
      return { canceled: true as const };
    }
    return { canceled: false as const, parentPath: result.filePaths[0] };
  });
}

function registerProjectCreateStarterHandlers({ ipcMain, send }: Pick<MainHost, 'ipcMain' | 'send'>): void {
  // Starting from a starter. The scaffolder, the first commit and the package's
  // name are in ./starter.js; what is here is the install that follows and the
  // log the wizard reads.
  ipcMain.handle('project:createStarter', async (_event, { starter = 'lumos', parentPath, name, packageManager = 'npm' }) => {
    ensureToolPath(); // npm and git are both on the PATH the Dock does not have
    await requirePackageManager(packageManager);
    const result = await createStarter({
      starter,
      parentPath,
      name,
      onLog: (text) => send('create:log', text),
    });
    const label = STARTERS[starter]?.label ?? starter;
    await finishNewSite({ send }, result.projectPath, {
      install: true,
      manager: packageManager,
      history: true,
      label,
    });
    return result;
  });
}

export async function installDependencies({ send }: Pick<MainHost, 'send'>, directory: string, pm: PackageManager = detectPackageManager(directory)) {
  ensureToolPath(); // npm/pnpm/yarn are Node shims — same PATH problem as astro
  send('progress', { message: `Installing dependencies (${pm} install)…` });
  try {
    await run(isWin ? `${pm}.cmd` : pm, [...installArguments(pm)], directory, {
      timeout: 10 * 60 * 1000,
      shell: isWin,
    });
  } catch (error: unknown) {
    if (toRecord(error)?.['code'] === 'ENOENT') {
      throw new Error(`This project uses ${pm}, but ${pm} is not installed. Install it and try again.`);
    }
    throw new Error(`${pm} install failed: ${gitErrorDetail(error).slice(-400)}`);
  }
}

// A new site is only started when its manager can install it, so a missing one fails before
// any folder exists. On Windows a missing command fails without ENOENT, so any failure counts.
async function requirePackageManager(manager: PackageManager): Promise<void> {
  try {
    await run(isWin ? `${manager}.cmd` : manager, ['--version'], os.homedir());
  } catch {
    throw new Error(`${packageManagerLabel(manager)} is not installed. Install it or choose npm.`);
  }
}

// The install comes first, so the site's first commit includes the lockfile. The site gets
// its history even when the install fails; the install error still reaches the wizard.
async function finishNewSite(
  { send }: Pick<MainHost, 'send'>,
  directory: string,
  options: {
    readonly install: boolean;
    readonly manager: PackageManager;
    readonly history: boolean;
    readonly label: string;
  },
): Promise<void> {
  const onLog = (text: string): void => send('create:log', text);
  try {
    if (options.install) {
      // A starter's npm lockfile would sit beside the chosen manager's own and misname it.
      if (options.manager !== 'npm') {
        fs.rmSync(path.join(directory, 'package-lock.json'), { force: true });
      }
      onLog(`\n> installing dependencies with ${packageManagerLabel(options.manager)}\n`);
      await installDependencies({ send }, directory, options.manager);
    }
  } finally {
    if (options.history) {
      await startSiteHistory(directory, options.label, onLog);
    }
  }
  send('progress', PROGRESS_CLEARED);
}

// Clears the progress line: no message (src/ipc/appBridge.ts, onAppProgress). IPC is
// a structured clone, which keeps the absent value.
export const PROGRESS_CLEARED = { message: undefined } as const;

// A run that wrote nothing leaves no folder behind, so Try again can reuse the
// name. Anything it did write stays for the user to inspect; nothing is deleted
// recursively.
async function runCreateAstroInNewFolder({ send }: Pick<MainHost, 'send'>, directory: string, args: readonly string[]): Promise<void> {
  try {
    await runCreateAstro({ send }, directory, args);
  } catch (error: unknown) {
    if (fs.readdirSync(directory).length === 0) {
      fs.rmdirSync(directory);
    }
    throw error;
  }
}

// The create-astro run itself, its output streamed to the wizard's log. It
// settles once the CLI exits and a package.json has landed in `directory`.
async function runCreateAstro({ send }: Pick<MainHost, 'send'>, directory: string, args: readonly string[]): Promise<void> {
  const npm = isWin ? 'npm.cmd' : 'npm';
  await runCreateCommand(npm, args, directory, (text) => send('create:log', text));
  if (!fs.existsSync(path.join(directory, 'package.json'))) {
    throw new Error('create-astro finished but no package.json appeared.');
  }
}
