// The words and bounds of the "Add EmDash to this project" section, apart from its component so they can be tested
// without a browser: which message each refusal, failure, warning and manual step uses, and how much of the streamed
// log is drawn.
import {
  EMDASH_INSTALL_LIMITS,
  type EmDashInstallFailure,
  type EmDashInstallRefusal,
  type EmDashInstallWarning,
} from '../../../shared/properties/emdashInstall';
import type { MessageKey } from '../../../shared/properties/i18n/messageRef';

/** The newest lines of the log that are highlighted and drawn; the whole bounded log is kept, so a long install never slows the dialog. */
export const INSTALL_LOG_LINES_SHOWN = 200;

export const REFUSAL_KEYS: Readonly<Record<EmDashInstallRefusal, MessageKey>> = {
  alreadyInstalled: 'emdash.install.refusal.alreadyInstalled',
  astroTooOld: 'emdash.install.refusal.astroTooOld',
  busy: 'emdash.install.refusal.busy',
  noPackageJson: 'emdash.install.refusal.noPackageJson',
  notAstro: 'emdash.install.refusal.notAstro',
  notConfirmed: 'emdash.install.refusal.notConfirmed',
};

export const FAILURE_KEYS: Readonly<Record<EmDashInstallFailure, MessageKey>> = {
  engineMismatch: 'emdash.install.failure.engineMismatch',
  managerMissing: 'emdash.install.failure.managerMissing',
  noNetwork: 'emdash.install.failure.noNetwork',
  other: 'emdash.install.failure.other',
  peerConflict: 'emdash.install.failure.peerConflict',
  saveFailed: 'emdash.install.failure.saveFailed',
  permission: 'emdash.install.failure.permission',
  timeout: 'emdash.install.failure.timeout',
};

export const WARNING_KEYS: Readonly<Record<EmDashInstallWarning, MessageKey>> = {
  otherAdapter: 'emdash.install.warning.otherAdapter',
};

/** The end of the log, at most `INSTALL_LOG_LINES_SHOWN` lines, without blank lines before the first or after the last. */
export function logTail(log: string): string {
  const lines = log.split('\n');
  const shown = lines.length > INSTALL_LOG_LINES_SHOWN ? lines.slice(lines.length - INSTALL_LOG_LINES_SHOWN) : lines;
  return shown
    .join('\n')
    .slice(-EMDASH_INSTALL_LIMITS.logCharsMax)
    .replace(/^(?:[ \t]*\n)+/, '')
    .replace(/(?:\n[ \t]*)+$/, '');
}
