// React's view of the active role (currentRole.ts): re-renders on every change,
// including an admin's "View as".
import { useSyncExternalStore } from 'react';
import type { RoleView } from '../../shared/properties/projectRoles';
import { actualRole, currentRole, onRoleChange } from './currentRole';

export function useCurrentRole(): RoleView {
  return useSyncExternalStore(onRoleChange, currentRole, currentRole);
}

/** The role the project gives this person, ignoring "View as". */
export function useActualRole(): RoleView {
  return useSyncExternalStore(onRoleChange, actualRole, actualRole);
}
