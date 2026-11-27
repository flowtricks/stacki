// i18n-ignore-file: the CLI and its MCP tools speak to agents and scripts in English; none of this is interface text.
// `.stacki/roles.json`: who may use which parts of Stacki in this project. The parser is shared/properties/projectRoles.ts;
// the hidden-component rules inside each role are parsed by shared/properties/componentAccess.ts.
import { APP_PERMISSION_LIMITS } from '../../appPermissions';
import { COMPONENT_ACCESS_LIMITS } from '../../componentAccess';
import { ACCESS_FEATURES, ADMIN_ROLE_ID, EDITOR_PARTS, ROLE_LIMITS, parseProjectRoles, serializeProjectRoles } from '../../projectRoles';
import { arrayOf, bool, field, literal, mapOf, objectOf, oneOf, text, type FileSchema, type ValueSchema } from '../stackiSchema';

const APP_ID = '^[a-z0-9][a-z0-9._-]*$';
const PERMISSION_ID = '^[a-z][a-z0-9-]*$';
const LOGIN = '^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9]))*$';
const EDITOR_OPTION = 'An editing option name (a value in editorOff), not a file key.';

// `settings:roles` and `cli:roles` are in ACCESS_FEATURES for callers that ask about it, but the parser refuses it as a grant: only admin edits roles.
const grantableFeatures = ACCESS_FEATURES.filter((feature) => feature !== 'settings:roles' && feature !== 'cli:roles');
const ACCESS_PATTERN = `^(?:${grantableFeatures.join('|')}|app:\\*|app:[a-z0-9][a-z0-9._-]*)$`;

const accessGrant: ValueSchema = text('app:'.length + ROLE_LIMITS.appIdCharsMax, { charsMin: 1, pattern: ACCESS_PATTERN });

const componentRule: ValueSchema = objectOf({
  kind: field(oneOf('component', 'folder'), 'Whether the rule names one component file or every component under a folder.', {
    required: true,
    commands: ['roles components hide', 'roles components show'],
  }),
  path: field(
    text(COMPONENT_ACCESS_LIMITS.pathCharsMax, { charsMin: 1 }),
    `A project-relative path with / separators, at most ${COMPONENT_ACCESS_LIMITS.pathDepthMax} folders deep (src/components/interactive/Tabs.astro). A rule whose path no longer exists is kept and ignored.`,
    { required: true, commands: ['roles components hide', 'roles components show'] },
  ),
  effect: field(oneOf('hide', 'show'), 'Hide stops the role adding the component; show re-shows one inside a hidden folder. The most specific rule wins.', {
    default: 'hide',
    commands: ['roles components hide', 'roles components show'],
  }),
});

const role: ValueSchema = objectOf({
  id: field(
    text(ROLE_LIMITS.roleIdCharsMax, { charsMin: 1, pattern: '^[a-z][a-z0-9-]*$' }),
    'The role slug. "admin" and "client" are built in; "developer" and "designer" still read as admin.',
    {
      required: true,
      commands: ['roles add', 'roles remove'],
    },
  ),
  name: field(
    text(ROLE_LIMITS.roleNameCharsMax, { charsMin: 1 }),
    'The display name. Required for a custom role; admin and client fall back to their built-in names.',
    {
      commands: ['roles add'],
    },
  ),
  members: field(
    arrayOf(text(ROLE_LIMITS.loginCharsMax, { charsMin: 1, pattern: LOGIN }), ROLE_LIMITS.membersMax),
    'GitHub usernames in this role; a login is in at most one role (case-insensitive). The admin role needs one as soon as any role lists a member; a file with no members anywhere is unclaimed and grants as no file does.',
    { default: 'no members', commands: ['roles members add', 'roles members remove'] },
  ),
  access: field(
    arrayOf(accessGrant, ROLE_LIMITS.accessMax),
    'The features this role may use (panel:pages, publish, settings:editor, ...), or app:<id> / app:* for apps; "settings:roles" is never grantable. Admin has everything, so its list is dropped on save.',
    { default: 'client: the built-in client set; any other role: none', commands: ['roles access grant', 'roles access revoke'] },
  ),
  appPermissions: field(
    mapOf(
      mapOf(bool(), APP_PERMISSION_LIMITS.permissionsMax, 'a permission id the app declares', PERMISSION_ID),
      ROLE_LIMITS.appPermissionAppsMax,
      'an installed app id',
      APP_ID,
    ),
    'The app permission switches an admin set for this role, by app id then permission id; a missing one takes the manifest default. Dropped for admin, which has every one.',
    { default: 'each permission takes its manifest default' },
  ),
  pinnedApps: field(
    arrayOf(text(ROLE_LIMITS.appIdCharsMax, { charsMin: 1, pattern: APP_ID }), ROLE_LIMITS.pinnedAppsMax, { unique: true }),
    'Apps pinned to the left rail, in pin order; ids of uninstalled apps are kept.',
    {
      default: 'none pinned',
    },
  ),
  editorOff: field(
    arrayOf(oneOf(...EDITOR_PARTS), EDITOR_PARTS.length, { unique: true }),
    'Editing options switched off for this role: sidePanel (Style and Settings), navigator, canvasBar (breakpoints, breadcrumbs, guide), drag, text, images, elements (add, duplicate, delete). With drag, text and images off the role is read only. They also withhold permissions that reach the same thing another way. Dropped for admin.',
    { default: 'every option the permissions allow is on' },
  ),
  componentRules: field(
    arrayOf(componentRule, COMPONENT_ACCESS_LIMITS.rulesMax),
    "Components or folders hidden from, or re-shown to, this role's insert surfaces. They never limit what the role may open. Admin may have rules too.",
    { default: 'every component is enabled', commands: ['roles components hide', 'roles components show'] },
  ),
});

export const ROLES_FILE: FileSchema = {
  id: 'roles',
  file: '.stacki/roles.json',
  description: 'The project roles: who may use which parts of Stacki, shared by Desktop and Studio. Only admin edits it.',
  requires: 'settings:roles',
  metadataKind: 'roles',
  serialize: (document) => serializeProjectRoles(parseProjectRoles(document)),
  fields: {
    version: field(literal(1), 'The file format version.', { required: true }),
    defaultRole: field(
      text(ROLE_LIMITS.roleIdCharsMax, { charsMin: 1, pattern: '^[a-z][a-z0-9-]*$' }),
      'The role of a signed-in Studio user named in no role; must be a role of this file.',
      { default: ADMIN_ROLE_ID },
    ),
    roles: field(
      arrayOf(role, ROLE_LIMITS.rolesMax),
      'The roles. Admin and client are always present after reading, listed or not; the admin role must name a member before any other role does.',
      { required: true, commands: ['roles add', 'roles remove'] },
    ),
  },
  // Unclaimed: no member in any role, so it grants exactly as no file does and names no real person until an admin is added.
  empty: { version: 1, defaultRole: 'admin', roles: [{ id: 'admin', name: 'Admin', members: [] }] },
  commands: [
    'roles add',
    'roles remove',
    'roles members add',
    'roles members remove',
    'roles access grant',
    'roles access revoke',
    'roles components hide',
    'roles components show',
  ],
  parserSources: ['shared/properties/projectRoles.ts', 'shared/properties/componentAccess.ts'],
  parserKeyExceptions: {
    sidePanel: EDITOR_OPTION,
    navigator: EDITOR_OPTION,
    text: EDITOR_OPTION,
    images: EDITOR_OPTION,
    elements: EDITOR_OPTION,
  },
};
