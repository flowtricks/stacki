// The project IPC: opening and creating projects (from a dialog, the Astro
// template, a starter or a scaffold), and installing their dependencies.

import { gitErrorDetail } from '../git/git';
import { toRecord } from '../../shared/core/record';
import { assert } from '../../shared/core/assert';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { scaffoldProject } from '../project/scaffold';
import { createStarter } from '../project/starter';
import { isWin, errorMessage } from '../lib/mainHelpers';
import { ensureToolPath, run } from '../lib/nodeTools';
import { isAstroProject } from '../project/projectFiles';
import { detectPackageManager, installArguments } from '../project/packageManager';
import type { MainHost } from './mainHost';

export function registerProjectHandlers(
  host: Pick<MainHost, 'ipcMain' | 'send' | 'showOpenDialog'>,
): void {
  registerProjectOpenDialogHandlers(host);
  registerProjectCreateAstroHandlers(host);
}

function registerProjectOpenDialogHandlers({
  ipcMain,
  showOpenDialog,
}: Pick<MainHost, 'ipcMain' | 'showOpenDialog'>): void {
  ipcMain.handle('project:openDialog', async () => {
    const result = await showOpenDialog({
      title: 'Open an Astro project',
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
        error:
          'That folder does not look like an Astro project ' +
          '(no astro dependency or astro.config found).',
      };
    }
    return { canceled: false as const, projectPath: directory };
  });

  ipcMain.handle('project:newDialog', async () => {
    const result = await showOpenDialog({
      title: 'Choose an empty folder for the new project',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths.length) {
      return { canceled: true as const };
    }
    const directory = result.filePaths[0];
    assert(directory !== undefined, 'Accepted directory dialog must have a path');
    const entries = fs.readdirSync(directory).filter((name) => !name.startsWith('.'));
    if (entries.length > 0) {
      return {
        canceled: false as const,
        error: 'That folder is not empty. Choose or create an empty folder for the new project.',
      };
    }
    return { canceled: false as const, projectPath: directory };
  });
}

function registerProjectCreateAstroHandlers({
  ipcMain,
  send,
  showOpenDialog,
}: Pick<MainHost, 'ipcMain' | 'send' | 'showOpenDialog'>): void {
  // Runs the real `npm create astro@latest`, answering the questions the CLI
  // would ask interactively with the choices collected in the app's wizard.
  // Output is streamed to the renderer so the user sees the same progress the
  // terminal would show. The chosen folder is the cwd and "." the target, so
  // create-astro never has to guess a name from a parent directory.
  ipcMain.handle('project:createAstro', async (_event, options) => {
    const {
      dir: directory,
      template = 'basics',
      install = true,
      git = true,
      ai = false,
    } = options || {};
    if (!directory || !fs.existsSync(directory)) {
      throw new Error('Choose a folder for the new project first.');
    }
    ensureToolPath(); // npm is a Node shim — same PATH problem as astro

    const args = [
      'create',
      'astro@latest',
      '.',
      '--',
      '--template',
      template,
      install ? '--install' : '--no-install',
      git ? '--git' : '--no-git',
      ...(ai ? [] : ['--no-ai']),
      '--skip-houston',
      '--yes', // accept defaults for anything not covered above
    ];

    send('create:log', `> npm ${args.join(' ')}\n\n`);
    await runCreateAstro({ send }, directory, args);
    return { ok: true as const, installed: install };
  });

  // A folder to put a new project IN, rather than the project's own folder: the
  // starter arrives as a directory of its own, named by the user.
  ipcMain.handle('project:parentDialog', async () => {
    const result = await showOpenDialog({
      title: 'Choose where the site should go',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths.length) {
      return { canceled: true as const };
    }
    return { canceled: false as const, parentPath: result.filePaths[0] };
  });

  // Starting from a starter. The scaffolder, the first commit and the package's
  // name are in ./starter.js; what is here is the install that follows and the
  // log the wizard reads.
  ipcMain.handle(
    'project:createStarter',
    async (_event, { starter = 'lumos', parentPath, name }) => {
      ensureToolPath(); // npm and git are both on the PATH the Dock does not have
      const result = await createStarter({
        starter,
        parentPath,
        name,
        onLog: (text) => send('create:log', text),
      });
      send('create:log', '\n> installing dependencies\n');
      await installDependencies({ send }, result.projectPath);
      send('progress', PROGRESS_CLEARED);
      return result;
    },
  );

  ipcMain.handle('project:scaffold', async (_event, { dir: directory, name }) => {
    scaffoldProject(directory, name);
    await installDependencies({ send }, directory);
    return { ok: true as const };
  });
}

export async function installDependencies({ send }: Pick<MainHost, 'send'>, directory: string) {
  ensureToolPath(); // npm/pnpm/yarn are Node shims — same PATH problem as astro
  const pm = detectPackageManager(directory);
  send('progress', { message: `Installing dependencies (${pm} install)…` });
  try {
    await run(isWin ? `${pm}.cmd` : pm, [...installArguments(pm)], directory, {
      timeout: 10 * 60 * 1000,
      shell: isWin,
    });
  } catch (error: unknown) {
    if (toRecord(error)?.['code'] === 'ENOENT') {
      throw new Error(
        `This project uses ${pm}, but ${pm} is not installed. Install it and try again.`,
      );
    }
    throw new Error(`${pm} install failed: ${gitErrorDetail(error).slice(-400)}`);
  }
}

// Clears the progress line: no message (src/ipc/appBridge.ts, onAppProgress). IPC is
// a structured clone, which keeps the absent value.
export const PROGRESS_CLEARED = { message: undefined } as const;

// The create-astro run itself, its output streamed to the wizard's log. It
// settles once the CLI exits and a package.json has landed in `directory`.
function runCreateAstro(
  { send }: Pick<MainHost, 'send'>,
  directory: string,
  args: readonly string[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(isWin ? 'npm.cmd' : 'npm', [...args], {
        cwd: directory,
        shell: isWin,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CI: '1' },
      });
    } catch (error: unknown) {
      reject(new Error(`Could not run npm: ${errorMessage(error)}`));
      return;
    }

    let tail = '';
    const onOut = (chunk: Buffer) => {
      // create-astro animates with cursor moves and line clears; strip the
      // escape codes so the log pane reads as plain text.
      const text = chunk
        .toString()
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
        .replace(/\r/g, '\n');
      tail = (tail + text).slice(-4000);
      send('create:log', text);
    };
    proc.stdout.on('data', onOut);
    proc.stderr.on('data', onOut);
    proc.on('error', (error) => {
      reject(
        new Error(
          toRecord(error)?.['code'] === 'ENOENT'
            ? 'npm could not be found. Install Node.js (which includes npm) and try again.'
            : `Could not run npm: ${errorMessage(error)}`,
        ),
      );
    });
    proc.on('exit', (code) => {
      if (code === 0) {
        // Sanity-check that a project actually landed.
        if (!fs.existsSync(path.join(directory, 'package.json'))) {
          reject(new Error(`create-astro finished but no package.json appeared.\n\n${tail}`));
          return;
        }
        resolve();
      } else {
        reject(new Error(`create-astro exited with code ${code}.\n\n${tail}`));
      }
    });
  });
}
