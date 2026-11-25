// Keeps the active role in step with the open project: reads `.stacki/roles.json`
// and reloads when project files change (the watcher reports `.stacki` edits as fs:changed).
// The Roles tab saves through rolesBridge.ts and calls `reloadProjectRoles`. Every read also lands in
// rolesCache.ts, so Settings → Roles opens on the file as last read instead of reading it first.
import { useEffect } from 'react';
import { assert } from '../../../shared/core/assert';
import { ADMIN_ROLE_ID, ADMIN_VIEW, roleViewOf } from '../../../shared/properties/projectRoles';
import { setActualRole } from '../../lib/currentRole';
import { setStoredProjectRoles } from '../../lib/projectRolesStore';
import { type StoredRoles } from './rolesBridge';
import { rolesCache } from './rolesCache';

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
      setStoredProjectRoles(undefined);
      return undefined;
    }
    let lifetime: 'active' | 'disposed' = 'active';
    let generation = 0;
    const load = () => {
      generation += 1;
      const mine = generation;
      void rolesCache.refreshStoredRoles(projectPath).then(
        (stored) => {
          if (lifetime === 'active' && mine === generation) {
            setActualRole(desktopRoleOf(stored));
            setStoredProjectRoles(stored.kind === 'ready' ? stored.roles : undefined);
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

/**
 * The role Desktop acts as: always the admin, whoever is signed in and whatever the file says.
 * Why: Desktop previews roles ("View as") and never enforces them; only Studio does, because there
 * the server is the boundary. Here the person works on their own files, so a role that restricted
 * them would only lock the owner out of Settings → Roles. A readable file contributes the admin
 * role's own pins and hidden-component rules, as it does for any admin.
 */
export function desktopRoleOf(stored: StoredRoles) {
  switch (stored.kind) {
    case 'absent':
    case 'invalid':
      return ADMIN_VIEW;
    case 'ready': {
      const view = roleViewOf(stored.roles, ADMIN_ROLE_ID);
      assert(view.isAdmin, 'Desktop always acts as admin');
      return view;
    }
    default: {
      const exhaustive: never = stored;
      return exhaustive;
    }
  }
}
