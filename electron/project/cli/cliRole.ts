// Who the CLI acts as: a role from the project's own `.stacki/roles.json`, and the one question every command asks, `can`.
//
// Tiers, honest about what each can enforce:
//   - A person at a shell: no role claimed means the project owner (admin); `--login <github login>` (or `STACKI_LOGIN`) acts as the role roles.json
//     gives that member, and as the default role for a login it does not list. `--as-role <id>` acts as that role for the command.
//   - An AI agent over MCP: `stacki mcp --role <id>` pins the server to a role; tool inputs cannot change it. In a project with roles.json a server
//     started without --role or --login refuses every tool (it never falls back to admin), so an agent's power is always chosen on purpose.
//   Both are COOPERATIVE guardrails on a local machine: anyone who can run the CLI as the owner can edit roles.json or run another role. The real
//   enforcement is the Studio server, which resolves the authenticated identity and answers for it (docs/stacki-cli.md, "Roles and identity").
import { err, ok, type Result } from '../../../shared/core/result';
import type { CliError } from '../../../shared/properties/cli/stackiOutput';
import {
  ADMIN_VIEW,
  ADMIN_ROLE_ID,
  can,
  parseProjectRolesSource,
  resolveRole,
  roleViewOf,
  type ProjectRoles,
  type RoleView,
} from '../../../shared/properties/projectRoles';
import { accessFeatureOf, cliFeatureAllowed, type CliAccessFeature } from '../../../shared/properties/cli/stackiFeatures';
import { readProjectMetadata } from '../projectMetadata';

export interface RoleRequest {
  /** A role id to act as. */
  readonly role?: string | undefined;
  /** A GitHub login whose role roles.json decides. */
  readonly login?: string | undefined;
  /**
   * Who acts when neither a role nor a login is named and the project has roles: the owner (a person at a shell, the default), or nobody
   * (`require`: the MCP server, whose agent must be pinned to a role on purpose rather than inherit admin silently).
   */
  readonly unnamed?: 'owner' | 'require';
}

export interface RoleContext {
  readonly view: RoleView;
  /** How the role was chosen, for the plan and the docs: `owner` is the local default. */
  readonly basis: 'owner' | 'role' | 'login';
}

export function loadRoles(root: string): Result<ProjectRoles | undefined, CliError> {
  const read = readProjectMetadata(root, 'roles');
  if (!read.ok) {
    return err({ code: 'refused', message: read.error.message });
  }
  if (read.value.source === undefined) {
    return ok(undefined);
  }
  try {
    return ok(parseProjectRolesSource(read.value.source));
  } catch (error: unknown) {
    return err({ code: 'invalid-file', message: `.stacki/roles.json is refused by the app: ${error instanceof Error ? error.message : String(error)}` });
  }
}

export function resolveRoleContext(root: string, request: RoleRequest): Result<RoleContext, CliError> {
  const roles = loadRoles(root);
  if (!roles.ok) {
    return roles;
  }
  if (request.role !== undefined) {
    if (roles.value === undefined) {
      return request.role === ADMIN_ROLE_ID
        ? ok({ view: ADMIN_VIEW, basis: 'role' })
        : err({ code: 'usage', message: `There is no .stacki/roles.json, so the only role is "${ADMIN_ROLE_ID}"; "${request.role}" does not exist.` });
    }
    const known = roles.value.roles.some((role) => role.id === request.role);
    return known
      ? ok({ view: roleViewOf(roles.value, request.role), basis: 'role' })
      : err({ code: 'usage', message: `"${request.role}" is not a role in .stacki/roles.json (${roles.value.roles.map((role) => role.id).join(', ')}).` });
  }
  if (request.login !== undefined && roles.value !== undefined) {
    return ok({ view: resolveRole(roles.value, request.login, 'default'), basis: 'login' });
  }
  if (roles.value !== undefined && request.unnamed === 'require') {
    return err({
      code: 'usage',
      message: `This project has .stacki/roles.json, so the MCP server needs a role: start it with --role <role> (${roles.value.roles
        .map((role) => role.id)
        .join(', ')}) or --login <github-login>. It never acts as admin unless --role admin is given.`,
    });
  }
  return ok({ view: ADMIN_VIEW, basis: 'owner' });
}

/** Why `role` may not use a command needing `feature`, or undefined. The message names the feature and the role, never plan details. */
export function roleDenial(role: RoleView, feature: CliAccessFeature, featureKey: string): CliError | undefined {
  if (cliFeatureAllowed(role, feature)) {
    return undefined;
  }
  return {
    code: 'role-denied',
    message: `Role "${role.id}" may not run this command: it needs ${feature} (${featureKey}). Ask a project admin to grant it in Settings > Roles.`,
  };
}

/** Why `role` may not change a file that needs the app feature `requires` (or admin), or undefined. */
export function fileDenial(role: RoleView, requires: string, file: string): CliError | undefined {
  if (role.isAdmin) {
    return undefined;
  }
  const feature = accessFeatureOf(requires);
  if (feature === undefined || !can(role, feature)) {
    return { code: 'role-denied', message: `Role "${role.id}" may not change ${file}: it needs ${requires} (the same access the app asks for).` };
  }
  return undefined;
}
