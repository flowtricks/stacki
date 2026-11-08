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
import { toRecord } from '../../shared/core/record';

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

export class AutoUpdates {
  private interval: ReturnType<typeof setTimeout> | undefined = undefined;
  private checkInFlight = false;
  private errorDialogShown = false;
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
        title: 'Check for Updates',
        message: 'Updates are only checked in the installed this.host.app.',
        detail: `This is a development build (${this.host.app.getVersion()}), ` + 'which updates when you rebuild it.',
      });
      return;
    }

    if (this.checkInFlight) {
      await this.host.showMessageBox(parent, {
        type: 'info',
        title: 'Check for Updates',
        message: 'Already checking for updates.',
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
          title: 'Update Available',
          message: `Stacki ${result.updateInfo?.version} is downloading.`,
          detail: 'You’ll be asked whether to restart once it has finished.',
        });
        return;
      }
      this.log('Manual check found no update', { version: this.host.app.getVersion() });
      await this.host.showMessageBox(parent, {
        type: 'info',
        title: 'Check for Updates',
        message: `Stacki ${this.host.app.getVersion()} is the latest version.`,
      });
    } catch (error: unknown) {
      this.log('Manual check failed', formatAutoUpdateError(error));
      await this.host.showMessageBox(parent, {
        type: 'warning',
        title: 'Check for Updates',
        // The raw error carries response headers and a stack; the log has all of
        // it, the dialog gets the first line.
        message: 'Stacki could not check for updates.',
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
    this.host.autoUpdater.on('update-available', (info) => this.log('Update available', { version: info.version }));
    this.host.autoUpdater.on('update-not-available', (info) => this.log('No update available', { version: info.version }));

    this.host.autoUpdater.on('update-downloaded', (info) => {
      this.log('Update downloaded', { version: info.version });
      void this.promptToInstall(info.version);
    });

    this.host.autoUpdater.on('error', (error) => {
      this.log('Auto update error', formatAutoUpdateError(error));

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
        title: 'Update Check Failed',
        message: 'Stacki could not check for updates.',
        // The raw error carries response headers and a stack trace; the full
        // text is in the log, so show the user only the first line.
        detail: formatAutoUpdateError(error).split('\n')[0]?.slice(0, 200) + '\n\nStacki will try again later.',
      });
    });
  }

  private async promptToInstall(version: string): Promise<void> {
    const parent = this.host.parentWindow();
    const { response } = await this.host.showMessageBox(parent, {
      type: 'info',
      title: 'Update Ready',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      message: `Stacki ${version} has been downloaded.`,
      detail: 'Restart Stacki to install the update.',
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
// see a dialog for: they're offline, the connection dropped, or a release is
// mid-publish and its channel file for this platform hasn't uploaded yet. All
// resolve on their own by the next check.
export function isExpectedAutoUpdateNetworkError(error: unknown): boolean {
  const code = String(toRecord(error)?.['code'] || '').toUpperCase();
  const message = String(toRecord(error)?.['message'] || error || '').toLowerCase();

  if (CHROMIUM_TRANSIENT_ERRORS.some((name) => code === name || message.includes(`net::${name.toLowerCase()}`))) {
    return true;
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
