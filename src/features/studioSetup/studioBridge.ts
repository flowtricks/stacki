import { parseIpcPayload } from '../../../shared/ipc/ipcPayloads';
import { parseStudioAuthResult, parseStudioInstallResult, parseStudioStatus } from '../../../shared/ipc/studioSetup';
import type { StudioAuthConfig } from '../../../shared/ipc/studioAuth';
import { parseStudioInstallProgress, type StudioInstallProgress } from '../../../shared/ipc/studioProgress';
import { parseStudioRestoreResult, parseStudioUpgradeCheck, parseStudioUpgradeResult } from '../../../shared/ipc/studioUpgrade';

export async function readStudioStatus(projectPath: string) {
  return parseStudioStatus(await window.avb.studioStatus(parseIpcPayload('studio:status', projectPath)));
}

export async function addStudio(projectPath: string, requestId: string, auth: StudioAuthConfig) {
  return parseStudioInstallResult(await window.avb.installStudio(parseIpcPayload('studio:install', { projectPath, source: 'published', requestId, auth })));
}

/** Change an installed Studio's sign-in type; only the sign-in variables of its wrangler.jsonc are edited. */
export async function changeStudioSignIn(projectPath: string, auth: StudioAuthConfig) {
  return parseStudioAuthResult(await window.avb.setStudioAuth(parseIpcPayload('studio:setAuth', { projectPath, auth })));
}

export function onStudioProgress(callback: (progress: StudioInstallProgress) => void) {
  return window.avb.onStudioProgress((input) => callback(parseStudioInstallProgress(input)));
}

/** Whether a newer Studio can replace the installed one, and what it would lose. Never rejects for a missing feed: that is `unavailable`. */
export async function readStudioUpgradeCheck(projectPath: string) {
  return parseStudioUpgradeCheck(await window.avb.studioUpgradeCheck(parseIpcPayload('studio:upgradeCheck', projectPath)));
}

/** Replace the installed Studio with the latest release; progress arrives through `onStudioProgress` under the same request ID. */
export async function upgradeStudio(projectPath: string, requestId: string) {
  return parseStudioUpgradeResult(await window.avb.upgradeStudio(parseIpcPayload('studio:upgrade', { projectPath, requestId })));
}

/** Put back the Studio the last upgrade backed up. */
export async function restoreStudio(projectPath: string) {
  return parseStudioRestoreResult(await window.avb.restoreStudio(parseIpcPayload('studio:restore', { projectPath })));
}
