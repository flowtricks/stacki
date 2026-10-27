// The project's home page, rendered on its own and photographed from the top.
//
// Two ways in. The project that is open already has a dev server, so its
// picture costs one hidden window. A project on the start screen has nothing
// running, so one is started for it, used, and stopped again — which is what
// makes "the site as it is now" true for a project that was last edited
// somewhere else entirely. One instance per main process, made by main.ts.

import * as path from 'path';
import type { ChildProcess } from 'child_process';
import * as thumbs from '../project/thumbs';
import { sameFilesystemPath } from '../lib/platform';
import { createSerialQueue } from '../lib/serialQueue';
import { isWin } from '../lib/mainHelpers';
import { findFreePort, spawnAstroServer, stopProcessTree } from '../lib/nodeTools';
import { hasDependencies } from '../project/projectFiles';
import { serverAlive } from '../preview/devServerChecks';
import type { DevServers } from './devServers';
import type { MainHost } from './mainHost';

export interface ThumbnailHost {
  readonly devServers: Pick<DevServers, 'current'>;
  /** Electron's userData folder, where the pictures are kept. */
  readonly userDataPath: () => string;
}

export class Thumbnails {
  private readonly queueCapture = createSerialQueue(); // each capture owns a browser and a server
  // Bumped when a project is opened. A capture waiting its turn behind another
  // one belongs to a start screen that is no longer on screen — and the machine
  // is now busy starting the project the user actually asked for.
  private captureEra = 0;
  private captureController: AbortController | undefined;
  private thumbTimer: ReturnType<typeof setTimeout> | undefined = undefined;

  constructor(private readonly host: ThumbnailHost) {}

  capture(projectPath: string) {
    const era = this.captureEra;
    return this.queueCapture(async () => {
      if (era !== this.captureEra) {
        return { ok: false as const, error: 'skipped' };
      }
      const controller = new AbortController();
      this.captureController = controller;
      try {
        return await this.captureNow(projectPath, controller.signal);
      } finally {
        this.captureController = undefined;
      }
    });
  }

  /** Give the editor priority over active and queued welcome-screen server startups. */
  noteProjectOpened(): void {
    this.captureEra++;
    this.captureController?.abort();
  }

  /** The project closed: no background capture is left pending for it. */
  stop(): void {
    clearTimeout(this.thumbTimer);
    this.thumbTimer = undefined;
    this.captureEra++;
    this.captureController?.abort();
  }

  // While a project is open, its picture is kept current in the background: once
  // when the preview comes up, and again a while after the last edit. Neither
  // touches the window the user is working in.
  schedule(projectPath: string, delay: number): void {
    clearTimeout(this.thumbTimer);
    this.thumbTimer = setTimeout(() => {
      const devServer = this.host.devServers.current();
      if (!devServer || !sameFilesystemPath(devServer.projectPath, projectPath)) {
        return;
      }
      if (!thumbs.isStale(this.host.userDataPath(), projectPath)) {
        return;
      }
      this.capture(projectPath).catch((error: unknown) => {
        // A background refresh: the old picture stays, and the log says why.
        console.error('[thumbs] capture failed:', error);
      });
    }, delay);
    if (this.thumbTimer.unref) {
      this.thumbTimer.unref();
    }
  }

  private async captureNow(projectPath: string, signal: AbortSignal) {
    const userData = this.host.userDataPath();
    const devServer = this.host.devServers.current();
    // Already running for this project (it is the one that is open) — use it.
    if (devServer && sameFilesystemPath(devServer.projectPath, projectPath) && devServer.url) {
      if (await serverAlive(devServer.url)) {
        return thumbs.capture(userData, projectPath, devServer.url + '/');
      }
    }
    if (!hasDependencies(projectPath)) {
      return { ok: false as const, error: 'This project has no dependencies installed yet.' };
    }
    return withTemporaryServer(projectPath, signal, (url) =>
      thumbs.capture(userData, projectPath, url + '/'),
    );
  }
}

export function registerThumbnailHandlers({
  ipcMain,
  thumbnails,
  userDataPath,
}: Pick<MainHost, 'ipcMain'> & {
  readonly thumbnails: Thumbnails;
  readonly userDataPath: () => string;
}): void {
  // Asked for by the start screen, for a card whose picture is out of date.
  ipcMain.handle('recents:refreshThumb', async (_event, projectPath) => {
    const result = await thumbnails.capture(projectPath);
    const userData = userDataPath();
    return {
      ...result,
      thumb: thumbs.readThumb(userData, projectPath) ?? undefined,
      stale: thumbs.isStale(userData, projectPath),
    };
  });
}

// A dev server of the project's own, for one capture: the canvas's server is
// left alone, and the temporary one is stopped however the capture ends.
async function withTemporaryServer(
  projectPath: string,
  signal: AbortSignal,
  capture: (url: string) => ReturnType<typeof thumbs.capture>,
) {
  const binName = isWin ? 'astro.cmd' : 'astro';
  const localBin = path.join(projectPath, 'node_modules', '.bin', binName);
  const port = await findFreePort(4400 + Math.floor(Math.random() * 200));
  if (signal.aborted) {
    return { ok: false as const, error: 'skipped' };
  }
  const proc = spawnAstroServer(projectPath, localBin, [
    'dev',
    '--port',
    String(port),
    '--host',
    '127.0.0.1',
    // Keep a temporary server in our process group. A detached Astro daemon
    // cannot be cancelled while it is still compiling and has no lock file yet.
    '--ignore-lock',
  ]);
  const spawnState: { error?: Error } = {};
  proc.on('error', (error) => {
    spawnState.error = error;
  });
  let log = '';
  proc.stdout.on('data', (chunk) => (log = (log + chunk).slice(-4000)));
  proc.stderr.on('data', (chunk) => (log = (log + chunk).slice(-4000)));

  const url = `http://127.0.0.1:${port}`;
  const stop = () => stopProcessTree(proc);
  signal.addEventListener('abort', stop, { once: true });

  try {
    const state = await waitForTemporaryServer(proc, url, spawnState, signal);
    if (signal.aborted) {
      return { ok: false as const, error: 'skipped' };
    }
    if (state instanceof Error) {
      return { ok: false as const, error: state.message };
    }
    if (state === 'down') {
      return {
        ok: false as const,
        error: cleanDevLog(log) || 'the dev server did not start in time',
      };
    }
    return await capture(url);
  } finally {
    signal.removeEventListener('abort', stop);
    stop();
  }
}

// Polls the temporary server for at most 45 seconds: up once its port
// answers, down if it exits first or never answers, or the spawn's own error.
async function waitForTemporaryServer(
  proc: ChildProcess,
  url: string,
  spawnState: { readonly error?: Error },
  signal: AbortSignal,
): Promise<'up' | 'down' | Error> {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (signal.aborted) {
      return 'down';
    }
    if (spawnState.error) {
      return spawnState.error;
    }
    if (proc.exitCode !== null && proc.exitCode !== 0) {
      return 'down';
    }
    if (await serverAlive(url)) {
      return 'up';
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return 'down';
}

const cleanDevLog = (text: string) =>
  String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^\[?\d{1,2}:\d{2}/.test(line))
    .slice(-2)
    .join(' ')
    .slice(0, 300);
