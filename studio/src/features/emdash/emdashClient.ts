// EmDash in Stacki Studio: the same two exports as Desktop's bridge (src/ipc/emdashBridge.ts, which this module
// replaces in Studio). Desktop reads an EmDash project's own files and its local database (SQLite) from the
// project folder; Studio's projects live in the browser and its server, where that read is not built yet, so
// Studio says so instead of showing a project as empty. Content types are never invented here.
import type { EmDashProject } from '../../../vendor/stacki/shared/properties/emdash';
import type { EmDashInstallPlan, EmDashInstallResult } from '../../../vendor/stacki/shared/properties/emdashInstall';

export const EMDASH_HOST: { readonly available: boolean } = { available: false };

export async function readEmDashProject(_projectPath: string): Promise<EmDashProject> {
  return { kind: 'absent' };
}

// Adding EmDash runs a package manager in the project folder, which Studio's browser projects do not have. The button
// never shows here (EMDASH_HOST.available is false); these answer if something asks anyway.
export async function planEmDashInstall(_projectPath: string): Promise<EmDashInstallPlan> {
  return { kind: 'unavailable', reason: 'noPackageJson' };
}

export async function runEmDashInstall(_projectPath: string, _confirmedCommand: string): Promise<EmDashInstallResult> {
  return { kind: 'refused', reason: 'noPackageJson' };
}

export async function cancelEmDashInstall(_projectPath: string): Promise<void> {}

export function onEmDashInstallLog(_callback: (text: string) => void): () => void {
  return () => {};
}
