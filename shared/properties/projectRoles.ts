// i18n-ignore-file: the English labels and the built-in role names are the source text beside each labelRef; the renderer translates by reference.
// Project roles: who may use which parts of Stacki in one project, shared by
// Desktop and Studio through `.stacki/roles.json`. This module is the contract:
// the access features, the bounded file parser, how a GitHub login resolves to
// a role, and `can()`, the one question every caller asks. The Apps platform
// imports `AccessFeature`, `RoleView` and `can` from here, so their shapes are
// fixed (docs/contracts.md, "Project roles").
//
// Admin can never be restricted: `can(admin, anything)` is true, admin's access
// list is not stored, and the parser refuses a file in which another role names a
// member while admin names none, so no save can lock the project's owners out.
// "developer" (and Studio's internal "designer") is the old name of admin and
// still reads as admin.
//
// A file in which no role names anyone is "unclaimed" (`rolesClaimed`): a
// framework can ship its role definitions without naming a real person to every
// user. Its roles, default role, pins and component rules load and are kept, but
// access is exactly that of a project with no file (`resolveRole`) until an admin
// is added.
//
// Each role may also hold the switches installed apps declare (`appPermissions`,
// shared/properties/appPermissions.ts). Stacki stores and resolves them
// (`appPermissionsFor`); the app enforces them in its own features.
//
// Each role, admin included, may pin installed apps to the left rail
// (`pinnedApps`). The rail shows a pinned app only while the role may use it and
// it is installed; other ids are kept, so access or a reinstall brings them back.
//
// Each role, admin included, may hide components from its insert surfaces
// (`componentRules`, shared/properties/componentAccess.ts): a deny-list of component
// and folder paths, so every component is enabled for every role until a rule says
// otherwise. These rules narrow what a role may ADD from the palette and never what
// it may open, so admin keeps its access to Settings however its components are hidden.
//
// Each role but admin may switch editing options off (`editorOff`, at the end of
// this file): the whole right panel, the canvas bar, and what can be done on the
// page. `can()` withholds every permission that would reach a switched-off
// option another way.
import { assert } from '../core/assert';
import { record, text } from '../core/boundary';
import { toArray } from '../core/record';
import { APP_PERMISSION_LIMITS, parseAppPermissionId, type AppPermissionDeclaration } from './appPermissions';
import { parseComponentRules, storedComponentRule, type ComponentRule } from './componentAccess';
import { DescribedError } from './describedError';
import { identityKey, parseQualifiedIdentity, GITHUB_PROVIDER_ID, identityProvider, identitySubject } from './memberIdentity';
import { described, messageRef, type Described, type TypedMessageRef } from './i18n/messageRef';

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
  /** Further identities one signed-in person may carry (an authentication provider's aliases). */
  aliasesMax: 8,
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
 * below (`ACCESS_GROUPS`) order them for the Roles tab. `settings:roles` and
 * `cli:roles` are in the union so callers can ask about them, but they are never
 * grantable: only admin edits roles, by any route.
 */
export const ACCESS_FEATURES = [
  // Left rail panels.
  /** The Add elements panel: its rail button, its `A` shortcut and its drag-insert. Roles files that predate it get it by default, see `can`. */
  'panel:elements',
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
  /** The Instructions sections of the Settings panel (once their own panel): the project's Markdown for agents and people, read-only without `instructions:edit`. */
  'panel:instructions',
  /** The Audits panel: accessibility and SEO findings, and their fixes. */
  'panel:audits',
  /** The Settings panel's Secrets (`.env`) and MCP servers sections, at the rail's foot. Admin only until a role is given it. */
  'panel:projectSettings',
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
  /** Create, edit and hide the project's skills, rules and docs in the Settings panel's Instructions sections; needs `panel:instructions`. */
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
  'settings:breakpoints',
  'settings:roles',
  // The `stacki` command line and its MCP server (shared/properties/cli/stackiFeatures.ts).
  /** Every read-only command: list, schema, doctor, config get. Granted to every role by default. */
  'cli:read',
  /** Generic config set, unset, add and remove on the settings files that are not roles. */
  'cli:config',
  /** Column guide edits (`.stacki/guide.json`). */
  'cli:guides',
  /** Breakpoint edits. */
  'cli:breakpoints',
  /** Folder edits. */
  'cli:folders',
  /** Rename, move, duplicate and delete components, and their insertion defaults. */
  'cli:components',
  /** Add and remove apps, change app settings and run the app commands the role is granted. */
  'cli:apps',
  /** Edit roles, enable apps' commands and trust apps through the command line. Never grantable, like `settings:roles`. */
  'cli:roles',
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
  /** Components hidden from, or re-shown to, this role's insert surfaces; admin's too. Empty shows every component. */
  readonly componentRules: readonly ComponentRule[];
  /** The editing options switched off, as they apply (projectRoles.ts `effectiveEditorOff`); empty for admin. */
  readonly editorOff: ReadonlySet<EditorPart>;
}

/** Whether `role` may use `feature`. Admin is always allowed everything. */
export function can(role: RoleView, feature: AccessFeature): boolean {
  assert(role.id.length > 0, 'A role view has an id');
  assert(role.isAdmin === (role.id === ADMIN_ROLE_ID), 'Only the admin role is admin');
  if (role.isAdmin) {
    return true;
  }
  if (feature === 'settings:roles' || feature === 'cli:roles') {
    return false;
  }
  if (editorWithholds(role.editorOff, feature)) {
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
  if (feature === 'panel:elements') {
    return canElements(role);
  }
  return role.features.has(feature);
}

/**
 * The default-grant rule of `panel:elements`. The Add elements panel was open to every role
 * that could edit before it had a permission, so a roles file written then has no grant for
 * it. Such a file must keep working: a role that holds a design panel, `panel:navigator`, or
 * any page edit permission (`page:create`, `page:delete`, `page:rename`, `page:layout`)
 * has the panel without naming it, and a role with none of those does not.
 * Limit: a role that holds one of those therefore cannot be denied the panel on its own;
 * withdraw the design panel to take it away.
 */
function canElements(role: RoleView): boolean {
  assert(!role.isAdmin, 'Admin is answered before the Elements rule');
  if (role.features.has('panel:elements')) {
    return true;
  }
  if (role.features.has('panel:navigator')) {
    return true;
  }
  return PAGE_EDIT_FEATURES.some((feature) => role.features.has(feature));
}

/** The page permissions that mean a role edits pages, and so gets Add elements by default. */
const PAGE_EDIT_FEATURES = ['page:create', 'page:delete', 'page:rename', 'page:layout'] as const satisfies readonly StaticAccessFeature[];

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
  'panel:elements',
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
  // Reading through the command line is as harmless as reading in the editor.
  'cli:read',
];

/** The admin view, which every caller may start from: full access. */
export const ADMIN_VIEW: RoleView = {
  id: ADMIN_ROLE_ID,
  name: 'Admin',
  isAdmin: true,
  features: new Set(ACCESS_FEATURES),
  appPermissions: {},
  pinnedApps: [],
  componentRules: [],
  editorOff: new Set(),
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
  /** Hidden and re-shown components, as the file stores them; admin may have rules too. */
  readonly componentRules: readonly ComponentRule[];
  /** Editing options switched off, as the file stores them. Always empty for admin, which has every one. */
  readonly editorOff: readonly EditorPart[];
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
    { id: ADMIN_ROLE_ID, name: 'Admin', members: [], access: [], appPermissions: {}, pinnedApps: [], componentRules: [], editorOff: [] },
    {
      id: CLIENT_ROLE_ID,
      name: 'Client',
      members: [],
      access: CLIENT_DEFAULT_ACCESS,
      appPermissions: {},
      pinnedApps: [],
      componentRules: [],
      editorOff: [],
    },
  ],
};

/** The Permissions view's two panel groups. The right panel's group switch is the `sidePanel` option, not a bulk grant. */
export const RIGHT_PANEL_ACCESS_GROUP = 'Right panel';
export const LEFT_PANEL_ACCESS_GROUP = 'Left panel';

/** The Roles tab's group that also holds the per-app grants (`app:*`, `app:<id>`): RoleCard.tsx draws them under it. */
export const APPS_ACCESS_GROUP = 'Apps';

/** The Roles tab's toggles, grouped by area. Every grantable static feature appears once. */
export const ACCESS_GROUPS: readonly {
  readonly label: string;
  /** The same words as a reference the renderer translates (docs/i18n-playbook.md section 7); `label` stays the English and the group's identity. */
  readonly labelRef: TypedMessageRef;
  readonly features: readonly { readonly feature: StaticAccessFeature; readonly label: string; readonly labelRef: TypedMessageRef }[];
}[] = [
  {
    label: RIGHT_PANEL_ACCESS_GROUP,
    labelRef: messageRef('roles.group.rightPanel'),
    features: [
      { feature: 'panel:style', label: 'Style panel', labelRef: messageRef('roles.feature.panelStyle') },
      { feature: 'panel:settings', label: 'Settings panel', labelRef: messageRef('roles.feature.panelSettings') },
    ],
  },
  {
    label: LEFT_PANEL_ACCESS_GROUP,
    labelRef: messageRef('roles.group.leftPanel'),
    features: [
      { feature: 'panel:elements', label: 'Add elements', labelRef: messageRef('roles.feature.panelElements') },
      { feature: 'panel:pages', label: 'Pages', labelRef: messageRef('roles.feature.panelPages') },
      { feature: 'panel:navigator', label: 'Navigator', labelRef: messageRef('roles.feature.panelNavigator') },
      { feature: 'panel:properties', label: 'Component properties', labelRef: messageRef('roles.feature.panelProperties') },
      { feature: 'panel:components', label: 'Components', labelRef: messageRef('roles.feature.panelComponents') },
      { feature: 'panel:assets', label: 'Assets', labelRef: messageRef('roles.feature.panelAssets') },
      { feature: 'panel:cms', label: 'CMS', labelRef: messageRef('roles.feature.panelCms') },
      { feature: 'panel:variables', label: 'Variables', labelRef: messageRef('roles.feature.panelVariables') },
      { feature: 'panel:selectors', label: 'Style selectors', labelRef: messageRef('roles.feature.panelSelectors') },
      { feature: 'panel:code', label: 'Code', labelRef: messageRef('roles.feature.panelCode') },
      { feature: 'panel:history', label: 'Git', labelRef: messageRef('roles.feature.panelHistory') },
      { feature: 'panel:apps', label: 'Apps', labelRef: messageRef('roles.feature.panelApps') },
      { feature: 'panel:ai', label: 'AI chat', labelRef: messageRef('roles.feature.panelAi') },
      { feature: 'panel:instructions', label: 'Instructions (in Settings)', labelRef: messageRef('roles.feature.panelInstructions') },
      { feature: 'panel:audits', label: 'Audits', labelRef: messageRef('roles.feature.panelAudits') },
      { feature: 'panel:projectSettings', label: 'Project settings (secrets, MCP servers)', labelRef: messageRef('roles.feature.panelProjectSettings') },
    ],
  },
  {
    label: 'Pages',
    labelRef: messageRef('roles.group.pages'),
    features: [
      { feature: 'page:create', label: 'Create pages', labelRef: messageRef('roles.feature.pageCreate') },
      { feature: 'page:delete', label: 'Delete pages', labelRef: messageRef('roles.feature.pageDelete') },
      { feature: 'page:rename', label: 'Rename and move pages', labelRef: messageRef('roles.feature.pageRename') },
      { feature: 'page:layout', label: 'Edit the layout and outside it', labelRef: messageRef('roles.feature.pageLayout') },
    ],
  },
  {
    label: 'Components',
    labelRef: messageRef('roles.group.components'),
    features: [
      { feature: 'component:create', label: 'Create components', labelRef: messageRef('roles.feature.componentCreate') },
      { feature: 'component:edit', label: 'Edit component source', labelRef: messageRef('roles.feature.componentEdit') },
    ],
  },
  {
    label: 'Code and publishing',
    labelRef: messageRef('roles.group.codeAndPublishing'),
    features: [
      { feature: 'code:edit', label: 'Edit code', labelRef: messageRef('roles.feature.codeEdit') },
      { feature: 'instructions:edit', label: 'Edit instructions', labelRef: messageRef('roles.feature.instructionsEdit') },
      { feature: 'publish', label: 'Publish', labelRef: messageRef('roles.feature.publish') },
    ],
  },
  {
    label: APPS_ACCESS_GROUP,
    labelRef: messageRef('roles.group.apps'),
    features: [
      { feature: 'marketplace:view', label: 'See the marketplace', labelRef: messageRef('roles.feature.marketplaceView') },
      { feature: 'marketplace:install', label: 'Install from the marketplace', labelRef: messageRef('roles.feature.marketplaceInstall') },
      { feature: 'marketplace:publish', label: 'Publish to the marketplace', labelRef: messageRef('roles.feature.marketplacePublish') },
      { feature: 'apps:share', label: 'Share apps to GitHub', labelRef: messageRef('roles.feature.appsShare') },
    ],
  },
  {
    label: 'Settings',
    labelRef: messageRef('roles.group.settings'),
    features: [
      { feature: 'settings:editor', label: 'Editor settings', labelRef: messageRef('roles.feature.settingsEditor') },
      { feature: 'settings:folders', label: 'Folders', labelRef: messageRef('roles.feature.settingsFolders') },
      { feature: 'settings:cms', label: 'CMS and media connections', labelRef: messageRef('roles.feature.settingsCms') },
      { feature: 'settings:studio', label: 'Stacki Studio', labelRef: messageRef('roles.feature.settingsStudio') },
      { feature: 'settings:instructions', label: 'Hidden instructions', labelRef: messageRef('roles.feature.settingsInstructions') },
      { feature: 'settings:audits', label: 'Audit checks', labelRef: messageRef('roles.feature.settingsAudits') },
      { feature: 'settings:breakpoints', label: 'Breakpoints', labelRef: messageRef('roles.feature.settingsBreakpoints') },
    ],
  },
  {
    label: 'Command line',
    labelRef: messageRef('roles.group.cli'),
    features: [
      { feature: 'cli:read', label: 'Read settings', labelRef: messageRef('roles.feature.cliRead') },
      { feature: 'cli:config', label: 'Change settings files', labelRef: messageRef('roles.feature.cliConfig') },
      { feature: 'cli:guides', label: 'Edit column guides', labelRef: messageRef('roles.feature.cliGuides') },
      { feature: 'cli:breakpoints', label: 'Edit breakpoints', labelRef: messageRef('roles.feature.cliBreakpoints') },
      { feature: 'cli:folders', label: 'Edit folders', labelRef: messageRef('roles.feature.cliFolders') },
      { feature: 'cli:components', label: 'Manage components', labelRef: messageRef('roles.feature.cliComponents') },
      { feature: 'cli:apps', label: 'Manage apps', labelRef: messageRef('roles.feature.cliApps') },
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
    throw new DescribedError(described('roles.error.loginLength', { max: ROLE_LIMITS.loginCharsMax }));
  }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9]))*$/.test(login)) {
    throw new DescribedError(described('roles.error.loginInvalid', { login }));
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
 * members?, access?, appPermissions?, pinnedApps?, componentRules?, editorOff? }] }`. Admin and client are always present in the result,
 * whether or not the file lists them. Admin must name a member as soon as any
 * other role does; a file that names nobody at all is unclaimed (`rolesClaimed`).
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
  const refusal = adminMembershipRefusal(roles);
  if (refusal !== undefined) {
    throw new DescribedError(refusal);
  }
  const defaultRole = value['defaultRole'] === undefined ? ADMIN_ROLE_ID : canonicalRoleId(roleId(value['defaultRole']));
  if (!roles.some((role) => role.id === defaultRole)) {
    throw new Error(`Default role "${defaultRole}" is not a role`);
  }
  return { version: 1, defaultRole, roles };
}

/**
 * Whether any role names a member. An unclaimed file (no member in any role, admin
 * included) grants access exactly as no file does: everyone who may edit is admin,
 * and the default role restricts nobody (`resolveRole`). Studio's sign-in policy
 * keeps its bootstrap admin while a file is unclaimed, as while there is none.
 */
export function rolesClaimed(roles: ProjectRoles): boolean {
  assert(roles.roles.length >= 2, 'Roles always hold admin and client');
  const claimed = roles.roles.some((role) => role.members.length > 0);
  const admin = roles.roles.find((role) => role.id === ADMIN_ROLE_ID);
  assert(admin !== undefined, 'Roles always hold admin');
  // The parser's rule, checked again on the consumer's side: a claimed file always names an admin.
  assert(!claimed || admin.members.length > 0, 'A claimed roles file names an admin');
  return claimed;
}

/**
 * Why these roles cannot be stored as members go, or undefined when they can: admin may
 * be empty only while every role is (unclaimed). A member in another role with no admin
 * would leave nobody able to edit roles, or hand the project to whoever the default role
 * and Studio's sign-in policy admit.
 */
export function adminMembershipRefusal(roles: readonly ProjectRole[]): Described | undefined {
  assert(roles.length <= ROLE_LIMITS.rolesMax, 'Roles are bounded');
  const admin = roles.find((role) => role.id === ADMIN_ROLE_ID);
  assert(admin !== undefined, 'Roles always hold admin');
  if (admin.members.length > 0) {
    return undefined;
  }
  if (roles.some((role) => role.members.length > 0)) {
    return described('roles.error.adminFirst');
  }
  return undefined;
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
      const components = role.componentRules.length > 0 ? { componentRules: role.componentRules.map(storedComponentRule) } : {};
      if (role.id === ADMIN_ROLE_ID) {
        return { id: role.id, name: role.name, members: role.members, ...pinned, ...components };
      }
      const stored = Object.keys(role.appPermissions).length > 0 ? { appPermissions: role.appPermissions } : {};
      const editor = role.editorOff.length > 0 ? { editorOff: role.editorOff } : {};
      return { id: role.id, name: role.name, members: role.members, access: role.access, ...stored, ...pinned, ...components, ...editor };
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
    // Admin's access is fixed, but its pins and hidden components are its own.
    return role.pinnedApps.length === 0 && role.componentRules.length === 0
      ? ADMIN_VIEW
      : { ...ADMIN_VIEW, pinnedApps: role.pinnedApps, componentRules: role.componentRules };
  }
  const view: RoleView = {
    id: role.id,
    name: role.name,
    isAdmin: false,
    features: new Set(role.access),
    appPermissions: role.appPermissions,
    pinnedApps: role.pinnedApps,
    componentRules: role.componentRules,
    editorOff: effectiveEditorOff(editorOffOf(role)),
  };
  assert(!view.features.has('settings:roles'), 'No role but admin edits roles');
  assert(!view.features.has('cli:roles'), 'No role but admin edits roles from the command line');
  assert(!view.isAdmin, 'Only the admin role is admin');
  return view;
}

/**
 * The options a role stores, plus one its permissions settle: a role with neither
 * right panel permission never changed pictures, so once dragging and text are off
 * too it is read only. Nothing is added to a role that switched neither off.
 */
function editorOffOf(role: ProjectRole): readonly EditorPart[] {
  const rightPanel = role.access.includes('panel:style') || role.access.includes('panel:settings');
  const settled = !rightPanel && role.editorOff.includes('drag') && role.editorOff.includes('text');
  return settled ? [...role.editorOff, 'images'] : role.editorOff;
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

/**
 * The role, if any, that names `login` as a member. `login` is a bare GitHub login or a qualified identity
 * (`email:a@b.com`); a member written as a bare login means `github:<login>` (memberIdentity.ts).
 * `aliases` are further identities of the same person, supplied by the signed-in provider and already
 * checked by Studio to belong to that provider's own namespace.
 */
export function memberRole(roles: ProjectRoles, login: string, aliases: readonly string[] = []): ProjectRole | undefined {
  assert(login.length > 0, 'A member lookup names a login');
  assert(aliases.length <= ROLE_LIMITS.aliasesMax, 'A person has a bounded number of aliases');
  const keys = [login, ...aliases].map(identityKey);
  const found = roles.roles.find((role) => role.members.some((member) => keys.includes(identityKey(member))));
  assert(found === undefined || found.members.length > 0, 'A matching role has members');
  return found;
}

/**
 * Who someone is in a project. `fallback` decides people named in no role:
 * `'default'` (Studio) gives them the file's default role; `'admin'` (Desktop,
 * where the local user owns the files) keeps them admin. No file, an unclaimed
 * file (`rolesClaimed`), or no signed-in login, is always admin: today's
 * behaviour exactly. The file's admin role is used, so its pins still apply.
 */
export function resolveRole(
  roles: ProjectRoles | undefined,
  login: string | undefined,
  fallback: 'default' | 'admin',
  aliases: readonly string[] = [],
): RoleView {
  if (roles === undefined) {
    return ADMIN_VIEW;
  }
  if (login === undefined) {
    // The file's admin role, not the bare admin view, so admin's rail pins apply.
    return roleViewOf(roles, ADMIN_ROLE_ID);
  }
  if (!rolesClaimed(roles)) {
    // Unclaimed: as with no file, the default role restricts nobody until an admin is named.
    return roleViewOf(roles, ADMIN_ROLE_ID);
  }
  const member = memberRole(roles, login, aliases);
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
  const componentRules = parseComponentRules(value['componentRules']);
  if (id === ADMIN_ROLE_ID) {
    // Admin has everything: an access list or app permissions on it are ignored, never a restriction.
    // Hidden components are not access: they only narrow the insert palette, so admin keeps them.
    return { id, name: 'Admin', members, access: [], appPermissions: {}, pinnedApps, componentRules, editorOff: [] };
  }
  const access = value['access'] === undefined && id === CLIENT_ROLE_ID ? CLIENT_DEFAULT_ACCESS : parseAccess(value['access']);
  assert(!access.includes('settings:roles'), 'parseAccess refuses the roles tab');
  assert(!access.includes('cli:roles'), 'parseAccess refuses the command line roles edit');
  // Client's name is the project's to choose, like a custom role's; only its
  // id (`client`) carries meaning to grants, the default role and the servers.
  const appPermissions = parseAppPermissionGrants(value['appPermissions']);
  return { id, name, members, access, appPermissions, pinnedApps, componentRules, editorOff: parseEditorOff(value['editorOff']) };
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

/**
 * One member: a bare GitHub login (the original form, meaning `github:<login>`) or a qualified identity
 * from another authentication provider. A `github:` member must still be a valid GitHub login.
 */
function parseMember(input: unknown): string {
  const member = text(input).trim();
  if (!member.includes(':')) {
    return parseGitHubLogin(member);
  }
  const identity = parseQualifiedIdentity(member);
  if (!identity.ok) {
    throw new Error(`"${member}" is not a member: ${identity.error.message}`);
  }
  if (identityProvider(identity.value) === GITHUB_PROVIDER_ID) {
    parseGitHubLogin(identitySubject(identity.value));
  }
  return identity.value;
}

function parseMembers(input: unknown): readonly string[] {
  if (input === undefined) {
    return [];
  }
  const items = toArray(input);
  if (items === undefined) {
    throw new Error('Role members must be a list of GitHub usernames or provider-qualified identities');
  }
  if (items.length > ROLE_LIMITS.membersMax) {
    throw new Error(`A role has at most ${ROLE_LIMITS.membersMax} members`);
  }
  const members = items.map(parseMember);
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
  if (feature === 'settings:roles' || feature === 'cli:roles') {
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
    componentRules: [],
    editorOff: [],
  };
  const client = parsed.find((role) => role.id === CLIENT_ROLE_ID) ?? {
    id: CLIENT_ROLE_ID,
    name: 'Client',
    members: [],
    access: CLIENT_DEFAULT_ACCESS,
    appPermissions: {},
    pinnedApps: [],
    componentRules: [],
    editorOff: [],
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

// ---- Editing options --------------------------------------------------------
//
// Which parts of the editor around the page, and which gestures on the page, a
// role has switched off. Stored as a deny list, `editorOff`, so a role without it
// keeps exactly what its permissions already give: an option can only take
// something away. The list fails closed: a value this version cannot read switches
// everything off for that role, because a restriction that cannot be understood
// must not be dropped.
//
// Switching something off also withholds every permission that would reach the
// same thing another way (`editorWithholds`): a role without the Style and
// Settings panel must not reach styles through Code, Selectors, Variables, Git or
// the AI chat. `can()` applies this, so every gate that already asks about a
// permission, the Studio server's included, follows it.

export const EDITOR_PARTS = [
  /** The whole right panel, Style and Settings. Off, nothing else reaches styles or settings either. */
  'sidePanel',
  // Canvas controls, in the order the Permissions view lists them.
  /** Change the page's text. */
  'text',
  /** Drag to reorder. */
  'drag',
  /** Change the page's images and their alt text. */
  'images',
  /** Insert new elements and components. */
  'insert',
  /** Delete elements. */
  'delete',
  /** Duplicate elements. */
  'duplicate',
  /** Copy elements. It changes nothing, so it limits no write. */
  'copy',
  /** Paste copied elements. */
  'paste',
  /** The bar over the page: breakpoint buttons, breadcrumbs, size, column guide and interact mode. */
  'canvasBar',
] as const;
export type EditorPart = (typeof EDITOR_PARTS)[number];

/** The canvas controls: every option but the right panel, which the Permissions view lists with its two tabs. */
export const CANVAS_PARTS = ['text', 'drag', 'images', 'insert', 'delete', 'duplicate', 'copy', 'paste', 'canvasBar'] as const satisfies readonly EditorPart[];
export type CanvasPart = (typeof CANVAS_PARTS)[number];

/** The right panel's two tabs, which are ordinary permissions. */
export const RIGHT_PANEL_FEATURES = ['panel:style', 'panel:settings'] as const satisfies readonly StaticAccessFeature[];
export type RightPanelFeature = (typeof RIGHT_PANEL_FEATURES)[number];

/** The options that change which elements are on the page. */
const STRUCTURE_PARTS = ['insert', 'delete', 'duplicate', 'paste'] as const satisfies readonly EditorPart[];

// With all three off the role is read only, and adding or deleting elements goes with them.
const CORE_PAGE_PARTS = ['drag', 'text', 'images'] as const satisfies readonly EditorPart[];

/** The options that limit what may be written: every one but those that change nothing (copying, the canvas bar). */
const WRITE_PARTS = ['sidePanel', ...CORE_PAGE_PARTS, ...STRUCTURE_PARTS] as const satisfies readonly EditorPart[];

/**
 * A role's stored `editorOff`: absent is none. Anything but a list of known parts,
 * a part from a newer version included, reads as every part off (fail closed).
 */
export function parseEditorOff(input: unknown): readonly EditorPart[] {
  if (input === undefined) {
    return [];
  }
  const items = toArray(input);
  if (items === undefined) {
    return EDITOR_PARTS;
  }
  if (items.length > EDITOR_PARTS.length) {
    return EDITOR_PARTS;
  }
  if (!items.every((item) => EDITOR_PARTS.some((part) => part === item))) {
    return EDITOR_PARTS;
  }
  const parsed = EDITOR_PARTS.filter((part) => items.includes(part));
  assert(parsed.length <= items.length, 'Reading editing options never adds one');
  return parsed;
}

/** What is really off: the stored parts, plus inserting, deleting, duplicating and pasting when dragging, text and images are all off. */
export function effectiveEditorOff(stored: readonly EditorPart[]): ReadonlySet<EditorPart> {
  assert(stored.length <= EDITOR_PARTS.length, 'Editing options are bounded');
  const off = new Set(stored);
  if (CORE_PAGE_PARTS.every((part) => off.has(part))) {
    for (const part of STRUCTURE_PARTS) {
      off.add(part);
    }
  }
  assert(off.size >= new Set(stored).size, 'Nothing stored is switched back on');
  return off;
}

/** Nothing on the page can be changed. */
export function readOnlyEditor(off: ReadonlySet<EditorPart>): boolean {
  return CORE_PAGE_PARTS.every((part) => off.has(part));
}

/**
 * Whether the options limit what may be written, rather than only what is drawn or copied.
 * The canvas bar is a view and copying changes nothing: alone they limit no write.
 */
export function limitsEditing(off: ReadonlySet<EditorPart>): boolean {
  return WRITE_PARTS.some((part) => off.has(part));
}

/** Whether any option holds the page's elements as they are in some way: their order, or which are there. */
export function limitsStructure(off: ReadonlySet<EditorPart>): boolean {
  assert(off.size <= EDITOR_PARTS.length, 'Editing options are bounded');
  return off.has('drag') || STRUCTURE_PARTS.some((part) => off.has(part));
}

// Routes that rewrite files with content nothing can check against the options:
// raw code, Git (restore, switch, merge), the AI chat, new pages and component
// source. A role with any limit on editing has none of them.
const WITHHELD_WHEN_LIMITED: readonly string[] = [
  'code:edit',
  'panel:code',
  'panel:ai',
  'panel:history',
  'panel:properties',
  'panel:audits',
  'component:create',
  'component:edit',
  'page:create',
];

// Everything else that styles the site.
const WITHHELD_WITHOUT_SIDE_PANEL: readonly string[] = [
  'panel:style',
  'panel:settings',
  'panel:selectors',
  'panel:variables',
  'settings:breakpoints',
  'cli:breakpoints',
];

// A read only role changes nothing in the project, and publishes nothing.
const WITHHELD_WHEN_READ_ONLY: readonly string[] = [
  'page:delete',
  'page:rename',
  'publish',
  'instructions:edit',
  'settings:folders',
  'settings:cms',
  'settings:studio',
  'settings:instructions',
  'settings:audits',
  'marketplace:install',
  'marketplace:publish',
  'apps:share',
  'cli:config',
  'cli:guides',
  'cli:breakpoints',
  'cli:folders',
  'cli:components',
  'cli:apps',
];

/** Whether the editing options take `feature` away, whatever the role's permissions say. */
export function editorWithholds(off: ReadonlySet<EditorPart>, feature: string): boolean {
  assert(feature.length > 0, 'A feature id is never empty');
  assert(off.size <= EDITOR_PARTS.length, 'Editing options are bounded');
  if (off.has('sidePanel') && WITHHELD_WITHOUT_SIDE_PANEL.includes(feature)) {
    return true;
  }
  if (limitsEditing(off) && WITHHELD_WHEN_LIMITED.includes(feature)) {
    return true;
  }
  if (readOnlyEditor(off) && WITHHELD_WHEN_READ_ONLY.includes(feature)) {
    return true;
  }
  // CMS entries hold both words and pictures, and the page shows them: changing either needs both.
  if (feature === 'panel:cms' && (off.has('text') || off.has('images'))) {
    return true;
  }
  // Replacing or deleting a file in Assets changes the pictures on the page.
  if (feature === 'panel:assets' && off.has('images')) {
    return true;
  }
  // The Add elements and Components panels are ways to add an element.
  return off.has('insert') && (feature === 'panel:elements' || feature === 'panel:components');
}
