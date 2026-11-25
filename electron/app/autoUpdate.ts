// Auto update
//
// Feed is the GitHub releases repo configured under `build.publish` in
// package.json. The appId must stay `com.stacki.editor` so installs from
// earlier versions upgrade in place instead of landing beside themselves.
// One instance per main process, made by main.ts, which hands it electron's
// app, the updater and a way to reach the window: this module imports no
// electron values. It never opens a native dialog: every word and button the
// person sees is the renderer's own popup (src/features/update/), driven by the
// `UpdateEvent`s sent here, so progress can move live and match the app.

import * as fs from 'fs';
import * as path from 'path';
import type { AppUpdater } from 'electron-updater';
import { assert } from '../../shared/core/assert';
import { toRecord } from '../../shared/core/record';
import {
  advanceProgress,
  NO_DOWNLOAD_PROGRESS,
  progressChangesDisplay,
  type DownloadProgress,
  type UpdateAction,
  type UpdateEvent,
  type UpdateNotice,
  type UpdateState,
} from '../../shared/ipc/updateState';

export interface AutoUpdateHost {
  readonly app: Pick<Electron.App, 'isPackaged' | 'isReady' | 'getPath' | 'getVersion'>;
  readonly autoUpdater: AppUpdater;
  /** Runs just before the app quits to install a downloaded update. */
  readonly beforeInstall: () => void;
  /** Pushes to the open window; a window that is not there yet reads `current()` when it mounts. */
  readonly send: (event: UpdateEvent) => void;
}

const AUTO_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const ERROR_DETAIL_CHARS_MAX = 200;

/**
 * Where the update this app found stands. The version is absent when progress
 * arrives before `update-available` names it (a resumed download can).
 */
export type UpdateDownload =
  | { readonly kind: 'none' }
  | { readonly kind: 'downloading'; readonly version: string | undefined; readonly progress: DownloadProgress }
  | { readonly kind: 'downloaded'; readonly version: string };

/** What the popup shows for an update already found. */
export function updateStateOf(download: UpdateDownload): UpdateState {
  switch (download.kind) {
    case 'none':
      return { kind: 'idle' };
    case 'downloading':
      return { kind: 'downloading', version: download.version, progress: download.progress };
    case 'downloaded':
      return { kind: 'ready', version: download.version };
    default: {
      const exhaustive: never = download;
      return exhaustive;
    }
  }
}

export class AutoUpdates {
  private interval: ReturnType<typeof setTimeout> | undefined = undefined;
  private checkInFlight = false;
  private errorShown = false;
  private download: UpdateDownload = { kind: 'none' };
  // A check somebody asked for, rather than the scheduled one. It answers in the
  // popup either way, so the error handler below leaves the talking to it.
  private manualCheck = false;

  constructor(private readonly host: AutoUpdateHost) {}

  /** The state a window that has just mounted starts from. */
  current(): UpdateState {
    return updateStateOf(this.download);
  }

  /** Checks now and every six hours, in the installed app only. */
  start(): void {
    if (!this.host.app.isPackaged) {
      this.log('Skipping auto update checks in development');
      return;
    }

    this.registerEvents();
    void this.runCheck();

    if (this.interval) {
      clearInterval(this.interval);
    }
    this.interval = setInterval(() => void this.runCheck(), AUTO_UPDATE_CHECK_INTERVAL_MS);
  }

  /** What a button of the popup asks for. */
  act(action: UpdateAction): void {
    switch (action) {
      case 'install':
        if (this.download.kind === 'downloaded') {
          this.host.beforeInstall();
          this.host.autoUpdater.quitAndInstall();
        } else {
          // The popup only offers Restart once the download is done; a stale click is logged, not obeyed.
          this.log('Restart asked for without a downloaded update');
        }
        return;
      case 'retry':
        void this.checkFromMenu();
        return;
      default: {
        const exhaustive: never = action;
        return exhaustive;
      }
    }
  }

  // The File menu's own check. The scheduled one is deliberately silent — it
  // logs, and speaks up only when there is something to install — but somebody
  // who asks is owed an answer either way, "you already have the latest"
  // included. Otherwise the menu item looks broken every time it works.
  async checkFromMenu(): Promise<void> {
    // Nothing to check against: electron-updater reads the feed the installer
    // was built with, and a dev run has no installer. Saying so beats a check
    // that silently does nothing.
    if (!this.host.app.isPackaged) {
      this.notice('development');
      return;
    }

    // An update already found: say where it stands rather than checking again.
    switch (this.download.kind) {
      case 'downloaded':
      case 'downloading':
        this.publish(updateStateOf(this.download), 'reveal');
        return;
      case 'none':
        break;
      default: {
        const exhaustive: never = this.download;
        return exhaustive;
      }
    }

    if (this.checkInFlight) {
      this.notice('alreadyChecking');
      return;
    }

    this.checkInFlight = true;
    this.manualCheck = true;
    try {
      const result = await this.host.autoUpdater.checkForUpdates();
      // `downloadPromise` is the difference between "there is a newer version"
      // and "there is a version": the feed always names one, and downloading is
      // what electron-updater does only when it is actually newer. The download
      // popup is already open by now, from `update-available`.
      if (result?.downloadPromise) {
        this.log('Manual check found an update', { version: result.updateInfo?.version });
        return;
      }
      this.log('Manual check found no update', { version: this.host.app.getVersion() });
      this.notice('latest');
    } catch (error: unknown) {
      this.log('Manual check failed', formatAutoUpdateError(error));
      this.publishError('check', error);
    } finally {
      this.checkInFlight = false;
      this.manualCheck = false;
    }
  }

  private async runCheck(): Promise<void> {
    if (!this.host.app.isPackaged || this.checkInFlight) {
      return;
    }

    this.checkInFlight = true;
    try {
      await this.host.autoUpdater.checkForUpdatesAndNotify();
    } catch (error: unknown) {
      if (!isExpectedAutoUpdateNetworkError(error)) {
        console.warn('Auto update check failed:', error);
      }
    } finally {
      this.checkInFlight = false;
    }
  }

  private registerEvents(): void {
    this.host.autoUpdater.autoDownload = true;
    this.host.autoUpdater.autoInstallOnAppQuit = true;

    this.host.autoUpdater.on('checking-for-update', () => this.log('Checking for updates'));
    this.host.autoUpdater.on('update-available', (info) => {
      this.log('Update available', { version: info.version });
      this.download = { kind: 'downloading', version: info.version, progress: NO_DOWNLOAD_PROGRESS };
      this.publish(updateStateOf(this.download), 'reveal');
    });
    this.host.autoUpdater.on('download-progress', (progress) => {
      const known = this.download.kind === 'downloading' ? this.download : undefined;
      const before = known?.progress ?? NO_DOWNLOAD_PROGRESS;
      // The updater's numbers are untrusted: a download of unknown length can report NaN.
      const after = advanceProgress(before, { transferred: progress.transferred, total: progress.total });
      this.download = { kind: 'downloading', version: known?.version, progress: after };
      if (known === undefined) {
        // A resumed download can report progress before `update-available` named it: that first tick is news.
        this.publish(updateStateOf(this.download), 'reveal');
      } else if (progressChangesDisplay(before, after)) {
        this.publish(updateStateOf(this.download), 'quiet');
      }
    });
    this.host.autoUpdater.on('update-not-available', (info) => this.log('No update available', { version: info.version }));

    this.host.autoUpdater.on('update-downloaded', (info) => {
      this.log('Update downloaded', { version: info.version });
      this.download = { kind: 'downloaded', version: info.version };
      this.publish(updateStateOf(this.download), 'reveal');
    });

    this.host.autoUpdater.on('error', (error) => {
      this.log('Auto update error', formatAutoUpdateError(error));
      // A failed download starts over at the next check; a downloaded one stays ready.
      const wasDownloading = this.download.kind === 'downloading';
      if (wasDownloading) {
        this.download = { kind: 'none' };
      }

      // A person watching the download is told it stopped, whatever the cause: a bar
      // that freezes for good reads as a hang.
      if (wasDownloading) {
        this.publishError('download', error);
        return;
      }
      // A check from the File menu reports its own failure, and reports it even
      // when the popup has already been shown once — two for the one click
      // would be worse than none.
      if (this.manualCheck) {
        return;
      }
      if (this.errorShown || isExpectedAutoUpdateNetworkError(error)) {
        return;
      }
      this.errorShown = true;
      this.publishError('check', error);
    });
  }

  private notice(notice: UpdateNotice): void {
    this.publish({ kind: 'notice', notice, version: this.host.app.getVersion() }, 'reveal');
  }

  private publishError(stage: 'check' | 'download', error: unknown): void {
    // The raw error carries response headers and a stack; the log has all of
    // it, the popup gets the first line.
    const detail = formatAutoUpdateError(error).split('\n')[0]?.slice(0, ERROR_DETAIL_CHARS_MAX) ?? '';
    this.publish({ kind: 'error', stage, detail }, 'reveal');
  }

  private publish(state: UpdateState, news: 'reveal' | 'quiet'): void {
    assert(state.kind !== 'idle', 'an idle state is never pushed: a window reads it from current()');
    this.host.send({ state, reveal: news === 'reveal' });
  }

  private log(message: string, details?: unknown): void {
    const detailText = details === undefined ? '' : ` ${typeof details === 'string' ? details : JSON.stringify(details)}`;
    const line = `[${new Date().toISOString()}] ${message}${detailText}`;

    console.log(line);

    if (!this.host.app.isReady()) {
      return;
    }

    try {
      const logsDirectory = this.host.app.getPath('logs');
      fs.mkdirSync(logsDirectory, { recursive: true });
      fs.appendFileSync(path.join(logsDirectory, 'auto-update.log'), `${line}\n`);
    } catch (error: unknown) {
      console.warn('Failed to write auto update log:', error);
    }
  }
}

// Chromium's transport failures, which electron-updater's net requests report as
// `net::ERR_…` in the message: a dropped, reset or timed-out connection, or a
// network that changed under the request. A user saw a dialog for
// ERR_CONNECTION_CLOSED while the feed itself answered; the next check succeeds.
const CHROMIUM_TRANSIENT_ERRORS = [
  'ERR_ADDRESS_UNREACHABLE',
  'ERR_CONNECTION_ABORTED',
  'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_FAILED',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_TIMED_OUT',
  'ERR_EMPTY_RESPONSE',
  'ERR_HTTP2_PROTOCOL_ERROR',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_NAME_NOT_RESOLVED',
  'ERR_NETWORK_CHANGED',
  'ERR_NETWORK_IO_SUSPENDED',
  'ERR_PROXY_CONNECTION_FAILED',
  'ERR_QUIC_PROTOCOL_ERROR',
  'ERR_TIMED_OUT',
] as const;

// Update-check failures the user can do nothing about, and so should never
// see a dialog for: they're offline, the connection dropped, GitHub is having
// trouble, or a release is mid-publish and its channel file for this platform hasn't uploaded yet. All
// resolve on their own by the next check.
export function isExpectedAutoUpdateNetworkError(error: unknown): boolean {
  const code = String(toRecord(error)?.['code'] || '').toUpperCase();
  const message = String(toRecord(error)?.['message'] || error || '').toLowerCase();

  if (CHROMIUM_TRANSIENT_ERRORS.some((name) => code === name || message.includes(`net::${name.toLowerCase()}`))) {
    return true;
  }

  // GitHub's own trouble: a server error or gateway timeout (a user saw
  // "HttpError: 504") or rate limiting. electron-updater reports these as
  // `HttpError: <status> …`; the next check asks again.
  const status = Number(toRecord(error)?.['statusCode'] ?? /^(?:\w+: )?httperror: (\d{3})\b/.exec(message)?.[1] ?? Number.NaN);
  if (Number.isSafeInteger(status)) {
    if (status === 429) {
      return true;
    }
    if (status >= 500) {
      return status <= 599;
    }
  }

  // A release whose other platform published first: the channel file is
  // briefly absent, which surfaces as a 404 on latest-mac.yml / latest.yml.
  if (message.includes('cannot find latest') || (message.includes('404') && message.includes('.yml'))) {
    return true;
  }

  if (
    [
      'ENOTFOUND',
      'EAI_AGAIN',
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'ENETUNREACH',
      'EHOSTUNREACH',
      'ERR_INTERNET_DISCONNECTED',
      'ERR_NAME_NOT_RESOLVED',
    ].includes(code)
  ) {
    return true;
  }

  return [
    'internet disconnected',
    'name not resolved',
    'network',
    'offline',
    'socket hang up',
    'timed out',
    'getaddrinfo',
    'failed to fetch',
    'could not connect',
    'connection refused',
  ].some((fragment) => message.includes(fragment));
}

function formatAutoUpdateError(error: unknown) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
