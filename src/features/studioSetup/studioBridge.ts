import { parseIpcPayload } from '../../../shared/ipc/ipcPayloads';
import { parseStudioAuthResult, parseStudioInstallResult, parseStudioStatus } from '../../../shared/ipc/studioSetup';
import type { StudioAuthConfig } from '../../../shared/ipc/studioAuth';
import { parseStudioInstallProgress, type StudioInstallProgress } from '../../../shared/ipc/studioProgress';

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
