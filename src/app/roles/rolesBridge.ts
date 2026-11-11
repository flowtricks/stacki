// The renderer's boundary for project roles: the roles file through the project
// metadata transport, and the signed-in GitHub login through `roles:identity`.
// Both replies are parsed before use (docs/contracts.md, "Project roles").
import { assert } from '../../../shared/core/assert';
import { optional, record } from '../../../shared/core/boundary';
import { parseIpcPayload } from '../../../shared/ipc/ipcPayloads';
import { parseGitHubLogin, parseProjectRolesSource, serializeProjectRoles, type ProjectRoles } from '../../../shared/properties/projectRoles';
import { readMetadata, writeMetadata } from '../../ipc/projectMetadataBridge';

/** The roles file as read: its parsed roles and the exact text a save must witness. */
export type StoredRoles =
  | { readonly kind: 'absent' }
  | { readonly kind: 'ready'; readonly roles: ProjectRoles; readonly source: string }
  | { readonly kind: 'invalid'; readonly message: string; readonly source: string };

export async function readStoredRoles(projectPath: string): Promise<StoredRoles> {
  assert(projectPath.length > 0, 'Roles are read for an open project');
  const file = await readMetadata(projectPath, 'roles');
  const source = file.source;
  if (source === undefined) {
    return { kind: 'absent' };
  }
  try {
    return { kind: 'ready', roles: parseProjectRolesSource(source), source };
  } catch (error: unknown) {
    return { kind: 'invalid', message: error instanceof Error ? error.message : String(error), source };
  }
}

/** Saves roles over `base` (the text last read, undefined to create the file). */
export async function saveStoredRoles(projectPath: string, roles: ProjectRoles, base: string | undefined): Promise<string> {
  const source = serializeProjectRoles(roles);
  await writeMetadata(projectPath, base === undefined ? { kind: 'roles', source } : { kind: 'roles', source, base });
  return source;
}

/** The signed-in GitHub login main resolves roles for, or undefined. */
export async function readRolesIdentity(projectPath: string): Promise<string | undefined> {
  const payload = parseIpcPayload('roles:identity', { projectPath });
  return parseRolesIdentity(await window.avb.rolesIdentity(payload));
}

export function parseRolesIdentity(input: unknown): string | undefined {
  const value = record(input);
  const login = optional(parseGitHubLogin)(value['login']);
  assert(login === undefined || login.length > 0, 'A login is never empty');
  return login;
}
