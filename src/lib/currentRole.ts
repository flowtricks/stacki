// The role the editor acts as right now, for every renderer module that adapts
// to it (rail buttons, menus, shortcuts, the Apps platform). Two inputs set it:
// the project's resolved role (`setActualRole`, from `.stacki/roles.json` and the
// signed-in GitHub user), and an admin's "View as" choice (`setViewAs`), which
// previews another role without changing the file or what main allows.
//
// The shape of `currentRole` and `onRoleChange` is a contract the Apps platform
// imports from here; do not change their signatures. The store lives in lib so
// feature modules below the app layer and the app shell read the same one. Framework-free on purpose: React callers use `useCurrentRole`
// (useCurrentRole.ts), and Studio sets the same store.
import { assert } from '../../shared/core/assert';
import { ADMIN_VIEW, sameAppPermissions, type RoleView } from '../../shared/properties/projectRoles';

/** Listeners are components and apps; a leak past this is a bug, not growth. */
const LISTENERS_MAX = 500;

let actual: RoleView = ADMIN_VIEW;
let viewAs: RoleView | undefined;
const listeners = new Set<(role: RoleView) => void>();

/** The active role: the "View as" role while an admin previews one, else the resolved role. */
export function currentRole(): RoleView {
  const role = viewAs ?? actual;
  assert(viewAs === undefined || actual.isAdmin, 'Only an admin can view as another role');
  return role;
}

/** Calls `listener` with the new active role whenever it changes. Returns the unsubscribe. */
export function onRoleChange(listener: (role: RoleView) => void): () => void {
  assert(listeners.size < LISTENERS_MAX, 'Role listeners are bounded');
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The role the project gives this person, ignoring "View as". */
export function actualRole(): RoleView {
  assert(actual.id.length > 0, 'The actual role has an id');
  return actual;
}

/** The "View as" role, when an admin is previewing one. */
export function viewingAs(): RoleView | undefined {
  assert(viewAs === undefined || actual.isAdmin, 'Only an admin can view as another role');
  return viewAs;
}

/** Sets the resolved role. A non-admin cannot keep a "View as" preview. */
export function setActualRole(role: RoleView): void {
  assert(role.id.length > 0, 'A role has an id');
  const before = currentRole();
  actual = role;
  if (!role.isAdmin) {
    viewAs = undefined;
  }
  notify(before);
}

/** Previews `role` (an admin only), or stops previewing with undefined. Admin itself means no preview. */
export function setViewAs(role: RoleView | undefined): void {
  assert(role === undefined || actual.isAdmin, 'Only an admin can view as another role');
  const before = currentRole();
  viewAs = role === undefined || role.isAdmin ? undefined : role;
  notify(before);
}

function notify(before: RoleView): void {
  const after = currentRole();
  if (sameView(before, after)) {
    return;
  }
  assert(listeners.size <= LISTENERS_MAX, 'Role listeners are bounded');
  for (const listener of [...listeners]) {
    listener(after);
  }
}

function sameView(left: RoleView, right: RoleView): boolean {
  if (left === right) {
    return true;
  }
  if (left.id !== right.id || left.name !== right.name || left.features.size !== right.features.size) {
    return false;
  }
  if (![...left.features].every((feature) => right.features.has(feature))) {
    return false;
  }
  // App permission values are part of the role: an admin switching one must reach apps as `role.change`.
  // Rail pins are too: pinning an app must reach the rail at once.
  return sameAppPermissions(left.appPermissions, right.appPermissions) && samePins(left.pinnedApps, right.pinnedApps);
}

// Order matters: the rail draws pins in the order they were pinned.
function samePins(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((appId, index) => right[index] === appId);
}
