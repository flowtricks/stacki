import { useSyncExternalStore } from 'react';
import type { RoleView } from '../../../vendor/stacki/shared/properties/projectRoles';
import { getEditorRole, getStudioRole, subscribeRole } from './roleStore';
export function useEditorRole() {
  return useSyncExternalStore(subscribeRole, getEditorRole, () => 'admin' as const);
}
/** The active role, including "View as". */
export function useStudioRole(): RoleView {
  return useSyncExternalStore(subscribeRole, getStudioRole, getStudioRole);
}
