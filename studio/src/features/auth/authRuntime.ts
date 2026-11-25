// Goal: the one object the Worker asks every authentication question of, whichever provider is installed.
// Core code (worker.ts, authRoutes.ts, the container authorization route) depends on this and on the
// interface in authProvider.ts, never on GitHub. Every provider answer is checked here before it is used,
// so a provider cannot skip a permission check, widen what core allows, or sign anyone in as another person.
import { assert } from '../../../vendor/stacki/shared/core/assert';
import {
  identityProvider,
  parseAliases,
  parseProviderId,
  validateAuthProvider,
  type AuthProvider,
  type PersonClaims,
  type Principal,
  type ProviderId,
} from './authProvider';
import { cookie } from './session';
import { signPrincipal, verifyPrincipal, type SessionAudience } from './principalSession';

/** The cookie that carries each audience's session. Fixed names: nothing a provider supplies reaches a cookie. */
export const SESSION_COOKIES = { studio: '__Host-studio', preview: '__Host-studio-preview' } as const;

export interface AuthRuntime {
  readonly provider: AuthProvider;
  readonly providerId: ProviderId;
  /** True for the provider that ships with Studio, false for one installed from `studio/cloudflare/auth-provider.ts`. */
  readonly installed: 'built-in' | 'custom';
  readonly origin: string;
  readonly secret: string;
  /** `EDITOR_ACCESS`: for a provider without its own `canEdit`, only `authenticated` admits anyone. */
  readonly editorAccess: string | undefined;
}

export interface AuthRuntimeInput {
  readonly provider: unknown;
  readonly installed: AuthRuntime['installed'];
  readonly origin: string;
  readonly secret: string;
  readonly editorAccess: string | undefined;
}

/** The runtime for a provider, or a programmer error when the provider does not satisfy the interface. */
export function createAuthRuntime(input: AuthRuntimeInput): AuthRuntime {
  const validated = validateAuthProvider(input.provider, input.installed === 'custom' ? 'custom' : 'built-in');
  if (!validated.ok) {
    throw new Error(`Invalid Studio auth provider: ${validated.error}`);
  }
  assert(input.secret.length >= 32, 'The session secret has at least 32 characters');
  assert(input.origin.length > 0, 'The Studio origin is configured');
  const providerId = parseProviderId(validated.value.id);
  assert(providerId.ok, 'A validated provider has a valid id');
  const runtime: AuthRuntime = {
    provider: validated.value,
    providerId: providerId.value,
    installed: input.installed,
    origin: input.origin,
    secret: input.secret,
    editorAccess: input.editorAccess,
  };
  return runtime;
}

/** The signed-in person the request's session cookie proves for `audience`, or undefined. */
export async function readPrincipal(runtime: AuthRuntime, request: Request, audience: SessionAudience): Promise<Principal | undefined> {
  return principalFromToken(runtime, cookie(request, SESSION_COOKIES[audience]), audience);
}

/** The person a session token proves, only when the active provider is the one that signed them in. */
export async function principalFromToken(runtime: AuthRuntime, token: string, audience: SessionAudience): Promise<Principal | undefined> {
  const principal = await verifyPrincipal(token, runtime.secret, audience);
  if (principal === undefined) {
    return undefined;
  }
  // A session from a provider that is no longer installed (the instance switched from GitHub to Google) proves nothing.
  return identityProvider(principal.identity) === runtime.providerId ? principal : undefined;
}

/** A signed session token for `person`, or a programmer error: core never signs a person it has not validated. */
export async function mintSession(runtime: AuthRuntime, person: PersonClaims, audience: SessionAudience, expires: number): Promise<string> {
  assert(identityProvider(person.identity) === runtime.providerId, 'Core signs only the active provider’s people');
  const token = await signPrincipal(person, audience, expires, runtime.secret);
  assert(token.ok, 'A validated person signs');
  return token.value;
}

/** Whether `principal` may edit this instance. A provider's answer counts only when it is exactly `true`. */
export async function mayEdit(runtime: AuthRuntime, principal: Principal, freshness: 'cached' | 'fresh'): Promise<boolean> {
  assert(identityProvider(principal.identity) === runtime.providerId, 'Only the active provider’s people are asked');
  if (runtime.provider.canEdit === undefined) {
    // Fail closed: a provider that states no policy admits nobody unless the owner chose "any verified person".
    return runtime.editorAccess === 'authenticated';
  }
  return (await runtime.provider.canEdit(principal, freshness)) === true;
}

/** Whether `principal` may manage the instance (CMS and media connections, Studio updates). Exactly `true`, else no. */
export async function mayManage(runtime: AuthRuntime, principal: Principal): Promise<boolean> {
  assert(identityProvider(principal.identity) === runtime.providerId, 'Only the active provider’s people are asked');
  if (runtime.provider.canManage === undefined) {
    return false;
  }
  return (await runtime.provider.canManage(principal)) === true;
}

/** Other identities of the same person that may match roles.json members: the provider's own namespace only. */
export function memberAliases(runtime: AuthRuntime, principal: Principal): readonly string[] {
  if (runtime.provider.memberKeys === undefined) {
    return [];
  }
  return parseAliases(runtime.provider.memberKeys(principal), runtime.providerId, principal.identity);
}
