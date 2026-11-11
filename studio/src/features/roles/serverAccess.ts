// The Studio server's half of project roles: every write request is checked
// against the role of the person who sent it, so a panel the UI hides cannot be
// reached by calling its route. Reads stay open: they change nothing.
//
// Who sent it: behind the Cloudflare worker (STUDIO_CONTAINER_TOKEN set), the
// worker has verified the GitHub session and forwards the login as
// `x-studio-user`, trusted only with the matching `x-studio-token` (checked
// before this runs). A local Studio has no sign-in: its user is admin, as before.
//
// Which role: the one naming that login in `.stacki/roles.json`, else the
// file's default role. No file is admin for everyone (today's behaviour). A file
// that does not parse fails closed to the built-in client role, so a typo can
// never widen access; fix it with Git or on Desktop.
import type { IncomingMessage } from 'node:http';
import {
  ADMIN_VIEW,
  CLIENT_ROLE_ID,
  DEFAULT_PROJECT_ROLES,
  can,
  parseGitHubLogin,
  parseProjectRolesSource,
  resolveRole,
  roleViewOf,
  type AccessFeature,
  type RoleView,
} from '../../../vendor/stacki/shared/properties/projectRoles';
import { metadataKind } from '../../../vendor/stacki/shared/properties/projectMetadata';
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { readMetadataSource } from '../settings/projectMetadata';
import { METADATA_ACCESS, roleRefusal } from './documentAccess';

export { RoleRefusal } from './documentAccess';

export const SERVER_ACCESS_LIMITS = {
  /**
   * How long a collaboration connection reuses its resolved role. Keystrokes
   * arrive many times a second; a role change reaches open editors within this.
   */
  connectionRoleCacheMs: 5_000,
} as const satisfies Record<string, number>;

/** What a write route needs. `metadata` routes decide by the file kind in the body. */
type RouteRule = { readonly kind: 'features'; readonly features: readonly AccessFeature[] } | { readonly kind: 'metadata' };

/** Write routes by exact path, then by prefix. Paths not listed are not gated. */
const EXACT: ReadonlyMap<string, RouteRule> = new Map<string, RouteRule>([
  ['/studio/api/create', { kind: 'features', features: ['page:create', 'panel:cms'] }],
  ['/studio/api/pages/rename', { kind: 'features', features: ['page:rename'] }],
  ['/studio/api/upload', { kind: 'features', features: ['panel:assets'] }],
  ['/studio/api/assets', { kind: 'features', features: ['panel:assets'] }],
  ['/studio/api/variables', { kind: 'features', features: ['panel:variables'] }],
  ['/studio/api/component-properties', { kind: 'features', features: ['panel:properties'] }],
  ['/studio/api/defaults-canvas', { kind: 'features', features: ['component:edit'] }],
  ['/studio/api/source', { kind: 'features', features: ['panel:style', 'panel:selectors', 'code:edit'] }],
  ['/studio/api/publish', { kind: 'features', features: ['publish'] }],
  ['/studio/api/publish/account', { kind: 'features', features: ['publish'] }],
  ['/studio/api/publish/repository', { kind: 'features', features: ['publish'] }],
  ['/studio/api/sync', { kind: 'features', features: ['panel:history', 'publish'] }],
  ['/studio/api/storage/cleanup', { kind: 'features', features: ['settings:studio'] }],
  ['/studio/api/metadata', { kind: 'metadata' }],
  // The official app marketplace (appsServer.ts). Browsing is a POST so it is gated here like a write:
  // it reaches the network for the index, and the role decides who sees the marketplace at all.
  ['/studio/api/apps/marketplace', { kind: 'features', features: ['marketplace:view'] }],
  ['/studio/api/apps/marketplace/install', { kind: 'features', features: ['marketplace:install'] }],
  // Sharing and publishing apps (appsServer.ts publishAction). Scans and status reads serve both features.
  ['/studio/api/apps/publish/scan', { kind: 'features', features: ['apps:share', 'marketplace:publish'] }],
  ['/studio/api/apps/publish/status', { kind: 'features', features: ['apps:share', 'marketplace:publish'] }],
  ['/studio/api/apps/publish/share', { kind: 'features', features: ['apps:share'] }],
  ['/studio/api/apps/publish/switch-source', { kind: 'features', features: ['apps:share'] }],
  ['/studio/api/apps/publish/make-public', { kind: 'features', features: ['marketplace:publish'] }],
  ['/studio/api/apps/publish/add-license', { kind: 'features', features: ['marketplace:publish'] }],
  ['/studio/api/apps/publish/check', { kind: 'features', features: ['marketplace:publish'] }],
  ['/studio/api/apps/publish/submit', { kind: 'features', features: ['marketplace:publish'] }],
  // Reading settings is a POST only to carry the app id; anyone who can open apps fills theirs in.
  ['/studio/api/apps/settings/read', { kind: 'features', features: ['panel:apps'] }],
  ['/studio/api/apps/settings/write', { kind: 'features', features: ['panel:apps'] }],
  // A POST only to carry the app id: where an installed app lives, for anyone who sees the Apps panel.
  ['/studio/api/apps/visibility', { kind: 'features', features: ['panel:apps'] }],
  // An app's file calls read and write raw project files: code editing (appAccessServer.ts checks the app's grant too).
  ['/studio/api/apps/files', { kind: 'features', features: ['code:edit'] }],
  // A POST only to carry the file list: an app reads other pages only for a role that sees the Pages panel.
  ['/studio/api/file-stamps', { kind: 'features', features: ['panel:pages'] }],
]);
const PREFIXES: readonly (readonly [string, RouteRule])[] = [
  // An app's sign-ins are the person's own, like its settings: anyone who can open apps.
  ['/studio/api/apps/auth/', { kind: 'features', features: ['panel:apps'] }],
  // A request made for an app to its declared hosts: anyone who can open apps (appAccessServer.ts checks the app's grant).
  ['/studio/api/apps/net/', { kind: 'features', features: ['panel:apps'] }],
  ['/studio/api/cms-connections', { kind: 'features', features: ['settings:cms'] }],
  ['/studio/api/media-connections', { kind: 'features', features: ['settings:cms'] }],
  ['/studio/api/media-hosting/', { kind: 'features', features: ['panel:assets'] }],
  ['/studio/api/cms-remote/', { kind: 'features', features: ['panel:cms'] }],
  ['/studio/api/cms', { kind: 'features', features: ['panel:cms'] }],
  ['/studio/api/git/', { kind: 'features', features: ['panel:history'] }],
  ['/studio/api/history/', { kind: 'features', features: ['panel:history'] }],
  ['/studio/api/ai/', { kind: 'features', features: ['panel:ai'] }],
];

/** The rule for a request, or undefined when it is a read or an ungated path. */
export function routeRule(method: string | undefined, pathname: string): RouteRule | undefined {
  if (method === 'GET' || method === 'HEAD' || method === undefined) {
    return undefined;
  }
  const exact = EXACT.get(pathname);
  if (exact !== undefined) {
    return exact;
  }
  return PREFIXES.find(([prefix]) => pathname.startsWith(prefix))?.[1];
}

/** The features a metadata write needs, from its parsed body. */
export function metadataFeatures(body: string): readonly AccessFeature[] | undefined {
  const input: unknown = JSON.parse(body);
  const kind = metadataKind(typeof input === 'object' && input !== null && 'kind' in input ? input.kind : undefined);
  return METADATA_ACCESS[kind];
}

/** The role of the person who sent `request`. */
export async function requestRole(root: string, request: Pick<IncomingMessage, 'headers'>): Promise<RoleView> {
  if (!process.env['STUDIO_CONTAINER_TOKEN']) {
    return ADMIN_VIEW;
  }
  const header = request.headers['x-studio-user'];
  const login = parseGitHubLogin(typeof header === 'string' ? header : '');
  const stored = await readMetadataSource(root, 'roles');
  if (stored.source === undefined) {
    return ADMIN_VIEW;
  }
  try {
    return resolveRole(parseProjectRolesSource(stored.source), login, 'default');
  } catch {
    return roleViewOf(DEFAULT_PROJECT_ROLES, CLIENT_ROLE_ID);
  }
}

/** Throws when `role` may not use `rule` (with the request `body` for metadata writes). */
export function assertRouteAllowed(role: RoleView, rule: RouteRule, body: string): void {
  const features = rule.kind === 'metadata' ? metadataFeatures(body) : rule.features;
  if (features === undefined) {
    return;
  }
  if (features.some((feature) => can(role, feature))) {
    return;
  }
  throw roleRefusal(role);
}

/**
 * The role of a collaboration connection, resolved like an HTTP request's from
 * the upgrade request's headers and re-read at most every few seconds, so a
 * roles file saved while an editor is open applies to its next edits.
 */
export function connectionRole(root: string, request: Pick<IncomingMessage, 'headers'>): () => Promise<RoleView> {
  assert(root.length > 0, 'A connection belongs to a project');
  let cached: { readonly role: RoleView; readonly untilMs: number } | undefined;
  return async () => {
    const nowMs = Date.now();
    if (cached !== undefined && nowMs < cached.untilMs) {
      return cached.role;
    }
    const role = await requestRole(root, request);
    cached = { role, untilMs: nowMs + SERVER_ACCESS_LIMITS.connectionRoleCacheMs };
    assert(cached.untilMs > nowMs, 'A cached role expires in the future');
    return role;
  };
}
