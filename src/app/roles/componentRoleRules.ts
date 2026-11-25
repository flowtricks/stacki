// What the Components panel's Roles submenu needs (src/features/palette/componentRolesMenu.ts): the project's roles as
// last read (kept current by useProjectRoles.ts, so a change made in Settings → Roles shows at once) and a way to
// change one role's hidden components. A change re-reads the file, applies the same edit the Roles tab applies
// (settings/rolesEdits.ts), writes over the text it read and reloads the roles, one change at a time, so two quick
// flips never overwrite each other. A project with no roles file shows the built-in roles (admin and client); the first
// change writes the file, naming the signed-in GitHub account as its first admin as Settings → Roles does. With nobody
// signed in it writes the file unclaimed (no members), which grants exactly as no file does (projectRoles.ts `rolesClaimed`).
// An existing file, unclaimed or not, is changed as read: no member is ever added here.
import { useMemo, useRef } from 'react';
import { assert } from '../../../shared/core/assert';
import { DEFAULT_PROJECT_ROLES, can, type ProjectRoles } from '../../../shared/properties/projectRoles';
import { useCurrentRole } from '../../lib/useCurrentRole';
import { useStoredProjectRoles } from '../../lib/projectRolesStore';
import type { PaletteRoleRules } from '../../features/palette/componentRolesMenu';
import { setComponentVisibility } from '../settings/rolesEdits';
import { readRolesIdentity, readStoredRoles, saveStoredRoles } from './rolesBridge';
import { reloadProjectRoles } from './useProjectRoles';

export function useComponentRoleRules(projectPath: string | undefined, report: (failure: unknown) => void): PaletteRoleRules | undefined {
  const stored = useStoredProjectRoles();
  const editable = can(useCurrentRole(), 'settings:roles');
  const queue = useRef<Promise<void>>(Promise.resolve());
  return useMemo((): PaletteRoleRules | undefined => {
    if (projectPath === undefined) {
      return undefined;
    }
    return {
      roles: stored ?? DEFAULT_PROJECT_ROLES,
      editable,
      setVisibility: (roleId, target, state) => {
        queue.current = queue.current
          .then(async () => {
            const read = await readStoredRoles(projectPath);
            if (read.kind === 'invalid') {
              throw new Error(`The roles file could not be read: ${read.message}`);
            }
            const base = read.kind === 'ready' ? read.roles : await firstRoles(projectPath);
            const source = read.kind === 'ready' ? read.source : undefined;
            await saveStoredRoles(projectPath, setComponentVisibility(base, roleId, target, state), source);
            reloadProjectRoles();
          })
          .catch(report);
      },
    };
  }, [stored, editable, projectPath, report]);
}

// The roles of a project with no file yet: the built-in two, with the signed-in account as admin, or unclaimed without one.
async function firstRoles(projectPath: string): Promise<ProjectRoles> {
  const login = await readRolesIdentity(projectPath).catch(() => undefined);
  if (login === undefined) {
    return DEFAULT_PROJECT_ROLES;
  }
  const admin = DEFAULT_PROJECT_ROLES.roles[0];
  assert(admin !== undefined, 'The default roles start with admin');
  return { ...DEFAULT_PROJECT_ROLES, roles: [{ ...admin, members: [login] }, ...DEFAULT_PROJECT_ROLES.roles.slice(1)] };
}
