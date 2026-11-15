// What the renderer asks about an EmDash project. Desktop asks the main process, which reads the project's
// own files and its local database (read only); Stacki Studio replaces this module with one that says EmDash
// is not available there yet (studio/scripts/shared-source.json). Every reply is parsed before a component
// sees it.
import { parseIpcPayload } from '../../shared/ipc/ipcPayloads';
import { parseEmDashProject, type EmDashProject } from '../../shared/properties/emdash';
import { parseEmDashInstallPlan, parseEmDashInstallResult, type EmDashInstallPlan, type EmDashInstallResult } from '../../shared/properties/emdashInstall';

/** Whether this host can read an EmDash project. */
export const EMDASH_HOST: { readonly available: boolean } = { available: true };

export async function readEmDashProject(projectPath: string): Promise<EmDashProject> {
  const input = parseIpcPayload('emdash:project', { projectPath });
  return parseEmDashProject(await window.avb.emDashProject(input));
}

/** What adding EmDash to this project would run and change, read from the project's own files. Nothing is changed. */
export async function planEmDashInstall(projectPath: string): Promise<EmDashInstallPlan> {
  const input = parseIpcPayload('emdash:installPlan', { projectPath });
  return parseEmDashInstallPlan(await window.avb.emDashInstallPlan(input));
}

/** Runs the install. `confirmedCommand` is the command the person was shown; main refuses a run that names any other. */
export async function runEmDashInstall(projectPath: string, confirmedCommand: string): Promise<EmDashInstallResult> {
  const input = parseIpcPayload('emdash:install', { projectPath, confirmedCommand });
  return parseEmDashInstallResult(await window.avb.emDashInstall(input));
}

export async function cancelEmDashInstall(projectPath: string): Promise<void> {
  await window.avb.emDashInstallCancel(parseIpcPayload('emdash:installCancel', { projectPath }));
}

/** Live output of the run, as text; returns what stops listening. */
export function onEmDashInstallLog(callback: (text: string) => void): () => void {
  return window.avb.onEmDashInstallLog((chunk) => {
    if (typeof chunk === 'string') {
      callback(chunk);
    }
  });
}
