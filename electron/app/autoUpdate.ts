// Auto update
//
// Feed is the GitHub releases repo configured under `build.publish` in
// package.json. The appId must stay `com.stacki.editor` so installs from
// earlier versions upgrade in place instead of landing beside themselves.
// One instance per main process, made by main.ts, which hands it electron's
// app, the updater and its dialogs: this module imports no electron values.

import * as fs from 'fs';
import * as path from 'path';
import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import type { AppUpdater } from 'electron-updater';
import { assert } from '../../shared/core/assert';
import { toRecord } from '../../shared/core/record';
import { translateMain } from '../lib/mainLocale';

export interface AutoUpdateHost {
  readonly app: Pick<Electron.App, 'isPackaged' | 'isReady' | 'getPath' | 'getVersion'>;
  readonly autoUpdater: AppUpdater;
  /** Runs just before the app quits to install a downloaded update. */
  readonly beforeInstall: () => void;
  /** The window a dialog belongs to, while one is open. */
  readonly parentWindow: () => BrowserWindow | undefined;
  readonly showMessageBox: (parent: BrowserWindow | undefined, options: MessageBoxOptions) => Promise<MessageBoxReturnValue>;
}

const AUTO_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Where the update this app found stands. The version is absent when progress
 * arrives before `update-available` names it (a resumed download can).
 */
export type UpdateDownload =
  | { readonly kind: 'none' }
  | { readonly kind: 'downloading'; readonly version: string | undefined; readonly percent: number }
  | { readonly kind: 'downloaded'; readonly version: string };

/**
 * What the File menu's check says while an update is already downloading. A
 * download runs inside the check that found it, and a whole app takes minutes
 * on a slow connection: "Already checking for updates" there read as stuck.
 */
export function updateDownloadingMessage(download: Extract<UpdateDownload, { kind: 'downloading' }>): { readonly message: string; readonly detail: string } {
  assert(Number.isFinite(download.percent), 'download progress is a number');
  const percent = Math.min(100, Math.max(0, Math.floor(download.percent)));
  assert(percent >= 0, 'download progress is not negative');
  assert(percent <= 100, 'download progress is at most 100%');
  return {
    message:
      download.version === undefined
        ? translateMain('dialog.update.downloading.message')
        : translateMain('dialog.update.downloading.messageVersion', { version: download.version }),
    detail: translateMain('dialog.update.downloading.detail', { percent }),
  };
}

export class AutoUpdates {
  private interval: ReturnType<typeof setTimeout> | undefined = undefined;
  private checkInFlight = false;
  private errorDialogShown = false;
  private download: UpdateDownload = { kind: 'none' };
  // A check somebody asked for, rather than the scheduled one. It answers in a
  // dialog either way, so the error handler below leaves the talking to it.
  private manualCheck = false;

  constructor(private readonly host: AutoUpdateHost) {}

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

  // The File menu's own check. The scheduled one is deliberately silent — it
  // logs, and speaks up only when there is something to install — but somebody
  // who asks is owed an answer either way, "you already have the latest"
  // included. Otherwise the menu item looks broken every time it works.
  async checkFromMenu(): Promise<void> {
    const parent = this.host.parentWindow();

    // Nothing to check against: electron-updater reads the feed the installer
    // was built with, and a dev run has no installer. Saying so beats a check
    // that silently does nothing.
    if (!this.host.app.isPackaged) {
      await this.host.showMessageBox(parent, {
        type: 'info',
        title: translateMain('dialog.update.check.title'),
        message: translateMain('dialog.update.development.message'),
        detail: translateMain('dialog.update.development.detail', { version: this.host.app.getVersion() }),
      });
      return;
    }

    // An update already found: say where it stands rather than checking again.
    switch (this.download.kind) {
      case 'downloaded':
        await this.promptToInstall(this.download.version);
        return;
      case 'downloading':
        await this.host.showMessageBox(parent, { type: 'info', title: translateMain('dialog.update.check.title'), ...updateDownloadingMessage(this.download) });
        return;
      case 'none':
        break;
      default: {
        const exhaustive: never = this.download;
        return exhaustive;
      }
    }

    if (this.checkInFlight) {
      await this.host.showMessageBox(parent, {
        type: 'info',
        title: translateMain('dialog.update.check.title'),
        message: translateMain('dialog.update.check.alreadyChecking'),
      });
      return;
    }

    this.checkInFlight = true;
    this.manualCheck = true;
    try {
      const result = await this.host.autoUpdater.checkForUpdates();
      // `downloadPromise` is the difference between "there is a newer version"
      // and "there is a version": the feed always names one, and downloading is
      // what electron-updater does only when it is actually newer.
      if (result?.downloadPromise) {
        this.log('Manual check found an update', { version: result.updateInfo?.version });
        await this.host.showMessageBox(parent, {
          type: 'info',
          title: translateMain('dialog.update.available.title'),
          message: translateMain('dialog.update.available.message', { version: result.updateInfo?.version ?? '' }),
          detail: translateMain('dialog.update.available.detail'),
        });
        return;
      }
      this.log('Manual check found no update', { version: this.host.app.getVersion() });
      await this.host.showMessageBox(parent, {
        type: 'info',
        title: translateMain('dialog.update.check.title'),
        message: translateMain('dialog.update.check.latest', { version: this.host.app.getVersion() }),
      });
    } catch (error: unknown) {
      this.log('Manual check failed', formatAutoUpdateError(error));
      await this.host.showMessageBox(parent, {
        type: 'warning',
        title: translateMain('dialog.update.check.title'),
        // The raw error carries response headers and a stack; the log has all of
        // it, the dialog gets the first line.
        message: translateMain('dialog.update.check.failed'),
        detail: formatAutoUpdateError(error).split('\n')[0]?.slice(0, 200) ?? '',
      });
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
      this.download = { kind: 'downloading', version: info.version, percent: 0 };
    });
    this.host.autoUpdater.on('download-progress', (progress) => {
      const version = this.download.kind === 'downloading' ? this.download.version : undefined;
      // The updater's own number: a download of unknown length can report NaN.
      const percent = Number.isFinite(progress.percent) ? progress.percent : 0;
      this.download = { kind: 'downloading', version, percent };
    });
    this.host.autoUpdater.on('update-not-available', (info) => this.log('No update available', { version: info.version }));

    this.host.autoUpdater.on('update-downloaded', (info) => {
      this.log('Update downloaded', { version: info.version });
      this.download = { kind: 'downloaded', version: info.version };
      void this.promptToInstall(info.version);
    });

    this.host.autoUpdater.on('error', (error) => {
      this.log('Auto update error', formatAutoUpdateError(error));
      // A failed download starts over at the next check; a downloaded one stays ready.
      if (this.download.kind === 'downloading') {
        this.download = { kind: 'none' };
      }

      // A check from the File menu reports its own failure, and reports it even
      // when this dialog has already been shown once — two dialogs for the one
      // click would be worse than none.
      if (this.manualCheck) {
        return;
      }
      if (this.errorDialogShown || isExpectedAutoUpdateNetworkError(error)) {
        return;
      }
      this.errorDialogShown = true;

      const parent = this.host.parentWindow();
      void this.host.showMessageBox(parent, {
        type: 'warning',
        title: translateMain('dialog.update.failed.title'),
        message: translateMain('dialog.update.check.failed'),
        // The raw error carries response headers and a stack trace; the full
        // text is in the log, so show the user only the first line.
        detail: `${formatAutoUpdateError(error).split('\n')[0]?.slice(0, 200)}\n\n${translateMain('dialog.update.failed.retryLater')}`,
      });
    });
  }

  private async promptToInstall(version: string): Promise<void> {
    const parent = this.host.parentWindow();
    const { response } = await this.host.showMessageBox(parent, {
      type: 'info',
      title: translateMain('dialog.update.ready.title'),
      buttons: [translateMain('dialog.update.ready.restartNow'), translateMain('dialog.update.ready.later')],
      defaultId: 0,
      cancelId: 1,
      message: translateMain('dialog.update.ready.message', { version }),
      detail: translateMain('dialog.update.ready.detail'),
    });

    if (response === 0) {
      this.host.beforeInstall();
      this.host.autoUpdater.quitAndInstall();
    }
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
