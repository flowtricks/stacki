// i18n-ignore-file: the CLI and its MCP tools speak to agents and scripts in English; none of this is interface text.
// The command table of the Stacki CLI: one row per command, read by the argument parser, the help text, the MCP tool list and the docs.
//
// Why one table: a command that exists in the shell but not in the MCP server (or the reverse) is a hole an agent falls into, and a command
// without a role feature would run for everyone. Rows are the only place a command is declared, so the MCP tools are the same commands by
// construction, and a test (test/shared/properties/cli/stackiCommands.test.ts) fails for a row without a feature key or a handler without a row.
import type { CliAccessFeature } from './stackiFeatures';

export type ArgKind = 'string' | 'integer' | 'number' | 'boolean' | 'json' | 'enum';

export interface ArgSpec {
  readonly name: string;
  readonly kind: ArgKind;
  readonly required: boolean;
  /** A positional argument is written without a flag, in the order listed. */
  readonly positional?: boolean;
  readonly description: string;
  readonly values?: readonly string[];
}

export interface CommandSpec {
  /** The words that name it: `['config', 'set']`. */
  readonly words: readonly string[];
  readonly summary: string;
  /** Whether it can change files. */
  readonly access: 'read' | 'write';
  /** Needs `--apply --yes`: it removes things people made. */
  readonly destructive: boolean;
  /** The role feature a role needs (shared/properties/projectRoles.ts); `cli:roles` is admin only. */
  readonly feature: CliAccessFeature;
  /** The stable key of this command in the registry of command permissions: `cli.config.set`. */
  readonly featureKey: string;
  readonly args: readonly ArgSpec[];
  /** The installed app that added this command (shared/properties/cli/stackiAppCli.ts); absent for the core table. Its words are `[appId, name]`. */
  readonly appId?: string;
  /** The permission the app declared in its manifest that the role must also hold (`appPermissionsFor`); only with `appId`. */
  readonly permission?: string;
}

const arg = (
  name: string,
  kind: ArgKind,
  description: string,
  options: { readonly required?: boolean; readonly positional?: boolean; readonly values?: readonly string[] } = {},
): ArgSpec => ({
  name,
  kind,
  description,
  required: options.required ?? false,
  ...(options.positional === undefined ? {} : { positional: options.positional }),
  ...(options.values === undefined ? {} : { values: options.values }),
});

const FILE = arg('file', 'string', 'The settings file: its id from "stacki schema" (guide, roles, breakpoints, ...) or its .stacki/ path.', {
  required: true,
  positional: true,
});
const PATH = arg('path', 'string', 'The key inside the file, for example settings.visible, entries[0] or components["Card.astro"].', {
  required: true,
  positional: true,
});
const SIZE = 'A length such as 16px or 3rem, a project variable such as --site-margin, or "default" to clear it.';

function command(
  words: readonly string[],
  summary: string,
  feature: CliAccessFeature,
  options: { readonly write?: boolean; readonly destructive?: boolean; readonly args?: readonly ArgSpec[] } = {},
): CommandSpec {
  return {
    words,
    summary,
    access: options.write === true ? 'write' : 'read',
    destructive: options.destructive ?? false,
    feature,
    featureKey: `cli.${words.join('.')}`,
    args: options.args ?? [],
  };
}

export const COMMANDS: readonly CommandSpec[] = [
  command(['schema'], 'Print the key reference of a .stacki file (types, bounds, defaults, which commands set each key), or list the files.', 'cli:read', {
    args: [arg('file', 'string', 'A file id or path; omit to list every file.', { positional: true })],
  }),
  command(['list'], 'List components, apps, guides, breakpoints, roles or folders as the project has them.', 'cli:read', {
    args: [
      arg('what', 'enum', 'What to list.', { required: true, positional: true, values: ['components', 'apps', 'guides', 'breakpoints', 'roles', 'folders'] }),
    ],
  }),
  command(['doctor'], "Check project health: every .stacki file against the app's own parser and the key reference.", 'cli:read'),
  command(['config', 'get'], 'Read one key (or a whole file) of a .stacki file with its type and description.', 'cli:read', {
    args: [FILE, arg('path', 'string', 'The key; omit for the whole file.', { positional: true })],
  }),
  command(['config', 'set'], "Set one key of a .stacki file, validated against the key reference and the app's parser.", 'cli:config', {
    write: true,
    args: [
      FILE,
      PATH,
      arg('value', 'json', 'The new value as JSON (true, 3, "text", {"kind":"count","count":4}); bare text is taken as a string.', {
        required: true,
        positional: true,
      }),
    ],
  }),
  command(['config', 'unset'], 'Remove one optional key so the app uses its default again.', 'cli:config', { write: true, args: [FILE, PATH] }),
  command(['config', 'add'], 'Append to a list key (or create a new entry in a map key).', 'cli:config', {
    write: true,
    args: [
      FILE,
      PATH,
      arg('value', 'json', 'The entry as JSON.', { required: true, positional: true }),
      arg('position', 'integer', 'Where in the list to insert; default the end.'),
    ],
  }),
  command(['config', 'remove'], 'Remove an entry from a list (by value or position) or a map (by key).', 'cli:config', {
    write: true,
    destructive: true,
    args: [FILE, PATH, arg('value', 'json', 'The list entry to remove, as JSON; or name it in the path.', { positional: true })],
  }),
  command(
    ['guides', 'set'],
    'Set column guide preferences (.stacki/guide.json): visibility, numbers, colour, opacity, columns, margin, gutter, maximum width.',
    'cli:guides',
    {
      write: true,
      args: [
        arg('visible', 'boolean', 'Draw the guide.'),
        arg('numbers', 'boolean', 'Number the columns.'),
        arg('color', 'string', 'A literal CSS colour.'),
        arg('opacity', 'number', 'Column opacity.'),
        arg('columns', 'string', '"automatic", a count 2..32, or a project variable such as --site-columns.'),
        arg('margin', 'string', SIZE),
        arg('gutter', 'string', SIZE),
        arg('widthMax', 'string', SIZE),
      ],
    },
  ),
  command(['guides', 'clear'], 'Reset the column guide: one size (margin, gutter, widthMax) back to the project default, or everything.', 'cli:guides', {
    write: true,
    destructive: true,
    args: [arg('field', 'enum', 'What to reset.', { required: true, positional: true, values: ['margin', 'gutter', 'widthMax', 'all'] })],
  }),
  command(['breakpoints', 'set'], 'Change a breakpoint\'s boundary or name, or the desktop width (id "desktop").', 'cli:breakpoints', {
    write: true,
    args: [
      arg('id', 'string', 'The breakpoint id (laptop, tablet, phone, bp-4, ...) or "desktop".', { required: true, positional: true }),
      arg('value', 'number', 'The boundary number.'),
      arg('unit', 'enum', 'rem or px.', { values: ['rem', 'px'] }),
      arg('name', 'string', 'A display name; "default" clears it.'),
    ],
  }),
  command(['breakpoints', 'add'], 'Add a breakpoint.', 'cli:breakpoints', {
    write: true,
    args: [
      arg('name', 'string', 'Display name.', { required: true, positional: true }),
      arg('value', 'number', 'The boundary number.', { required: true }),
      arg('unit', 'enum', 'rem or px.', { required: true, values: ['rem', 'px'] }),
    ],
  }),
  command(['breakpoints', 'remove'], 'Remove a breakpoint (built-in ones cannot go) and forget its remembered sync choices.', 'cli:breakpoints', {
    write: true,
    destructive: true,
    args: [arg('id', 'string', 'The breakpoint id.', { required: true, positional: true })],
  }),
  command(
    ['breakpoints', 'sync'],
    "Report where a breakpoint's boundary is written in styles and pages (read-only scan of what a sync would touch).",
    'cli:read',
    {
      args: [arg('id', 'string', 'The breakpoint id.', { required: true, positional: true })],
    },
  ),
  command(['roles', 'add'], 'Add a custom role with only the default access (cli:read).', 'cli:roles', {
    write: true,
    args: [arg('name', 'string', "The role's display name; its id is derived.", { required: true, positional: true })],
  }),
  command(['roles', 'remove'], 'Remove a custom role.', 'cli:roles', {
    write: true,
    destructive: true,
    args: [arg('role', 'string', 'The role id.', { required: true, positional: true })],
  }),
  command(['roles', 'members', 'add'], 'Add a GitHub login to a role (and take it out of any other role).', 'cli:roles', {
    write: true,
    args: [
      arg('role', 'string', 'The role id.', { required: true, positional: true }),
      arg('login', 'string', 'A GitHub login.', { required: true, positional: true }),
    ],
  }),
  command(['roles', 'members', 'remove'], 'Remove a login from a role.', 'cli:roles', {
    write: true,
    destructive: true,
    args: [
      arg('role', 'string', 'The role id.', { required: true, positional: true }),
      arg('login', 'string', 'A GitHub login.', { required: true, positional: true }),
    ],
  }),
  command(
    ['roles', 'access', 'grant'],
    'Grant a role one access feature (see "stacki schema roles"); roles.json itself and cli:roles stay admin only.',
    'cli:roles',
    {
      write: true,
      args: [
        arg('role', 'string', 'The role id.', { required: true, positional: true }),
        arg('feature', 'string', 'The feature id, for example panel:cms or cli:guides.', { required: true, positional: true }),
      ],
    },
  ),
  command(['roles', 'access', 'revoke'], 'Take one access feature away from a role.', 'cli:roles', {
    write: true,
    destructive: true,
    args: [
      arg('role', 'string', 'The role id.', { required: true, positional: true }),
      arg('feature', 'string', 'The feature id.', { required: true, positional: true }),
    ],
  }),
  command(['roles', 'components', 'hide'], "Hide a component or folder from a role's insert menu (componentRules).", 'cli:roles', {
    write: true,
    args: [
      arg('role', 'string', 'The role id.', { required: true, positional: true }),
      arg('path', 'string', 'A project-relative component file or folder.', { required: true }),
    ],
  }),
  command(
    ['roles', 'components', 'show'],
    'Show a hidden component or folder to a role again (drops the rule, or adds a show rule under a hidden folder).',
    'cli:roles',
    {
      write: true,
      args: [
        arg('role', 'string', 'The role id.', { required: true, positional: true }),
        arg('path', 'string', 'A project-relative component file or folder.', { required: true }),
      ],
    },
  ),
  command(['folders', 'add'], "Add a project folder to a kind (components, layouts, assets, styles, variables) with the app's folder rules.", 'cli:folders', {
    write: true,
    args: [
      arg('kind', 'enum', 'Which list.', { required: true, positional: true, values: ['components', 'layouts', 'assets', 'styles', 'variables'] }),
      arg('folder', 'string', 'A project-relative folder.', { required: true, positional: true }),
    ],
  }),
  command(['folders', 'remove'], 'Remove a project folder from a kind.', 'cli:folders', {
    write: true,
    destructive: true,
    args: [
      arg('kind', 'enum', 'Which list.', { required: true, positional: true, values: ['components', 'layouts', 'assets', 'styles', 'variables'] }),
      arg('folder', 'string', 'The folder.', { required: true, positional: true }),
    ],
  }),
  command(['folders', 'reset'], "Reset a kind to the app's default folders.", 'cli:folders', {
    write: true,
    destructive: true,
    args: [arg('kind', 'enum', 'Which list.', { required: true, positional: true, values: ['components', 'layouts', 'assets', 'styles', 'variables'] })],
  }),
  command(['apps', 'commands'], 'List the commands installed apps add to the CLI.', 'cli:read'),
  command(['apps', 'remove'], 'Remove an installed app (its folder and lock entry) and its stored non-secret settings.', 'cli:apps', {
    write: true,
    destructive: true,
    args: [arg('app', 'string', 'The app id.', { required: true, positional: true })],
  }),
  command(['apps', 'settings', 'set'], 'Set one non-secret app setting value (.stacki/apps/settings.json).', 'cli:apps', {
    write: true,
    args: [
      arg('app', 'string', 'The app id.', { required: true, positional: true }),
      arg('setting', 'string', 'The setting id.', { required: true, positional: true }),
      arg('value', 'string', 'The text value.', { required: true, positional: true }),
    ],
  }),
  command(['apps', 'enable'], "Enable an installed app's CLI commands for this project and record that you trust it (.stacki/cli.json).", 'cli:roles', {
    write: true,
    args: [
      arg('app', 'string', 'The app id.', { required: true, positional: true }),
      arg('network', 'boolean', 'Also approve the network use the app declares (module handlers cannot be stopped from using it).'),
    ],
  }),
  command(['apps', 'disable'], "Disable an app's CLI commands for this project.", 'cli:roles', {
    write: true,
    args: [arg('app', 'string', 'The app id.', { required: true, positional: true })],
  }),
  command(['components', 'rename'], 'Rename a component and keep every reference in step (recipes, role rules, imports).', 'cli:components', {
    write: true,
    args: [
      arg('path', 'string', 'The component file.', { required: true, positional: true }),
      arg('name', 'string', 'The new name.', { required: true, positional: true }),
    ],
  }),
  command(['components', 'move'], 'Move a component to another folder and keep every reference in step.', 'cli:components', {
    write: true,
    args: [
      arg('path', 'string', 'The component file.', { required: true, positional: true }),
      arg('folder', 'string', 'The target folder.', { required: true, positional: true }),
    ],
  }),
  command(['components', 'duplicate'], 'Duplicate a component or folder under a free name.', 'cli:components', {
    write: true,
    args: [arg('path', 'string', 'The component file or folder.', { required: true, positional: true })],
  }),
  command(['components', 'delete'], 'Delete an unused component or folder and the recipes and role rules that name it.', 'cli:components', {
    write: true,
    destructive: true,
    args: [arg('path', 'string', 'The component file or folder.', { required: true, positional: true })],
  }),
  command(['undo'], 'Put back what an applied command changed, if those files are still as it left them.', 'cli:config', {
    write: true,
    args: [arg('id', 'string', 'The undo id an apply printed.', { required: true, positional: true })],
  }),
];

export function commandByWords(words: readonly string[]): CommandSpec | undefined {
  return COMMANDS.find((entry) => entry.words.length === words.length && entry.words.every((word, index) => word === words[index]));
}

export function toolNameOf(spec: Pick<CommandSpec, 'words'>): string {
  return `stacki_${spec.words.join('_')}`;
}
