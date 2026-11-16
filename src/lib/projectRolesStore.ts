// The project's roles file as last read, for the surfaces that show or edit rules beside the active role
// (the Components panel's Roles submenu). The role loader sets it on every read (src/app/roles/useProjectRoles.ts),
// so a change saved from Settings → Roles, from the submenu or from another window reaches every reader at once.
// Undefined while there is no readable file. Framework-free; React callers use `useStoredProjectRoles`.
import { useSyncExternalStore } from 'react';
import { assert } from '../../shared/core/assert';
import type { ProjectRoles } from '../../shared/properties/projectRoles';

/** Listeners are mounted panels; a leak past this is a bug, not growth. */
const LISTENERS_MAX = 100;

let current: ProjectRoles | undefined;
const listeners = new Set<() => void>();

export function storedProjectRoles(): ProjectRoles | undefined {
  return current;
}

/** Sets what was read; readers re-render only when it is a different value. */
export function setStoredProjectRoles(roles: ProjectRoles | undefined): void {
  assert(roles === undefined || roles.roles.length >= 2, 'A stored roles file holds admin and client');
  if (roles === current) {
    return;
  }
  current = roles;
  for (const listener of [...listeners]) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  assert(listeners.size < LISTENERS_MAX, 'Roles store listeners are bounded');
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useStoredProjectRoles(): ProjectRoles | undefined {
  return useSyncExternalStore(subscribe, storedProjectRoles, storedProjectRoles);
}
