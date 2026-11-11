// Project roles: who may use which parts of Stacki in one project, shared by
// Desktop and Studio through `.stacki/roles.json`. This module is the contract:
// the access features, the bounded file parser, how a GitHub login resolves to
// a role, and `can()`, the one question every caller asks. The Apps platform
// imports `AccessFeature`, `RoleView` and `can` from here, so their shapes are
// fixed (docs/contracts.md, "Project roles").
//
// Admin can never be restricted: `can(admin, anything)` is true, admin's access
// list is not stored, and the parser refuses a file with no admin member, so no
// save can lock the project's owners out. "developer" (and Studio's internal
// "designer") is the old name of admin and still reads as admin.
//
// Each role may also hold the switches installed apps declare (`appPermissions`,
// shared/properties/appPermissions.ts). Stacki stores and resolves them
// (`appPermissionsFor`); the app enforces them in its own features.
//
// Each role, admin included, may pin installed apps to the left rail
// (`pinnedApps`). The rail shows a pinned app only while the role may use it and
// it is installed; other ids are kept, so access or a reinstall brings them back.
import { assert } from '../core/assert';
import { record, text } from '../core/boundary';
import { toArray } from '../core/record';
import { APP_PERMISSION_LIMITS, parseAppPermissionId, type AppPermissionDeclaration } from './appPermissions';

/** The tracked project file that holds the roles. */
export const ROLES_FILE = '.stacki/roles.json';

// The bounds live beside the parser that enforces them (AGENTS.md §10), not in
// shared/core/limits.ts: no other module answers to them.
export const ROLE_LIMITS = {
  /** The whole file, in characters: 32 roles of 200 members fit with room to spare. */
  fileCharsMax: 262_144,
  /** Built-in and custom roles together. */
  rolesMax: 32,
  /** People named in one role. */
  membersMax: 200,
  /** A role id: a slug, `[a-z][a-z0-9-]*`. */
  roleIdCharsMax: 40,
  /** A role's display name. */
  roleNameCharsMax: 60,
  /** GitHub's own username limit. */
  loginCharsMax: 39,
  /** An app id inside an `app:<id>` grant. */
  appIdCharsMax: 64,
  /** Grants on one role: every static feature plus up to 200 apps. */
  accessMax: 256,
  /**
   * Apps one role stores permission values for: the 50 a project installs, with
   * room for apps since uninstalled, whose values are kept so reinstalling restores them.
   */
  appPermissionAppsMax: 64,
  /** Apps one role pins to the left rail: a short column of buttons, not a second Apps panel. */
  pinnedAppsMax: 12,
} as const satisfies Record<string, number>;

/**
 * Every part of Stacki a role can be allowed, as `area:part` ids. The groups
 * below (`ACCESS_GROUPS`) order them for the Roles tab. `settings:roles` is in
 * the union so callers can ask about it, but it is never grantable: only admin
 * edits roles.
 */
export const ACCESS_FEATURES = [
  // Left rail panels.
  'panel:pages',
  'panel:navigator',
  'panel:properties',
  'panel:components',
  'panel:assets',
  'panel:cms',
  'panel:variables',
  'panel:selectors',
  'panel:code',
  'panel:history',
  'panel:apps',
  'panel:ai',
  /** The Instructions panel: the project's Markdown for agents and people, read-only without `instructions:edit`. */
  'panel:instructions',
  /** The Audits panel: accessibility and SEO findings, and their fixes. */
  'panel:audits',
  // Right panels.
  'panel:style',
  'panel:settings',
  // Pages.
  'page:create',
  'page:delete',
  'page:rename',
  /** Edit the page layout and everything outside it; without it, edits stay inside the layout (Studio's Client mode). */
  'page:layout',
  // Components.
  'component:create',
  /** Open and edit a component's own source, its properties and its insertion defaults. */
  'component:edit',
  // Code.
  /** Raw source: the code window, frontmatter, code files and the terminal. */
  'code:edit',
  // Instructions.
  /** Create, edit and hide the project's skills, rules and docs in the Instructions panel; needs `panel:instructions`. */
  'instructions:edit',
  // Publishing.
  'publish',
  // The official app marketplace, inside the Apps panel (shared/properties/appMarketplace.ts).
  /** Browse the marketplace: the Apps panel's Marketplace tab and the palette's marketplace results. */
  'marketplace:view',
  /** Install an approved version from the marketplace; needs `marketplace:view` too. */
  'marketplace:install',
  /** Publish an app to the marketplace: make its repository public and submit it; needs `marketplace:view` too. */
  'marketplace:publish',
  /** Share an app installed from a file to GitHub, private or public, and switch it to that release; needs `panel:apps`. */
  'apps:share',
  // Settings tabs.
  'settings:editor',
  'settings:folders',
  'settings:cms',
  'settings:studio',
  'settings:instructions',
  'settings:audits',
  'settings:roles',
] as const;
export type StaticAccessFeature = (typeof ACCESS_FEATURES)[number];

/**
 * One app the Apps panel may show: `app:<appId>`. `app:*` allows every app.
 * An app also needs `panel:apps`; without the panel no app is reachable.
 */
export type AppAccessFeature = `app:${string}`;
export type AccessFeature = StaticAccessFeature | AppAccessFeature;
export const APP_ACCESS_ALL = 'app:*' satisfies AppAccessFeature;

/**
 * App permission values a role stores, by app id and then permission id. Only
 * values an admin set are stored; a missing one falls back to the manifest's
 * `default`. Ids of apps or permissions no installed manifest declares are kept,
 * so reinstalling an app restores its settings, and ignored, because resolution
 * reads only what the installed manifest declares (`appPermissionsFor`).
 */
export type AppPermissionGrants = Readonly<Record<string, Readonly<Record<string, boolean>>>>;

/** The role a caller acts as: resolved from the file, or chosen by an admin's "View as". */
export interface RoleView {
  readonly id: string;
  readonly name: string;
  readonly isAdmin: boolean;
  readonly features: ReadonlySet<AccessFeature>;
  /** The role's stored app permission values; empty for admin, which has every one. */
  readonly appPermissions: AppPermissionGrants;
  /** App ids pinned to the left rail, in the order they were pinned. The rail skips ids the role cannot use or that are not installed. */
  readonly pinnedApps: readonly string[];
}

/** Whether `role` may use `feature`. Admin is always allowed everything. */
export function can(role: RoleView, feature: AccessFeature): boolean {
  assert(role.id.length > 0, 'A role view has an id');
  assert(role.isAdmin === (role.id === ADMIN_ROLE_ID), 'Only the admin role is admin');
  if (role.isAdmin) {
    return true;
  }
  if (feature === 'settings:roles') {
    return false;
  }
  if (isAppFeature(feature)) {
    if (role.features.has('panel:apps')) {
      return role.features.has(feature) || role.features.has(APP_ACCESS_ALL);
    }
    return false;
  }
  if (feature === 'marketplace:view' || feature === 'marketplace:install' || feature === 'marketplace:publish') {
    return canMarketplace(role, feature);
  }
  if (feature === 'instructions:edit') {
    // Editing happens in the panel, so a grant without the panel gives nothing.
    return role.features.has('panel:instructions') && role.features.has(feature);
  }
  if (feature === 'apps:share') {
    // Sharing starts from an installed app, so it lives in the Apps panel like the apps themselves.
    return role.features.has('panel:apps') && role.features.has(feature);
  }
  return role.features.has(feature);
}

// The marketplace lives in the Apps panel, and installing from it means seeing it:
// a grant without its prerequisite gives nothing, so no file can grant a hidden action.
function canMarketplace(role: RoleView, feature: 'marketplace:view' | 'marketplace:install' | 'marketplace:publish'): boolean {
  assert(!role.isAdmin, 'Admin is answered before the marketplace rules');
  if (!role.features.has('panel:apps')) {
    return false;
  }
  if (!role.features.has('marketplace:view')) {
    return false;
  }
  return role.features.has(feature);
}

export const ADMIN_ROLE_ID = 'admin';
export const CLIENT_ROLE_ID = 'client';
/** Earlier names of admin: Studio's label ("Developer") and its stored value ("designer"). */
export const ADMIN_ROLE_ALIASES: readonly string[] = ['developer', 'designer'];

/** What the built-in client role may do until a project changes it: Studio's Client mode. */
export const CLIENT_DEFAULT_ACCESS: readonly StaticAccessFeature[] = [
  'panel:pages',
  'panel:navigator',
  'panel:components',
  'panel:assets',
  'panel:cms',
  'panel:history',
  'panel:settings',
  'page:create',
  'page:delete',
  'page:rename',
  'publish',
  'settings:editor',
];

/** The admin view, which every caller may start from: full access. */
export const ADMIN_VIEW: RoleView = {
  id: ADMIN_ROLE_ID,
  name: 'Admin',
  isAdmin: true,
  features: new Set(ACCESS_FEATURES),
  appPermissions: {},
  pinnedApps: [],
};

export interface ProjectRole {
  readonly id: string;
  readonly name: string;
  /** GitHub usernames as written, validated. Compare them with `sameLogin`. */
  readonly members: readonly string[];
  /** Granted features. Always empty for admin, which has everything. */
  readonly access: readonly AccessFeature[];
  /** App permission values an admin set. Always empty for admin, which has every one. */
  readonly appPermissions: AppPermissionGrants;
  /** App ids pinned to the left rail, unique, in pin order; admin may pin too. */
  readonly pinnedApps: readonly string[];
}

export interface ProjectRoles {
  readonly version: 1;
  /** The role of a signed-in Studio user named in no role. */
  readonly defaultRole: string;
  /** Admin first, then client, then custom roles in file order. */
  readonly roles: readonly ProjectRole[];
}

/** No file: today's behaviour. Everyone who can edit is admin; client is a "View as" choice. */
export const DEFAULT_PROJECT_ROLES: ProjectRoles = {
  version: 1,
  defaultRole: ADMIN_ROLE_ID,
  roles: [
    { id: ADMIN_ROLE_ID, name: 'Admin', members: [], access: [], appPermissions: {}, pinnedApps: [] },
    { id: CLIENT_ROLE_ID, name: 'Client', members: [], access: CLIENT_DEFAULT_ACCESS, appPermissions: {}, pinnedApps: [] },
  ],
};

/** The Roles tab's group that also holds the per-app grants (`app:*`, `app:<id>`): RoleCard.tsx draws them under it. */
export const APPS_ACCESS_GROUP = 'Apps';

/** The Roles tab's toggles, grouped by area. Every grantable static feature appears once. */
export const ACCESS_GROUPS: readonly {
  readonly label: string;
  readonly features: readonly { readonly feature: StaticAccessFeature; readonly label: string }[];
}[] = [
  {
    label: 'Panels',
    features: [
      { feature: 'panel:pages', label: 'Pages' },
      { feature: 'panel:navigator', label: 'Navigator' },
      { feature: 'panel:properties', label: 'Component properties' },
      { feature: 'panel:components', label: 'Components' },
      { feature: 'panel:assets', label: 'Assets' },
      { feature: 'panel:cms', label: 'CMS' },
      { feature: 'panel:variables', label: 'Variables' },
      { feature: 'panel:selectors', label: 'Style selectors' },
      { feature: 'panel:code', label: 'Code' },
      { feature: 'panel:history', label: 'Git' },
      { feature: 'panel:apps', label: 'Apps' },
      { feature: 'panel:ai', label: 'AI chat' },
      { feature: 'panel:instructions', label: 'Instructions' },
      { feature: 'panel:audits', label: 'Audits' },
      { feature: 'panel:style', label: 'Style panel' },
      { feature: 'panel:settings', label: 'Settings panel' },
    ],
  },
  {
    label: 'Pages',
    features: [
      { feature: 'page:create', label: 'Create pages' },
      { feature: 'page:delete', label: 'Delete pages' },
      { feature: 'page:rename', label: 'Rename and move pages' },
      { feature: 'page:layout', label: 'Edit the layout and outside it' },
    ],
  },
  {
    label: 'Components',
    features: [
      { feature: 'component:create', label: 'Create components' },
      { feature: 'component:edit', label: 'Edit component source' },
    ],
  },
  {
    label: 'Code and publishing',
    features: [
      { feature: 'code:edit', label: 'Edit code' },
      { feature: 'instructions:edit', label: 'Edit instructions' },
      { feature: 'publish', label: 'Publish' },
    ],
  },
  {
    label: APPS_ACCESS_GROUP,
    features: [
      { feature: 'marketplace:view', label: 'See the marketplace' },
      { feature: 'marketplace:install', label: 'Install from the marketplace' },
      { feature: 'marketplace:publish', label: 'Publish to the marketplace' },
      { feature: 'apps:share', label: 'Share apps to GitHub' },
    ],
  },
  {
    label: 'Settings',
    features: [
      { feature: 'settings:editor', label: 'Editor settings' },
      { feature: 'settings:folders', label: 'Folders' },
      { feature: 'settings:cms', label: 'CMS and media connections' },
      { feature: 'settings:studio', label: 'Stacki Studio' },
      { feature: 'settings:instructions', label: 'Hidden instructions' },
      { feature: 'settings:audits', label: 'Audit checks' },
    ],
  },
];

/** Whether a feature id names one app's grant. */
export function isAppFeature(feature: AccessFeature): feature is AppAccessFeature {
  assert(feature.length > 0, 'A feature id is never empty');
  const app = feature.startsWith('app:');
  assert(!app || feature.length > 'app:'.length, 'An app grant names an app');
  return app;
}

/** Whether two GitHub logins name the same person: GitHub usernames are case-insensitive. */
export function sameLogin(left: string, right: string): boolean {
  assert(left.length > 0, 'A login to compare is never empty');
  assert(right.length > 0, 'A login to compare is never empty');
  return left.toLowerCase() === right.toLowerCase();
}

/** A GitHub username: letters, digits and single inner hyphens, at most 39 characters. */
export function parseGitHubLogin(input: unknown): string {
  const login = text(input).trim();
  if (login.length === 0 || login.length > ROLE_LIMITS.loginCharsMax) {
    throw new Error(`A GitHub username is 1 to ${ROLE_LIMITS.loginCharsMax} characters`);
  }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9]))*$/.test(login)) {
    throw new Error(`"${login}" is not a GitHub username`);
  }
  assert(login.length <= ROLE_LIMITS.loginCharsMax, 'A parsed login is within the GitHub limit');
  return login;
}

/**
 * The start of a GitHub username, as typed into the member picker: the login rules,
 * except that it may end in the hyphen the person is about to follow with more.
 * The search sends exactly this text, so nothing else can reach GitHub.
 */
export function parseGitHubLoginQuery(input: unknown): string {
  const query = text(input).trim();
  if (query.length === 0 || query.length > ROLE_LIMITS.loginCharsMax) {
    throw new Error(`A GitHub username search is 1 to ${ROLE_LIMITS.loginCharsMax} characters`);
  }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9]|$))*$/.test(query)) {
    throw new Error(`"${query}" cannot start a GitHub username`);
  }
  assert(query.length <= ROLE_LIMITS.loginCharsMax, 'A parsed login query is within the GitHub limit');
  return query;
}

/** Parses `.stacki/roles.json` text. Throws with the reason on any bad shape. */
export function parseProjectRolesSource(source: string): ProjectRoles {
  if (source.length > ROLE_LIMITS.fileCharsMax) {
    throw new Error(`${ROLES_FILE} exceeds ${ROLE_LIMITS.fileCharsMax} characters`);
  }
  const input: unknown = JSON.parse(source);
  const roles = parseProjectRoles(input);
  assert(roles.roles.length >= 2, 'A parsed file always holds admin and client');
  return roles;
}

/**
 * Parses the roles file. Shape: `{ version: 1, defaultRole?, roles: [{ id, name?,
 * members?, access?, appPermissions?, pinnedApps? }] }`. Admin and client are always present in the result,
 * whether or not the file lists them; admin must name at least one member.
 */
export function parseProjectRoles(input: unknown): ProjectRoles {
  const value = record(input);
  if (value['version'] !== 1) {
    throw new Error('Roles file version must be 1');
  }
  const items = toArray(value['roles']);
  if (items === undefined) {
    throw new Error('Roles file needs a roles list');
  }
  if (items.length > ROLE_LIMITS.rolesMax) {
    throw new Error(`A project has at most ${ROLE_LIMITS.rolesMax} roles`);
  }
  const parsed = items.map(parseRole);
  const roles = withBuiltInRoles(parsed);
  assertUnique(roles);
  const admin = roles[0];
  assert(admin !== undefined, 'withBuiltInRoles puts admin first');
  if (admin.members.length === 0) {
    throw new Error('At least one person must be an admin');
  }
  const defaultRole = value['defaultRole'] === undefined ? ADMIN_ROLE_ID : canonicalRoleId(roleId(value['defaultRole']));
  if (!roles.some((role) => role.id === defaultRole)) {
    throw new Error(`Default role "${defaultRole}" is not a role`);
  }
  return { version: 1, defaultRole, roles };
}

/** Serializes roles for the file: stable key order, admin without access, two-space indent. */
export function serializeProjectRoles(roles: ProjectRoles): string {
  const copy: unknown = JSON.parse(JSON.stringify(roles));
  const checked = parseProjectRoles(copy);
  assert(checked.roles.length === roles.roles.length, 'Serializing never adds or drops roles');
  const body = {
    version: 1,
    defaultRole: checked.defaultRole,
    roles: checked.roles.map((role) => {
      // Written only when set, so a file without pins or app permissions reads exactly as before.
      const pinned = role.pinnedApps.length > 0 ? { pinnedApps: role.pinnedApps } : {};
      if (role.id === ADMIN_ROLE_ID) {
        return { id: role.id, name: role.name, members: role.members, ...pinned };
      }
      const stored = Object.keys(role.appPermissions).length > 0 ? { appPermissions: role.appPermissions } : {};
      return { id: role.id, name: role.name, members: role.members, access: role.access, ...stored, ...pinned };
    }),
  };
  const source = `${JSON.stringify(body, undefined, 2)}\n`;
  // Each part is bounded, but not every part at its bound fits the file: too big is the edit's failure, not a bug.
  if (source.length > ROLE_LIMITS.fileCharsMax) {
    throw new Error(`The roles file would exceed ${ROLE_LIMITS.fileCharsMax} characters`);
  }
  assert(source.length > 0, 'A serialized roles file is never empty');
  return source;
}

/** The view for one role of the file. Throws for an id the file does not hold. */
export function roleViewOf(roles: ProjectRoles, id: string): RoleView {
  const role = roles.roles.find((item) => item.id === canonicalRoleId(id));
  if (role === undefined) {
    throw new Error(`"${id}" is not a role in this project`);
  }
  return roleView(role);
}

/** The view of one role as given, such as a role the Roles tab is editing before it is saved. */
export function roleView(role: ProjectRole): RoleView {
  if (role.id === ADMIN_ROLE_ID) {
    // Admin's access is fixed; only its pins are its own.
    return role.pinnedApps.length === 0 ? ADMIN_VIEW : { ...ADMIN_VIEW, pinnedApps: role.pinnedApps };
  }
  const view: RoleView = {
    id: role.id,
    name: role.name,
    isAdmin: false,
    features: new Set(role.access),
    appPermissions: role.appPermissions,
    pinnedApps: role.pinnedApps,
  };
  assert(!view.features.has('settings:roles'), 'No role but admin edits roles');
  assert(!view.isAdmin, 'Only the admin role is admin');
  return view;
}

/**
 * Every permission `declarations` names, resolved for `role` in app `appId`:
 * admin has every one; a role that may not use the app has none; any other role
 * has the value its admin stored, else the declaration's default. Stored ids the
 * declarations do not name are ignored.
 */
export function appPermissionsFor(role: RoleView, appId: string, declarations: readonly AppPermissionDeclaration[]): Readonly<Record<string, boolean>> {
  assert(appId.length > 0, 'App permissions belong to an app');
  assert(declarations.length <= APP_PERMISSION_LIMITS.permissionsMax, 'Permission declarations are bounded');
  const usable = can(role, `app:${appId}`);
  const resolved: Record<string, boolean> = {};
  for (const declaration of declarations) {
    if (role.isAdmin) {
      resolved[declaration.id] = true;
    } else if (usable) {
      resolved[declaration.id] = configuredAppPermission(role.appPermissions, appId, declaration);
    } else {
      resolved[declaration.id] = false;
    }
  }
  assert(Object.keys(resolved).length === declarations.length, 'Every declared permission resolves');
  return resolved;
}

/** The value a role's admin chose for one permission, else its default: what applies while the role may use the app. */
export function configuredAppPermission(grants: AppPermissionGrants, appId: string, declaration: AppPermissionDeclaration): boolean {
  assert(appId.length > 0, 'A permission belongs to an app');
  assert(declaration.id.length > 0, 'A permission has an id');
  // Own properties only: a permission id such as "constructor" must never read the prototype's.
  const app = Object.hasOwn(grants, appId) ? grants[appId] : undefined;
  if (app === undefined) {
    return declaration.default;
  }
  const stored = Object.hasOwn(app, declaration.id) ? app[declaration.id] : undefined;
  return stored ?? declaration.default;
}

/** Whether two roles store the same app permission values, whatever their key order. */
export function sameAppPermissions(left: AppPermissionGrants, right: AppPermissionGrants): boolean {
  const apps = Object.keys(left);
  assert(apps.length <= ROLE_LIMITS.appPermissionAppsMax, 'Stored apps are bounded');
  if (apps.length !== Object.keys(right).length) {
    return false;
  }
  return apps.every((appId) => {
    const leftValues = left[appId] ?? {};
    const rightValues = Object.hasOwn(right, appId) ? right[appId] : undefined;
    if (rightValues === undefined) {
      return false;
    }
    const ids = Object.keys(leftValues);
    return ids.length === Object.keys(rightValues).length && ids.every((id) => Object.hasOwn(rightValues, id) && rightValues[id] === leftValues[id]);
  });
}

/** The role, if any, that names `login` as a member. */
export function memberRole(roles: ProjectRoles, login: string): ProjectRole | undefined {
  assert(login.length > 0, 'A member lookup names a login');
  const found = roles.roles.find((role) => role.members.some((member) => sameLogin(member, login)));
  assert(found === undefined || found.members.length > 0, 'A matching role has members');
  return found;
}

/**
 * Who someone is in a project. `fallback` decides people named in no role:
 * `'default'` (Studio) gives them the file's default role; `'admin'` (Desktop,
 * where the local user owns the files) keeps them admin. No file, or no
 * signed-in login, is always admin: today's behaviour exactly.
 */
export function resolveRole(roles: ProjectRoles | undefined, login: string | undefined, fallback: 'default' | 'admin'): RoleView {
  if (roles === undefined) {
    return ADMIN_VIEW;
  }
  if (login === undefined) {
    // The file's admin role, not the bare admin view, so admin's rail pins apply.
    return roleViewOf(roles, ADMIN_ROLE_ID);
  }
  const member = memberRole(roles, login);
  if (member !== undefined) {
    return roleViewOf(roles, member.id);
  }
  switch (fallback) {
    case 'admin':
      return roleViewOf(roles, ADMIN_ROLE_ID);
    case 'default':
      return roleViewOf(roles, roles.defaultRole);
    default: {
      const exhaustive: never = fallback;
      return exhaustive;
    }
  }
}

/** A role id as stored, with the old admin names read as admin. */
export function canonicalRoleId(id: string): string {
  assert(id.length > 0, 'A role id is never empty');
  const canonical = ADMIN_ROLE_ALIASES.includes(id) ? ADMIN_ROLE_ID : id;
  assert(canonical.length <= ROLE_LIMITS.roleIdCharsMax, 'A canonical role id is within the id bound');
  return canonical;
}

/** A role id slug for a new custom role named `name`, unique among `taken`. */
export function roleIdFor(name: string, taken: readonly string[]): string {
  assert(taken.length <= ROLE_LIMITS.rolesMax, 'Taken ids are bounded by the role limit');
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^[^a-z]+|-+$/g, '')
      .slice(0, ROLE_LIMITS.roleIdCharsMax - 3) || 'role';
  let id = base;
  for (let suffix = 2; suffix <= ROLE_LIMITS.rolesMax + 2; suffix += 1) {
    if (!taken.includes(id) && !reservedRoleId(id)) {
      break;
    }
    id = `${base}-${suffix}`;
  }
  assert(!taken.includes(id), 'A generated role id is unique');
  return id;
}

function reservedRoleId(id: string): boolean {
  assert(id.length > 0, 'A role id is never empty');
  const reserved = id === ADMIN_ROLE_ID || id === CLIENT_ROLE_ID || ADMIN_ROLE_ALIASES.includes(id);
  assert(typeof reserved === 'boolean', 'Reserved is a plain answer');
  return reserved;
}

function parseRole(input: unknown): ProjectRole {
  const value = record(input);
  const id = canonicalRoleId(roleId(value['id']));
  const name = value['name'] === undefined ? builtInName(id) : roleName(value['name']);
  const members = parseMembers(value['members']);
  const pinnedApps = parsePinnedApps(value['pinnedApps']);
  if (id === ADMIN_ROLE_ID) {
    // Admin has everything: an access list or app permissions on it are ignored, never a restriction.
    return { id, name: 'Admin', members, access: [], appPermissions: {}, pinnedApps };
  }
  const access = value['access'] === undefined && id === CLIENT_ROLE_ID ? CLIENT_DEFAULT_ACCESS : parseAccess(value['access']);
  assert(!access.includes('settings:roles'), 'parseAccess refuses the roles tab');
  // Client's name is the project's to choose, like a custom role's; only its
  // id (`client`) carries meaning to grants, the default role and the servers.
  return { id, name, members, access, appPermissions: parseAppPermissionGrants(value['appPermissions']), pinnedApps };
}

/** `pinnedApps: ["<appId>", …]`: app ids, at most `pinnedAppsMax`, read once each. Absent is none. */
export function parsePinnedApps(input: unknown): readonly string[] {
  if (input === undefined) {
    return [];
  }
  const items = toArray(input);
  if (items === undefined) {
    throw new Error('Pinned apps must be a list of app ids');
  }
  if (items.length > ROLE_LIMITS.pinnedAppsMax) {
    throw new Error(`A role pins at most ${ROLE_LIMITS.pinnedAppsMax} apps`);
  }
  // A repeated id is read once, as `access` is: the first place it was pinned wins.
  const pinned = [...new Set(items.map(parseAppGrantId))];
  assert(pinned.length <= items.length, 'Deduplication never adds pins');
  return pinned;
}

/** `appPermissions: { "<appId>": { "<permissionId>": true | false } }`, bounded by app and by permission. Absent is none. */
export function parseAppPermissionGrants(input: unknown): AppPermissionGrants {
  if (input === undefined) {
    return {};
  }
  const apps = Object.entries(record(input));
  if (apps.length > ROLE_LIMITS.appPermissionAppsMax) {
    throw new Error(`A role holds app permissions for at most ${ROLE_LIMITS.appPermissionAppsMax} apps`);
  }
  const grants: Record<string, Readonly<Record<string, boolean>>> = {};
  for (const [appId, values] of apps) {
    const permissions = Object.entries(record(values));
    if (permissions.length > APP_PERMISSION_LIMITS.permissionsMax) {
      throw new Error(`A role holds at most ${APP_PERMISSION_LIMITS.permissionsMax} permissions for one app`);
    }
    const parsed: Record<string, boolean> = {};
    for (const [permissionId, value] of permissions) {
      if (typeof value !== 'boolean') {
        throw new Error(`App permission "${parseAppPermissionId(permissionId)}" is true or false`);
      }
      parsed[parseAppPermissionId(permissionId)] = value;
    }
    grants[parseAppGrantId(appId)] = parsed;
  }
  assert(Object.keys(grants).length === apps.length, 'Every stored app parsed');
  return grants;
}

/** An app id as roles name it (`app:<id>` and `appPermissions`): the manifest's id rule. */
export function parseAppGrantId(input: unknown): string {
  const app = text(input);
  if (app.length === 0 || app.length > ROLE_LIMITS.appIdCharsMax) {
    throw new Error(`An app id is 1 to ${ROLE_LIMITS.appIdCharsMax} characters`);
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(app)) {
    throw new Error(`"${app}" is not an app id`);
  }
  assert(app.length <= ROLE_LIMITS.appIdCharsMax, 'A parsed app id is within its bound');
  return app;
}

function builtInName(id: string): string {
  assert(id.length > 0, 'A role id is never empty');
  if (id === CLIENT_ROLE_ID) {
    return 'Client';
  }
  if (id === ADMIN_ROLE_ID) {
    return 'Admin';
  }
  throw new Error(`Role "${id}" needs a name`);
}

function roleId(input: unknown): string {
  const id = text(input);
  if (id.length === 0 || id.length > ROLE_LIMITS.roleIdCharsMax) {
    throw new Error(`A role id is 1 to ${ROLE_LIMITS.roleIdCharsMax} characters`);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    throw new Error(`Role id "${id}" must be lowercase letters, digits and hyphens`);
  }
  return id;
}

function roleName(input: unknown): string {
  const name = text(input).trim();
  if (name.length === 0 || name.length > ROLE_LIMITS.roleNameCharsMax) {
    throw new Error(`A role name is 1 to ${ROLE_LIMITS.roleNameCharsMax} characters`);
  }
  assert(name === name.trim(), 'A role name carries no outer spaces');
  return name;
}

function parseMembers(input: unknown): readonly string[] {
  if (input === undefined) {
    return [];
  }
  const items = toArray(input);
  if (items === undefined) {
    throw new Error('Role members must be a list of GitHub usernames');
  }
  if (items.length > ROLE_LIMITS.membersMax) {
    throw new Error(`A role has at most ${ROLE_LIMITS.membersMax} members`);
  }
  const members = items.map(parseGitHubLogin);
  assert(members.length === items.length, 'Every member parsed');
  return members;
}

function parseAccess(input: unknown): readonly AccessFeature[] {
  if (input === undefined) {
    return [];
  }
  const items = toArray(input);
  if (items === undefined) {
    throw new Error('Role access must be a list of features');
  }
  if (items.length > ROLE_LIMITS.accessMax) {
    throw new Error(`A role has at most ${ROLE_LIMITS.accessMax} grants`);
  }
  const access = [...new Set(items.map(parseFeature))];
  assert(access.length <= items.length, 'Deduplication never adds grants');
  return access;
}

function parseFeature(input: unknown): AccessFeature {
  const feature = text(input);
  if (feature === 'settings:roles') {
    throw new Error('Only admin can edit roles');
  }
  const known = ACCESS_FEATURES.find((item) => item === feature);
  if (known !== undefined) {
    return known;
  }
  if (feature.startsWith('app:')) {
    const app = feature.slice('app:'.length);
    if (app.length === 0 || app.length > ROLE_LIMITS.appIdCharsMax) {
      throw new Error(`An app id is 1 to ${ROLE_LIMITS.appIdCharsMax} characters`);
    }
    if (app !== '*' && !/^[a-z0-9][a-z0-9._-]*$/.test(app)) {
      throw new Error(`"${feature}" is not an app grant`);
    }
    return `app:${app}`;
  }
  throw new Error(`Unknown access feature "${feature}"`);
}

function withBuiltInRoles(parsed: readonly ProjectRole[]): readonly ProjectRole[] {
  const admin = parsed.find((role) => role.id === ADMIN_ROLE_ID) ?? {
    id: ADMIN_ROLE_ID,
    name: 'Admin',
    members: [],
    access: [],
    appPermissions: {},
    pinnedApps: [],
  };
  const client = parsed.find((role) => role.id === CLIENT_ROLE_ID) ?? {
    id: CLIENT_ROLE_ID,
    name: 'Client',
    members: [],
    access: CLIENT_DEFAULT_ACCESS,
    appPermissions: {},
    pinnedApps: [],
  };
  const custom = parsed.filter((role) => role.id !== ADMIN_ROLE_ID && role.id !== CLIENT_ROLE_ID);
  for (const id of [ADMIN_ROLE_ID, CLIENT_ROLE_ID]) {
    if (parsed.filter((role) => role.id === id).length > 1) {
      throw new Error(`Role "${id}" is listed twice`);
    }
  }
  const roles = [admin, client, ...custom];
  if (roles.length > ROLE_LIMITS.rolesMax) {
    throw new Error(`A project has at most ${ROLE_LIMITS.rolesMax} roles`);
  }
  assert(roles[0]?.id === ADMIN_ROLE_ID, 'Admin is first');
  assert(roles[1]?.id === CLIENT_ROLE_ID, 'Client is second');
  return roles;
}

function assertUnique(roles: readonly ProjectRole[]): void {
  assert(roles.length <= ROLE_LIMITS.rolesMax, 'Roles are bounded before the uniqueness check');
  const ids = new Set<string>();
  const logins = new Map<string, string>();
  for (const role of roles) {
    if (ids.has(role.id)) {
      throw new Error(`Role "${role.id}" is listed twice`);
    }
    ids.add(role.id);
    for (const member of role.members) {
      const key = member.toLowerCase();
      const other = logins.get(key);
      if (other !== undefined) {
        throw new Error(other === role.id ? `${member} is listed twice in ${role.name}` : `${member} is in more than one role`);
      }
      logins.set(key, role.id);
    }
  }
  assert(ids.size === roles.length, 'Every role id is unique');
}
