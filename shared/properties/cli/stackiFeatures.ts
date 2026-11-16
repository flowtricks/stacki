// The access features the `stacki` command line and its MCP server answer to.
// They are ordinary role features (shared/properties/projectRoles.ts), listed per
// role in Settings > Roles under "Command line", so the CLI adds no second
// permission system: one file, `.stacki/roles.json`, decides what each role may do.
import { assert } from '../../core/assert';
import { ACCESS_FEATURES, can, type AccessFeature, type RoleView, type StaticAccessFeature } from '../projectRoles';

/**
 * Every feature a CLI command can require. `cli:read` is granted to every role by
 * default; the write features start with admin only. `cli:roles` (roles edits,
 * enabling and trusting apps) is in the list so commands can ask for it, but like
 * `settings:roles` it is never grantable, so only admin ever passes.
 */
export const CLI_ACCESS_FEATURES = [
  'cli:read',
  'cli:config',
  'cli:guides',
  'cli:breakpoints',
  'cli:folders',
  'cli:components',
  'cli:apps',
  'cli:roles',
] as const satisfies readonly StaticAccessFeature[];
export type CliAccessFeature = (typeof CLI_ACCESS_FEATURES)[number];

/**
 * Whether `role` may run a command that requires `feature`. This is `can`, named
 * for the CLI so a command table reads as a policy and so the one gate, `can`,
 * keeps deciding: admin always passes and `cli:roles` is never granted to anyone else.
 */
export function cliFeatureAllowed(role: RoleView, feature: CliAccessFeature): boolean {
  assert(feature.startsWith('cli:'), 'A CLI feature is in the cli group');
  return can(role, feature);
}

/** The access feature a registry `requires` text names (`settings:folders`, `app:notes`), or undefined for `admin` and unknown text. */
export function accessFeatureOf(text: string): AccessFeature | undefined {
  assert(text.length >= 0, 'A feature text has a length');
  const known = ACCESS_FEATURES.find((feature) => feature === text);
  if (known !== undefined) {
    return known;
  }
  return text.startsWith('app:') && text.length > 4 ? (`app:${text.slice(4)}` satisfies AccessFeature) : undefined;
}
