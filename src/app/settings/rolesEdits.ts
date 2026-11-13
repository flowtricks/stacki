// The Roles tab's edits, as pure functions over a roles value: each takes the
// roles as saved and returns the next ones, or throws with the reason the tab
// shows beside the control. The tab saves each accepted edit at once, and only
// through `serializeProjectRoles`, which re-parses, so an edit that slipped past
// these checks still cannot reach disk.
import { assert } from '../../../shared/core/assert';
import { APP_PERMISSION_LIMITS } from '../../../shared/properties/appPermissions';
import { DescribedError } from '../../../shared/properties/describedError';
import { ENGLISH_TRANSLATE } from '../../../shared/properties/i18n/englishTranslator';
import { described, type Described, type Translator } from '../../../shared/properties/i18n/messageRef';
import {
  ACCESS_FEATURES,
  ADMIN_ROLE_ID,
  APP_ACCESS_ALL,
  CLIENT_ROLE_ID,
  ROLE_LIMITS,
  can,
  memberRole,
  parseAppGrantId,
  parseGitHubLogin,
  resolveRole,
  roleView,
  roleIdFor,
  sameLogin,
  type AccessFeature,
  type ProjectRole,
  type ProjectRoles,
} from '../../../shared/properties/projectRoles';

/** Adds a custom role named `name` with no members and no access. */
export function addRole(roles: ProjectRoles, name: string): ProjectRoles {
  const trimmed = roleNameFor(roles, undefined, name);
  if (roles.roles.length >= ROLE_LIMITS.rolesMax) {
    throw new DescribedError(described('roles.error.rolesMax', { count: ROLE_LIMITS.rolesMax }));
  }
  const id = roleIdFor(
    trimmed,
    roles.roles.map((role) => role.id),
  );
  const next = { ...roles, roles: [...roles.roles, { id, name: trimmed, members: [], access: [], appPermissions: {}, pinnedApps: [] }] };
  assert(next.roles.length === roles.roles.length + 1, 'Adding a role adds one');
  return next;
}

/**
 * Copies role `id` into a new custom role right after it, named "<Name> copy" (then
 * "copy 2", "copy 3" while taken), with the same access, app permissions and pins in
 * order, and no members: a person belongs to one role, so members never copy. A copy
 * of admin is an ordinary role holding every grantable feature and every app.
 * Admin and client always lead the file (the parser puts them there), so a copy of
 * either goes first among the custom roles.
 */
export function duplicateRole(
  roles: ProjectRoles,
  id: string,
  translate: Translator = ENGLISH_TRANSLATE,
): { readonly roles: ProjectRoles; readonly id: string } {
  const sourceIndex = roles.roles.findIndex((role) => role.id === id);
  const source = roles.roles[sourceIndex];
  assert(source !== undefined, 'A duplicated role exists');
  if (roles.roles.length >= ROLE_LIMITS.rolesMax) {
    throw new DescribedError(described('roles.error.rolesMax', { count: ROLE_LIMITS.rolesMax }));
  }
  const name = copyName(roles, source.name, translate);
  const copyId = roleIdFor(
    name,
    roles.roles.map((role) => role.id),
  );
  const access: readonly AccessFeature[] =
    source.id === ADMIN_ROLE_ID ? [...ACCESS_FEATURES.filter((feature) => feature !== 'settings:roles'), APP_ACCESS_ALL] : source.access;
  const copy: ProjectRole = { id: copyId, name, members: [], access, appPermissions: source.appPermissions, pinnedApps: [...source.pinnedApps] };
  const at = Math.max(sourceIndex + 1, BUILT_IN_ROLE_COUNT);
  const next = { ...roles, roles: [...roles.roles.slice(0, at), copy, ...roles.roles.slice(at)] };
  assert(next.roles.length === roles.roles.length + 1, 'Duplicating adds one role');
  assert(next.roles[at]?.id === copyId, 'The copy sits right after its source, or the built-in roles');
  return { roles: next, id: copyId };
}

/** Admin and client, which lead every roles list. */
const BUILT_IN_ROLE_COUNT = 2;

// "<Name> copy", then "<Name> copy 2" and on, within the name bound and unique ignoring case.
function copyName(roles: ProjectRoles, name: string, translate: Translator): string {
  const taken = new Set(roles.roles.map((role) => role.name.toLowerCase()));
  const named = (base: string, attempt: number): string =>
    attempt === 1 ? translate('roles.copy.name', { name: base }) : translate('roles.copy.numbered', { name: base, number: attempt });
  for (let attempt = 1; attempt <= ROLE_LIMITS.rolesMax + 1; attempt += 1) {
    // The copy's wording differs by language, so the base is cut by how far the whole name overshoots the bound.
    const whole = named(name, attempt);
    const overshoot = Math.max(0, whole.length - ROLE_LIMITS.roleNameCharsMax);
    const candidate = overshoot === 0 ? whole : named(name.slice(0, Math.max(1, name.length - overshoot)).trimEnd(), attempt);
    if (!taken.has(candidate.toLowerCase())) {
      assert(candidate.length <= ROLE_LIMITS.roleNameCharsMax, 'A copy name is within the name bound');
      return candidate;
    }
  }
  // More names than roles can be taken only if roles exceed their bound, which the parser refuses.
  throw new Error('Assertion failed: a free copy name exists among a bounded number of roles');
}

/** Renames a role, Client included; its id, and so its grants, stay. Admin is always "Admin". */
export function renameRole(roles: ProjectRoles, id: string, name: string): ProjectRoles {
  assert(id !== ADMIN_ROLE_ID, 'Admin keeps its name');
  const trimmed = roleNameFor(roles, id, name);
  const next = updateRole(roles, id, (role) => ({ ...role, name: trimmed }));
  assert(
    next.roles.some((role) => role.id === id && role.name === trimmed),
    'Renaming keeps the id',
  );
  return next;
}

/**
 * The name `input` gives role `id` (undefined for a new role): trimmed, 1 to
 * 60 characters, and unique among the other roles ignoring case, so two roles
 * never read the same in a picker. Throws with the reason otherwise.
 */
export function roleNameFor(roles: ProjectRoles, id: string | undefined, input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new DescribedError(described('roles.error.nameEmpty'));
  }
  if (trimmed.length > ROLE_LIMITS.roleNameCharsMax) {
    throw new DescribedError(described('roles.error.nameLong', { max: ROLE_LIMITS.roleNameCharsMax }));
  }
  const taken = roles.roles.find((role) => role.id !== id && role.name.toLowerCase() === trimmed.toLowerCase());
  if (taken !== undefined) {
    throw new DescribedError(described('roles.error.nameTaken', { name: taken.name }));
  }
  return trimmed;
}

/** Deletes a custom role; its members fall back to the default role, which moves to admin if it was this one. */
export function deleteRole(roles: ProjectRoles, id: string): ProjectRoles {
  assert(id !== ADMIN_ROLE_ID, 'Admin cannot be deleted');
  assert(id !== CLIENT_ROLE_ID, 'Client cannot be deleted');
  const next = {
    ...roles,
    defaultRole: roles.defaultRole === id ? ADMIN_ROLE_ID : roles.defaultRole,
    roles: roles.roles.filter((role) => role.id !== id),
  };
  assert(next.roles.length === roles.roles.length - 1, 'Deleting a role removes exactly one');
  return next;
}

/** Adds a GitHub username to a role. A person belongs to one role, so they leave any other first. */
export function addMember(roles: ProjectRoles, id: string, input: string): ProjectRoles {
  const login = parseGitHubLogin(input);
  const target = roles.roles.find((role) => role.id === id);
  assert(target !== undefined, 'Members are added to a role that exists');
  if (target.members.some((member) => sameLogin(member, login))) {
    throw new DescribedError(described('roles.error.memberListed', { login, role: target.name }));
  }
  if (target.members.length >= ROLE_LIMITS.membersMax) {
    throw new DescribedError(described('roles.error.membersMax', { count: ROLE_LIMITS.membersMax }));
  }
  const previous = memberRole(roles, login);
  const without = previous === undefined ? roles : removeMember(roles, previous.id, login);
  return updateRole(without, id, (role) => ({ ...role, members: [...role.members, login] }));
}

/** Removes a GitHub username from a role. The last admin cannot be removed. */
export function removeMember(roles: ProjectRoles, id: string, login: string): ProjectRoles {
  const target = roles.roles.find((role) => role.id === id);
  assert(target !== undefined, 'Members are removed from a role that exists');
  if (id === ADMIN_ROLE_ID && target.members.length === 1 && target.members.some((member) => sameLogin(member, login))) {
    throw new DescribedError(described('roles.error.lastAdmin'));
  }
  return updateRole(roles, id, (role) => ({ ...role, members: role.members.filter((member) => !sameLogin(member, login)) }));
}

/** Grants or withdraws one feature. Admin has everything and is never edited. */
export function setAccess(roles: ProjectRoles, id: string, feature: AccessFeature, change: 'grant' | 'withdraw'): ProjectRoles {
  assert(id !== ADMIN_ROLE_ID, 'Admin access is not editable');
  assert(feature !== 'settings:roles', 'Only admin edits roles');
  return updateRole(roles, id, (role) => {
    const without = role.access.filter((item) => item !== feature);
    return { ...role, access: change === 'grant' ? [...without, feature] : without };
  });
}

/** Grants or withdraws a whole group of features at once: the group's "All" switch. */
export function setGroupAccess(roles: ProjectRoles, id: string, features: readonly AccessFeature[], change: 'grant' | 'withdraw'): ProjectRoles {
  assert(features.length > 0, 'A group has features');
  assert(features.length <= ROLE_LIMITS.accessMax, 'A group is within the grant bound');
  let next = roles;
  for (const feature of features) {
    next = setAccess(next, id, feature, change);
  }
  const role = next.roles.find((item) => item.id === id);
  assert(role !== undefined, 'The role still exists');
  assert(
    features.every((feature) => role.access.includes(feature) === (change === 'grant')),
    'Every feature of the group is set',
  );
  return next;
}

/**
 * Lets a role use one app (`grant`), or stops it (`withdraw`): the app's switch in
 * the Roles tab. Using an app needs the Apps panel too (`can`), so granting one
 * grants the panel in the same step. Withdrawing removes only the app's grant: the
 * role's stored permission values for it stay, so granting it again restores them.
 * Under "Every app" (`app:*`) every app is usable and the per-app switch is fixed.
 */
export function setAppAccess(roles: ProjectRoles, id: string, appId: string, change: 'grant' | 'withdraw'): ProjectRoles {
  assert(id !== ADMIN_ROLE_ID, 'Admin uses every app and is never edited');
  const target = roles.roles.find((role) => role.id === id);
  assert(target !== undefined, 'App access changes on a role that exists');
  const feature: AccessFeature = `app:${parseAppGrantId(appId)}`;
  if (change === 'withdraw') {
    assert(!target.access.includes(APP_ACCESS_ALL), 'Under Every app, one app is not switched off on its own');
    const next = setAccess(roles, id, feature, 'withdraw');
    assert(!can(roleView(roleOf(next, id)), feature), 'A withdrawn app is no longer usable');
    return next;
  }
  const withPanel = roleOf(roles, id).access.includes('panel:apps') ? roles : setAccess(roles, id, 'panel:apps', 'grant');
  // Under Every app the panel was all that was missing.
  const covered = roleOf(withPanel, id).access.includes(feature) || roleOf(withPanel, id).access.includes(APP_ACCESS_ALL);
  const next = covered ? withPanel : setAccess(withPanel, id, feature, 'grant');
  assert(can(roleView(roleOf(next, id)), feature), 'A granted app is usable');
  return next;
}

/**
 * Turns app permissions on (`grant`) or off (`withdraw`) for a role: one switch,
 * or a whole app's "All" switch. The value is stored even when it equals the
 * manifest's default, so the admin's choice outlasts a later change of default.
 * Turning a permission on while the role cannot use the app also lets it use the
 * app, so one switch does what the admin asked; turning one off never removes access.
 */
export function setAppPermissions(
  roles: ProjectRoles,
  id: string,
  appId: string,
  permissionIds: readonly string[],
  change: 'grant' | 'withdraw',
): ProjectRoles {
  assert(id !== ADMIN_ROLE_ID, 'Admin has every app permission and is never edited');
  assert(permissionIds.length > 0, 'An app permission change names a permission');
  assert(permissionIds.length <= APP_PERMISSION_LIMITS.permissionsMax, 'An app permission change is within the declaration bound');
  const target = roles.roles.find((role) => role.id === id);
  assert(target !== undefined, 'App permissions change on a role that exists');
  const known = Object.hasOwn(target.appPermissions, appId);
  if (!known && Object.keys(target.appPermissions).length >= ROLE_LIMITS.appPermissionAppsMax) {
    throw new DescribedError(described('roles.error.appsMax', { count: ROLE_LIMITS.appPermissionAppsMax }));
  }
  const values = { ...(known ? target.appPermissions[appId] : {}) };
  for (const permissionId of permissionIds) {
    values[permissionId] = change === 'grant';
  }
  // Values kept for permissions a newer version dropped count too, so the file's own bound is checked here, beside the switch.
  if (Object.keys(values).length > APP_PERMISSION_LIMITS.permissionsMax) {
    throw new DescribedError(described('roles.error.permissionsMax', { count: APP_PERMISSION_LIMITS.permissionsMax }));
  }
  const stored = updateRole(roles, id, (role) => ({ ...role, appPermissions: { ...role.appPermissions, [appId]: values } }));
  assert(Object.hasOwn(roleOf(stored, id).appPermissions, appId), 'The app now has stored values');
  if (change === 'withdraw' || can(roleView(roleOf(stored, id)), `app:${appId}`)) {
    return stored;
  }
  return setAppAccess(stored, id, appId, 'grant');
}

/**
 * Pins an app to the left rail for a role (admin included), after the ones already
 * pinned, or unpins it. Pinning an app the role cannot use also lets it use the app,
 * in the same save ("Also gives <Role> access" in the Roles tab); unpinning always
 * works, so a pin left behind by withdrawn access or an uninstall can go.
 */
export function setPinnedApp(roles: ProjectRoles, id: string, appId: string, change: 'pin' | 'unpin'): ProjectRoles {
  const target = roles.roles.find((role) => role.id === id);
  assert(target !== undefined, 'Apps are pinned for a role that exists');
  const app = parseAppGrantId(appId);
  const without = target.pinnedApps.filter((item) => item !== app);
  if (change === 'unpin') {
    const next = updateRole(roles, id, (role) => ({ ...role, pinnedApps: without }));
    assert(!next.roles.some((role) => role.id === id && role.pinnedApps.includes(app)), 'An unpinned app is gone from the role');
    return next;
  }
  if (target.pinnedApps.includes(app)) {
    return roles;
  }
  if (target.pinnedApps.length >= ROLE_LIMITS.pinnedAppsMax) {
    throw new DescribedError(described('roles.error.pinsMax', { count: ROLE_LIMITS.pinnedAppsMax }));
  }
  const usable = can(roleView(target), `app:${app}`) ? roles : setAppAccess(roles, id, app, 'grant');
  const next = updateRole(usable, id, (role) => ({ ...role, pinnedApps: [...without, app] }));
  assert(can(roleView(roleOf(next, id)), `app:${app}`), 'A pinned app is usable by its role');
  assert(next.roles.find((role) => role.id === id)?.pinnedApps.at(-1) === app, 'A pinned app goes last');
  return next;
}

/**
 * Puts a role's pins in `order`, the rail's order top to bottom. `order` must hold
 * exactly the pins the role has, so a reorder never adds or drops one.
 */
export function orderPinnedApps(roles: ProjectRoles, id: string, order: readonly string[]): ProjectRoles {
  const target = roles.roles.find((role) => role.id === id);
  assert(target !== undefined, 'Pins are ordered for a role that exists');
  assert(order.length === target.pinnedApps.length, 'A reorder keeps the number of pins');
  assert(new Set(order).size === order.length, 'A reorder names each pin once');
  assert(
    order.every((appId) => target.pinnedApps.includes(appId)),
    'A reorder names only pinned apps',
  );
  const next = updateRole(roles, id, (role) => ({ ...role, pinnedApps: [...order] }));
  assert(next.roles.find((role) => role.id === id)?.pinnedApps.length === order.length, 'The reordered pins are all kept');
  return next;
}

/** The pins in `pinned` with the one at `source` moved to the drop gap `gap` (0 to length, measured before removal). */
export function movedPin(pinned: readonly string[], source: number, gap: number): readonly string[] {
  assert(Number.isSafeInteger(source), 'A moved pin has an index');
  assert(source >= 0, 'A moved pin index is not negative');
  assert(source < pinned.length, 'A moved pin is in the list');
  assert(Number.isSafeInteger(gap), 'A drop gap is an index');
  assert(gap >= 0, 'A drop gap is not negative');
  assert(gap <= pinned.length, 'A drop gap is in the list');
  const moving = pinned[source];
  assert(moving !== undefined, 'The moved pin exists');
  const rest = pinned.filter((_, index) => index !== source);
  // The gap was measured with the pin still in place, so a gap after it shifts up by one.
  const at = gap > source ? gap - 1 : gap;
  const next = [...rest.slice(0, at), moving, ...rest.slice(at)];
  assert(next.length === pinned.length, 'Moving a pin keeps every pin');
  return next;
}

/** The role signed-in people named in no role get on Studio. */
export function setDefaultRole(roles: ProjectRoles, id: string): ProjectRoles {
  assert(
    roles.roles.some((role) => role.id === id),
    'The default role is a role',
  );
  const next = { ...roles, defaultRole: id };
  assert(next.roles === roles.roles, 'Choosing the default changes no role');
  return next;
}

/** Why saving `roles` would lock `login` out of editing roles, or undefined when it would not. */
export function selfLockout(roles: ProjectRoles, login: string | undefined): Described | undefined {
  if (login === undefined) {
    return undefined;
  }
  const role = resolveRole(roles, login, 'admin');
  assert(role.id.length > 0, 'A resolved role has an id');
  return role.isAdmin ? undefined : described('roles.error.lockout', { login, role: role.name });
}

function roleOf(roles: ProjectRoles, id: string): ProjectRole {
  const role = roles.roles.find((item) => item.id === id);
  assert(role !== undefined, `Role "${id}" exists`);
  assert(role.id.length > 0, 'A role has an id');
  return role;
}

function updateRole(roles: ProjectRoles, id: string, change: (role: ProjectRole) => ProjectRole): ProjectRoles {
  assert(
    roles.roles.some((role) => role.id === id),
    `Role "${id}" exists`,
  );
  const next = { ...roles, roles: roles.roles.map((role) => (role.id === id ? change(role) : role)) };
  assert(next.roles.length === roles.roles.length, 'Changing a role keeps the count');
  return next;
}
