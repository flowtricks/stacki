// EmDash in Stacki Studio: the same two exports as Desktop's bridge (src/ipc/emdashBridge.ts, which this module
// replaces in Studio). Desktop reads an EmDash project's own files and its local database (SQLite) from the
// project folder; Studio's projects live in the browser and its server, where that read is not built yet, so
// Studio says so instead of showing a project as empty. Content types are never invented here.
import type { EmDashProject } from '../../../vendor/stacki/shared/properties/emdash';

export const EMDASH_HOST: { readonly available: boolean } = { available: false };

export async function readEmDashProject(_projectPath: string): Promise<EmDashProject> {
  return { kind: 'absent' };
}
