// What the renderer asks about an EmDash project. Desktop asks the main process, which reads the project's
// own files and its local database (read only); Stacki Studio replaces this module with one that says EmDash
// is not available there yet (studio/scripts/shared-source.json). Every reply is parsed before a component
// sees it.
import { parseIpcPayload } from '../../shared/ipc/ipcPayloads';
import { parseOkResult } from '../../shared/ipc/ipcContract';
import { record } from '../../shared/core/boundary';
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

/** The EmDash admin on the project's own preview address, when the preview runs; undefined otherwise. */
export async function readEmDashAdminUrl(projectPath: string): Promise<string | undefined> {
  const answer = await window.avb.emDashAdminUrl(parseIpcPayload('emdash:adminUrl', { projectPath }));
  const url = parseOptionalAddress(answer);
  return url === undefined ? undefined : `${url.replace(/\/$/, '')}/_emdash/admin/`;
}

/** Opens an address in the person's own browser. Only addresses main produced reach here. */
export async function openEmDashAdmin(url: string): Promise<void> {
  parseOkResult(await window.avb.openExternal(parseIpcPayload('shell:openExternal', url)));
}

function parseOptionalAddress(input: unknown): string | undefined {
  const value = record(input)['url'];
  return typeof value === 'string' && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(value) ? value : undefined;
}
