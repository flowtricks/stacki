// The commit preview IPC: a dev server for a past commit in its own worktree,
// its render check, and stopping it.

import { MAIN_LIMITS } from '../lib/mainLimits';
import * as path from 'path';
import * as fs from 'fs';
import * as previewWorktree from '../preview/previewWorktree';
import { checkPreviewRender } from '../preview/previewCheck';
import { isWin } from '../lib/mainHelpers';
import { findFreePort, git, spawnAstroServer } from '../lib/nodeTools';
import { serverAlive } from '../preview/devServerChecks';
import { previewServers, stopPreview } from '../preview/previewServers';
import type { MainHost } from './mainHost';

export function registerPreviewHandlers(host: Pick<MainHost, 'ipcMain'>): void {
  registerPreviewAtCommitHandler(host);
  registerPreviewCheckHandlers(host);
}

function registerPreviewAtCommitHandler({ ipcMain }: Pick<MainHost, 'ipcMain'>): void {
  ipcMain.handle('preview:atCommit', async (_event, { projectPath, ref }) => {
    const directory = await previewWorktree.ensureWorktree(git, { projectPath, ref });

    // A server already up for this project just needs the checkout moved under
    // it — Vite notices the files changed and reloads, which is far quicker than
    // starting Astro again for every commit somebody clicks.
    const running = previewServers.get(projectPath);
    if (running?.proc && !running.proc.killed) {
      previewServers.set(projectPath, { ...running, ref });
      return { url: running.url, ref, reused: true as const };
    }

    const bin = isWin ? 'astro.cmd' : 'astro';
    const localBin = path.join(projectPath, 'node_modules', '.bin', bin);
    if (!fs.existsSync(localBin)) {
      throw new Error('This project’s packages aren’t installed, so an older version can’t be shown. ' + 'Install them and try again.');
    }
    const port = await findFreePort(4500);
    if (previewServers.size >= MAIN_LIMITS.previewServersMax) {
      if (!previewServers.has(projectPath)) {
        throw new Error('Preview server limit');
      }
    }
    const proc = spawnAstroServer(directory, localBin, ['dev', '--port', String(port), '--host', '127.0.0.1']);

    const url = `http://127.0.0.1:${port}`;
    let log = '';
    proc.stdout.on('data', (chunk) => (log = (log + chunk).slice(-12000)));
    proc.stderr.on('data', (chunk) => (log = (log + chunk).slice(-12000)));
    const spawnState: { error?: Error } = {};
    proc.on('error', (error) => {
      spawnState.error = error;
    });
    previewServers.set(projectPath, { proc, url, ref, port });
    proc.on('exit', () => {
      if (previewServers.get(projectPath)?.proc === proc) {
        previewServers.delete(projectPath);
      }
    });

    // Wait for it to answer rather than guessing at a delay. An old commit can
    // need packages that are not installed now, and that shows up as a server
    // that never comes up — so the failure has to be caught here and explained,
    // not left as a blank canvas.
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (spawnState.error || proc.exitCode !== null || proc.killed) {
        break;
      }
      if (await serverAlive(url)) {
        return { url, ref, reused: false as const };
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    await stopPreview(projectPath);
    // The commonest real cause, said in those terms rather than as a stack trace.
    const missing = /Cannot find (?:module|package) ['"]?([^'"\s]+)/i.exec(log);
    throw new Error(
      missing
        ? `That version needs ${missing[1]}, which isn’t installed here. ` + 'It can’t be shown without it.'
        : 'That version wouldn’t start. It may need packages that aren’t installed any more.',
    );
  });
}

function registerPreviewCheckHandlers({ ipcMain }: Pick<MainHost, 'ipcMain'>): void {
  // The canvas's preview token (plan §9, step 7): a click on the canvas selects
  // a node only while every file its rendering came from still holds the bytes
  // the rendering's stamps name. Read from disk here, never from the watcher.
  ipcMain.handle('preview:check', (_event, { projectPath, render }) => checkPreviewRender(projectPath, render));

  ipcMain.handle('preview:stop', async (_event, { projectPath }) => {
    await stopPreview(projectPath);
    return { ok: true as const };
  });
}
