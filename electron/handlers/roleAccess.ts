// Who the Desktop user is in a project, and the gate that refuses a write path
// the role hides (shared/properties/projectRoles.ts holds the rules).
//
// Identity: the GitHub account Desktop publishes with. That is the project's
// chosen publishing account (`.stacki/publish.json` `githubAccount`) when it is
// signed in on this machine, else the GitHub CLI's active account. No
// signed-in account means no identity, and the local user is admin.
//
// Desktop is a guardrail, not a security boundary: the local user owns the
// files and can edit `.stacki/roles.json` or the site directly. People named in
// no role stay admin on Desktop (`resolveRole(..., 'admin')`); Studio, where
// the server is the boundary, gives them the file's default role instead.
import { assert } from '../../shared/core/assert';
import { record } from '../../shared/core/boundary';
import { toArray } from '../../shared/core/record';
import type { IpcChannel } from '../../shared/ipc/ipcPayloads';
import {
  ADMIN_VIEW,
  can,
  parseGitHubLogin,
  parseProjectRolesSource,
  resolveRole,
  type ProjectRoles,
  type RoleView,
} from '../../shared/properties/projectRoles';
import { run } from '../lib/nodeTools';
import { readProjectMetadata } from '../project/projectMetadata';
import { readPublishConfig } from '../project/publishConfig';
import { channelAccess } from './channelAccess';
import type { MainHost } from './mainHost';

export const DESKTOP_ROLE_LIMITS = {
  /** How long a resolved GitHub identity is reused before `gh` is asked again. */
  identityCacheMs: 60_000,
  /** How long `gh auth status` may take before the identity is treated as unknown. */
  identityTimeoutMs: 10_000,
  /** Projects whose identity is cached at once; the app opens one at a time. */
  identityCacheEntriesMax: 16,
  /** Accounts read from `gh auth status`. */
  accountsMax: 50,
} as const satisfies Record<string, number>;

/** Reads a project's GitHub identity; injectable so tests never run `gh`. */
export type IdentityReader = (root: string) => Promise<string | undefined>;

/** The parsed roles file, undefined when absent. A broken file throws: callers decide. */
export function readDesktopRoles(root: string): ProjectRoles | undefined {
  assert(root.length > 0, 'A project root is named');
  const metadata = readProjectMetadata(root, 'roles');
  if (!metadata.ok) {
    throw new Error(metadata.error.message);
  }
  const source = metadata.value.source;
  if (source === undefined) {
    return undefined;
  }
  const roles = parseProjectRolesSource(source);
  assert(roles.roles.length >= 2, 'Admin and client are always present');
  return roles;
}

/**
 * The role main enforces for `root`. A missing file is admin without asking
 * `gh`; a broken file is admin too, so the local user can always open
 * Settings → Roles (or the file) and fix it.
 */
export async function desktopRole(root: string, identity: IdentityReader): Promise<RoleView> {
  let roles: ProjectRoles | undefined;
  try {
    roles = readDesktopRoles(root);
  } catch {
    return ADMIN_VIEW;
  }
  if (roles === undefined) {
    return ADMIN_VIEW;
  }
  const login = await identity(root);
  const role = resolveRole(roles, login, 'admin');
  assert(login !== undefined || role.isAdmin, 'Nobody signed in is admin on Desktop');
  return role;
}

/** The IPC gate: refuses a channel whose feature the project's role lacks. Undefined for ungated channels. */
export function createRoleGate(options: {
  readonly openRoot: () => string | undefined;
  readonly identity: IdentityReader;
}): (channel: IpcChannel, payload: unknown) => Promise<void> | undefined {
  return (channel, payload) => {
    const features = channelAccess(channel, payload);
    if (features === undefined) {
      return undefined;
    }
    assert(features.length > 0, 'A gated channel names at least one feature');
    const root = projectPathOf(payload) ?? options.openRoot();
    if (root === undefined) {
      return undefined;
    }
    return desktopRole(root, options.identity).then((role) => {
      if (features.some((feature) => can(role, feature))) {
        return;
      }
      throw new Error(`Your role (${role.name}) cannot do this in this project. Ask an admin for access.`);
    });
  };
}

/** The project path a payload names in its `projectPath`. Path-only payloads (a page file, a
 * project) are not read: the open project is the one whose roles apply to them. */
export function projectPathOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }
  const value = record(payload)['projectPath'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads the identity from `gh`, cached per project for a minute. */
export function createGitHubIdentity(): IdentityReader {
  const cache = new Map<string, { readonly login: string | undefined; readonly until: number }>();
  return async (root) => {
    const cached = cache.get(root);
    if (cached !== undefined && cached.until > Date.now()) {
      return cached.login;
    }
    const login = await readGitHubIdentity(root).catch(() => undefined);
    if (cache.size >= DESKTOP_ROLE_LIMITS.identityCacheEntriesMax) {
      cache.clear();
    }
    cache.set(root, { login, until: Date.now() + DESKTOP_ROLE_LIMITS.identityCacheMs });
    assert(cache.size <= DESKTOP_ROLE_LIMITS.identityCacheEntriesMax, 'The identity cache is bounded');
    return login;
  };
}

async function readGitHubIdentity(root: string): Promise<string | undefined> {
  const result = await run('gh', ['auth', 'status', '--hostname', 'github.com', '--json', 'hosts'], root, {
    timeout: DESKTOP_ROLE_LIMITS.identityTimeoutMs,
  });
  const output: unknown = JSON.parse(result.stdout);
  let preferred = '';
  try {
    preferred = readPublishConfig(root).githubAccount;
  } catch {
    preferred = '';
  }
  return identityFromStatus(output, preferred);
}

/** The login from `gh auth status --json hosts`: the preferred account when signed in, else the active one. */
export function identityFromStatus(output: unknown, preferred: string): string | undefined {
  const hosts = record(record(output)['hosts']);
  const entries = toArray(hosts['github.com']) ?? [];
  if (entries.length > DESKTOP_ROLE_LIMITS.accountsMax) {
    throw new Error('Too many GitHub accounts to read');
  }
  const accounts = entries.map(record).filter((entry) => entry['state'] === 'success');
  const chosen =
    accounts.find((entry) => typeof entry['login'] === 'string' && preferred !== '' && entry['login'].toLowerCase() === preferred.toLowerCase()) ??
    accounts.find((entry) => entry['active'] === true);
  if (chosen === undefined) {
    return undefined;
  }
  const login = parseGitHubLogin(chosen['login']);
  assert(login.length > 0, 'A chosen account has a login');
  return login;
}

/** `roles:identity`: the login roles resolve for, so the renderer shows the same role main enforces. */
export function registerRoleHandlers(host: Pick<MainHost, 'ipcMain'>, identity: IdentityReader): void {
  host.ipcMain.handle('roles:identity', async (_event, input) => ({ login: await identity(input.projectPath) }));
}
