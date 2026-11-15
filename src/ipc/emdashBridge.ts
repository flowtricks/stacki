// What the renderer asks about an EmDash project. Desktop asks the main process, which reads the project's
// own files and its local database (read only); Stacki Studio replaces this module with one that says EmDash
// is not available there yet (studio/scripts/shared-source.json). Every reply is parsed before a component
// sees it.
import { parseIpcPayload } from '../../shared/ipc/ipcPayloads';
import { parseEmDashProject, type EmDashProject } from '../../shared/properties/emdash';

/** Whether this host can read an EmDash project. */
export const EMDASH_HOST: { readonly available: boolean } = { available: true };

export async function readEmDashProject(projectPath: string): Promise<EmDashProject> {
  const input = parseIpcPayload('emdash:project', { projectPath });
  return parseEmDashProject(await window.avb.emDashProject(input));
}
