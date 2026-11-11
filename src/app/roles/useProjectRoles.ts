// Keeps the active role in step with the open project: reads `.stacki/roles.json`
// and the signed-in GitHub login, resolves the role main enforces, and reloads
// when project files change (the watcher reports `.stacki` edits as fs:changed).
// The Roles tab saves through rolesBridge.ts and calls `reloadProjectRoles`.
import { useEffect } from 'react';
import { assert } from '../../../shared/core/assert';
import { ADMIN_VIEW, resolveRole } from '../../../shared/properties/projectRoles';
import { setActualRole } from '../../lib/currentRole';
import { readRolesIdentity, readStoredRoles, type StoredRoles } from './rolesBridge';

const reloaders = new Set<() => void>();

/** Asks the mounted role loader to read the file again (after a save). */
export function reloadProjectRoles(): void {
  assert(reloaders.size <= 1, 'One role loader is mounted');
  for (const reload of reloaders) {
    reload();
  }
}

/** Mount once, beside the open project. No project means admin. */
export function useProjectRoles(projectPath: string | undefined): void {
  useEffect(() => {
    if (projectPath === undefined) {
      setActualRole(ADMIN_VIEW);
      return undefined;
    }
    let lifetime: 'active' | 'disposed' = 'active';
    let generation = 0;
    const load = () => {
      generation += 1;
      const mine = generation;
      void Promise.all([readStoredRoles(projectPath), readRolesIdentity(projectPath).catch(() => undefined)]).then(
        ([stored, login]) => {
          if (lifetime === 'active' && mine === generation) {
            setActualRole(desktopRoleOf(stored, login));
          }
        },
        () => undefined,
      );
    };
    load();
    reloaders.add(load);
    const stop = window.avb.onFsChanged(load);
    return () => {
      lifetime = 'disposed';
      reloaders.delete(load);
      stop();
    };
  }, [projectPath]);
}

/** Desktop's rule, the same one main enforces (electron/handlers/roleAccess.ts): a broken file is admin so it can be fixed. */
export function desktopRoleOf(stored: StoredRoles, login: string | undefined) {
  switch (stored.kind) {
    case 'absent':
    case 'invalid':
      return ADMIN_VIEW;
    case 'ready':
      return resolveRole(stored.roles, login, 'admin');
    default: {
      const exhaustive: never = stored;
      return exhaustive;
    }
  }
}
