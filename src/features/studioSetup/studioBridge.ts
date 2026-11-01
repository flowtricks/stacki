import { parseIpcPayload } from '../../../shared/ipc/ipcPayloads';
import { parseStudioInstallResult, parseStudioStatus } from '../../../shared/ipc/studioSetup';
import { parseStudioInstallProgress, type StudioInstallProgress } from '../../../shared/ipc/studioProgress';

export async function readStudioStatus(projectPath: string) {
  return parseStudioStatus(await window.avb.studioStatus(parseIpcPayload('studio:status', projectPath)));
}

export async function addStudio(projectPath: string, requestId: string) {
  return parseStudioInstallResult(await window.avb.installStudio(parseIpcPayload('studio:install', { projectPath, source: 'published', requestId })));
}

export function onStudioProgress(callback: (progress: StudioInstallProgress) => void) {
  return window.avb.onStudioProgress((input) => callback(parseStudioInstallProgress(input)));
}
