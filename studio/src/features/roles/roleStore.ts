// Studio's role, on the shared role store (vendor/stacki/src/lib/currentRole.ts):
// the project's roles (`.stacki/roles.json`) resolved for the signed-in GitHub
// user (useStudioRoles.ts), plus an admin's "View as" choice kept for the tab in
// sessionStorage. "developer" and the old stored value "designer" read as admin.
//
// `EditorRole` is the editing mode the collaboration code checks: `client` is
// Client mode's layout-only editing, held by any role without `page:layout`.
// Panels and actions ask `can()` for their own feature instead.
import { assert } from '../../../vendor/stacki/shared/core/assert';
import {
  ADMIN_ROLE_ID,
  DEFAULT_PROJECT_ROLES,
  can,
  canonicalRoleId,
  roleViewOf,
  type ProjectRoles,
  type RoleView,
} from '../../../vendor/stacki/shared/properties/projectRoles';
import { actualRole, currentRole, onRoleChange, setActualRole, setViewAs } from '../../../vendor/stacki/src/lib/currentRole';
import { canPanel } from '../../../vendor/stacki/src/lib/roleAccess';

export type EditorRole = 'admin' | 'client';

const STORAGE_KEY = 'studio-role';
let roles: ProjectRoles = DEFAULT_PROJECT_ROLES;
let restored = false;

/** Client mode (layout-only editing) or full editing, for the active role. */
export function getEditorRole(): EditorRole {
  restoreViewAs();
  return can(currentRole(), 'page:layout') ? 'admin' : 'client';
}

/** The active role, including "View as". */
export function getStudioRole(): RoleView {
  restoreViewAs();
  return currentRole();
}

/** The roles "View as" offers: the project's, or admin and client without a file. */
export function studioRoles(): ProjectRoles {
  assert(roles.roles.length >= 2, 'Admin and client are always offered');
  return roles;
}

/** "View as" `id` (an admin only); admin itself ends the preview. */
export function setEditorRole(id: string): void {
  assert(actualRole().isAdmin, 'Only an admin can view as another role');
  const canonical = canonicalRoleId(id);
  setViewAs(canonical === ADMIN_ROLE_ID ? undefined : roleViewOf(roles, canonical));
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(STORAGE_KEY, canonical);
    }
  } catch {
    /* Role switching also works when browser storage is unavailable. */
  }
}

/** Sets the project's roles and the role they give this person. */
export function setStudioRoles(next: ProjectRoles, actual: RoleView): void {
  assert(next.roles.length >= 2, 'Admin and client are always present');
  roles = next;
  setActualRole(actual);
  restored = false;
  restoreViewAs();
}

/** Whether `role` sees a Studio panel. Studio calls the CMS panel "collections". */
export function canStudioPanel(role: RoleView, panel: string | undefined): boolean {
  if (panel === undefined) {
    return true;
  }
  assert(panel.length > 0, 'A panel id is never empty');
  return canPanel(role, panel === 'collections' ? 'cms' : panel);
}

export function subscribeRole(listener: () => void): () => void {
  return onRoleChange(() => listener());
}

// The tab's last "View as" choice, read once per roles change. An id the
// project no longer has, or a person who is not admin, previews nothing.
function restoreViewAs(): void {
  if (restored) {
    return;
  }
  restored = true;
  let stored: string | null = null;
  try {
    stored = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(STORAGE_KEY) : null;
  } catch {
    stored = null;
  }
  if (stored === null || stored.length === 0 || !actualRole().isAdmin) {
    return;
  }
  const id = canonicalRoleId(stored);
  if (id === ADMIN_ROLE_ID) {
    setViewAs(undefined);
    return;
  }
  if (roles.roles.some((role) => role.id === id)) {
    setViewAs(roleViewOf(roles, id));
  }
}
