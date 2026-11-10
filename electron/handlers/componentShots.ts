// Photographs of components for the insert palette, refreshed in the background.
//
// The open project already has a dev server, so a run costs one hidden window per page and
// nothing else; no server is started for it. A run starts when the palette opens and the cache
// is out of date. It never touches the window the user works in, and a project closing or
// another opening ends it at its next checkpoint.

import * as path from 'path';
import { sameFilesystemPath } from '../lib/platform';
import { createSerialQueue } from '../lib/serialQueue';
import { listAstroFiles, routeForPage } from '../project/projectFiles';
import { serverAlive } from '../preview/devServerChecks';
import { runComponentShots, type ShotRun, type ShotRunResult } from './componentShotCapture';
import { planShotPages, type ShotPlan } from './componentShotPlan';
import { readShotImage, readShotMeta } from '../project/componentShotStore';
import { fingerprint } from '../project/thumbs';
import type { ComponentShotEntry, ComponentShotMeta } from '../../shared/properties/componentShots';
import type { DevServers } from './devServers';
import type { MainHost } from './mainHost';

/**
 * What the run controller needs from outside. Everything that touches a window, the disk or a server is
 * here, so the controller's rules (when to start, what to drop, what to wait for) are testable on their own.
 */
export interface ComponentShotsHost {
  readonly devServers: Pick<DevServers, 'current' | 'readTrailingSlash'>;
  /** Electron's userData folder, where the pictures are kept. */
  readonly userDataPath: () => string;
  /** Tells the renderer that new pictures are stored. */
  readonly send: (channel: string, payload?: unknown) => void;
  readonly run: (run: ShotRun) => Promise<ShotRunResult>;
  readonly fingerprint: (projectPath: string) => string;
  readonly stored: (projectPath: string) => ComponentShotMeta | undefined;
  readonly image: (projectPath: string, component: string) => string | undefined;
  readonly alive: (url: string) => Promise<boolean>;
  readonly pages: (projectPath: string) => ShotPlan;
}

/** The host a running app uses. */
export function componentShotsHost(base: Pick<ComponentShotsHost, 'devServers' | 'userDataPath' | 'send'>): ComponentShotsHost {
  return {
    ...base,
    run: runComponentShots,
    fingerprint,
    stored: (projectPath) => readShotMeta(base.userDataPath(), projectPath),
    image: (projectPath, component) => readShotImage(base.userDataPath(), projectPath, component),
    alive: serverAlive,
    pages: (projectPath) =>
      planShotPages(listAstroFiles(path.join(projectPath, 'src', 'pages')).map((file) => ({ path: file, route: routeForPage(projectPath, file) }))),
  };
}

export class ComponentShots {
  private readonly queue = createSerialQueue();
  // Bumped to end the run in progress at its next checkpoint: the project closed, or another wants its turn.
  private era = 0;
  // Projects with a run waiting or running. One entry per project, so asking twice is asking once.
  private readonly pending = new Set<string>();
  // The fingerprint each project last had a run started for. A run that was cut short or failed leaves the
  // cache stale, and without this every opening of the palette would start the same run again.
  private readonly started = new Map<string, string>();
  constructor(private readonly host: ComponentShotsHost) {}

  /** What is stored for the project now. Starts a run when the cache is out of date. */
  list(projectPath: string): { readonly shots: readonly ComponentShotEntry[] } {
    const shots = (this.host.stored(projectPath)?.shots ?? []).map(({ component, width, height }) => ({ component, width, height }));
    this.refresh(projectPath);
    return { shots };
  }

  read(projectPath: string, component: string): string | undefined {
    return this.host.image(projectPath, component);
  }

  /** The project closed: the run in progress ends at its next checkpoint. */
  stop(): void {
    this.era++;
  }

  // Starts a run when the pictures are out of date and none has been started for this state of the project.
  private refresh(projectPath: string): void {
    const current = this.host.fingerprint(projectPath);
    if (this.host.stored(projectPath)?.fingerprint === current) {
      return;
    }
    if (this.pending.has(projectPath) || this.started.get(projectPath) === current) {
      return;
    }
    // Another project's run steps aside at its next checkpoint; this one waits its turn in the queue.
    if ([...this.pending].some((other) => !sameFilesystemPath(other, projectPath))) {
      this.era++;
    }
    this.pending.add(projectPath);
    this.started.set(projectPath, current);
    const era = this.era;
    this.queue(async () => {
      try {
        await this.runNow(projectPath, era, current);
      } finally {
        this.pending.delete(projectPath);
      }
    }).catch((error: unknown) => {
      // A background refresh: the old pictures stay, and the log says why.
      console.error('[component-shots] run failed:', error);
    });
  }

  private async runNow(projectPath: string, era: number, fingerprintValue: string): Promise<void> {
    const server = this.host.devServers.current();
    const usable = era === this.era && server !== undefined && !!server.url && sameFilesystemPath(server.projectPath, projectPath);
    if (!usable || !(await this.host.alive(server.url))) {
      // Nothing was tried, so nothing is held against the project: the next ask may start the run.
      this.forgetStart(projectPath, fingerprintValue);
      return;
    }
    const result = await this.host.run({
      projectPath,
      userDataPath: this.host.userDataPath(),
      devUrl: server.url,
      trailingSlash: this.host.devServers.readTrailingSlash(projectPath),
      ...this.host.pages(projectPath),
      isCurrent: () => {
        const now = this.host.devServers.current();
        return era === this.era && now !== undefined && sameFilesystemPath(now.projectPath, projectPath);
      },
      onProgress: () => this.host.send('componentShots:changed', { projectPath }),
    });
    if (!result.ok && result.error === 'skipped') {
      // Ended because the project went away, not because it failed: it is worth another try later.
      this.forgetStart(projectPath, fingerprintValue);
    } else if (!result.ok) {
      console.error('[component-shots]', result.error);
    }
  }

  private forgetStart(projectPath: string, fingerprintValue: string): void {
    if (this.started.get(projectPath) === fingerprintValue) {
      this.started.delete(projectPath);
    }
  }
}

export function registerComponentShotHandlers({ ipcMain, componentShots }: Pick<MainHost, 'ipcMain'> & { readonly componentShots: ComponentShots }): void {
  ipcMain.handle('componentShots:list', (_event, projectPath) => componentShots.list(projectPath));
  ipcMain.handle('componentShots:read', (_event, request) => componentShots.read(request.projectPath, request.component));
}
