// Goal: "Continue with <OIDC_NAME>": single sign-on with any standards-compliant OpenID Connect provider (Okta, Entra ID,
// Auth0, Keycloak, Google Workspace through OIDC). The provider's endpoints come from its discovery document, fetched over
// https and cached with bounds; the document's `issuer` must equal OIDC_ISSUER exactly, so a discovery answer cannot point
// Studio at another provider's keys.
// Identity rule, one and final: `oidc:<verified lowercased email>` when the ID token carries `email` with `email_verified`
// true, else `oidc:<sub>`. A `sub` that looks like an email is refused as a fallback, so an opaque id can never be mistaken
// for someone else's verified address.
import { err, ok, type Result } from '../../../../vendor/stacki/shared/core/result';
import { IDENTITY_LIMITS, type AuthProvider } from '../authProvider';
import { normalizeEmail, parseOidcConfig } from './authConfig';
import type { BuiltInContext } from './builtIn';
import { fetchJson, type Fetcher } from './boundedFetch';
import { createEditorPolicy } from './editorPolicy';
import { createJwksCache, type JwksCache } from './jwks';
import { authorizationUrl, redeemCallback, type OidcClient, type OidcEndpoints, type TokenAuthMethod } from './oidcFlow';
import { httpsAvatar, limitedRefusal, limitedStart, nameFromEmail, person, redirect, refuse, signInLimiter } from './providerCommon';

export const DISCOVERY_LIMITS = {
  cacheMs: 3_600_000,
  staleMs: 86_400_000,
  /** Wait between two attempts after a failure, so a down provider is not asked on every sign-in. */
  retryMs: 30_000,
} as const satisfies Record<string, number>;

export interface Discovered {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  readonly tokenAuthMethod: TokenAuthMethod;
}

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2_000) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '' ? value : undefined;
  } catch {
    return undefined;
  }
}

function strings(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > 64) {
    return undefined;
  }
  const items: readonly unknown[] = value;
  const found: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') {
      return undefined;
    }
    found.push(item);
  }
  return found;
}

/** The endpoints Studio needs from a discovery document, or why it is unusable. `issuer` must match the configured one exactly. */
export function parseDiscovery(input: unknown, issuer: string, hasSecret: boolean): Result<Discovered, string> {
  if (typeof input !== 'object' || input === null) {
    return err('The discovery document is not an object');
  }
  const field = (name: string): unknown => Reflect.get(input, name);
  if (field('issuer') !== issuer) {
    return err('The discovery document names a different issuer than OIDC_ISSUER');
  }
  const authorizationEndpoint = httpsUrl(field('authorization_endpoint'));
  const tokenEndpoint = httpsUrl(field('token_endpoint'));
  const jwksUri = httpsUrl(field('jwks_uri'));
  if (authorizationEndpoint === undefined || tokenEndpoint === undefined || jwksUri === undefined) {
    return err('The discovery document lacks an https authorization_endpoint, token_endpoint or jwks_uri');
  }
  const algorithms = field('id_token_signing_alg_values_supported');
  if (algorithms !== undefined && !(strings(algorithms) ?? []).some((name) => name === 'RS256' || name === 'ES256')) {
    return err('The provider signs ID tokens with neither RS256 nor ES256');
  }
  const challenges = field('code_challenge_methods_supported');
  if (challenges !== undefined && !(strings(challenges) ?? []).includes('S256')) {
    return err('The provider does not support PKCE S256');
  }
  const methods = strings(field('token_endpoint_auth_methods_supported'));
  // Per the specification an absent list means client_secret_basic.
  const tokenAuthMethod: TokenAuthMethod = !hasSecret ? 'none' : methods === undefined || methods.includes('client_secret_basic') ? 'basic' : 'post';
  if (hasSecret && methods !== undefined && !methods.includes('client_secret_basic') && !methods.includes('client_secret_post')) {
    return err('The provider accepts neither client_secret_basic nor client_secret_post');
  }
  return ok({ authorizationEndpoint, tokenEndpoint, jwksUri, tokenAuthMethod });
}

export interface DiscoveryCache {
  readonly get: () => Promise<Result<{ readonly discovered: Discovered; readonly keys: JwksCache }, string>>;
}

export function createDiscoveryCache(options: {
  readonly issuer: string;
  readonly hasSecret: boolean;
  readonly fetcher: Fetcher;
  readonly now: () => number;
}): DiscoveryCache {
  let current: { readonly discovered: Discovered; readonly keys: JwksCache; readonly at: number } | undefined;
  let failedAt = 0;
  let loading: Promise<void> | undefined;
  const url = `${options.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const refresh = (): Promise<void> => {
    loading ??= (async () => {
      const answer = await fetchJson(options.fetcher, url, { headers: { Accept: 'application/json' } });
      const parsed = answer.ok ? parseDiscovery(answer.value, options.issuer, options.hasSecret) : undefined;
      if (parsed?.ok === true) {
        const keys =
          current?.discovered.jwksUri === parsed.value.jwksUri
            ? current.keys
            : createJwksCache({ uri: parsed.value.jwksUri, fetcher: options.fetcher, now: options.now });
        current = { discovered: parsed.value, keys, at: options.now() };
      } else {
        failedAt = options.now();
      }
      loading = undefined;
    })();
    return loading;
  };
  return {
    get: async () => {
      const fresh = current !== undefined && options.now() - current.at < DISCOVERY_LIMITS.cacheMs;
      if (!fresh && (current === undefined || options.now() - failedAt >= DISCOVERY_LIMITS.retryMs)) {
        await refresh();
      }
      if (current === undefined || options.now() - current.at >= DISCOVERY_LIMITS.staleMs) {
        return err('The provider’s discovery document could not be read');
      }
      return ok({ discovered: current.discovered, keys: current.keys });
    },
  };
}

export function createOidcProvider(context: BuiltInContext): AuthProvider {
  const parsed = parseOidcConfig(context.environment);
  if (!parsed.ok) {
    throw new Error(`Studio AUTH_PROVIDER=oidc is misconfigured: ${parsed.error.join(' ')}`);
  }
  const config = parsed.value;
  const client: OidcClient = {
    providerId: 'oidc',
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    scopes: config.scopes,
    sessionSecret: context.sessionSecret,
    fetcher: context.fetcher,
    now: context.now,
    authorizationExtras: {},
  };
  const discovery = createDiscoveryCache({ issuer: config.issuer, hasSecret: config.clientSecret !== undefined, fetcher: context.fetcher, now: context.now });
  const policy = createEditorPolicy({ policy: config.policy, roles: context.roles });
  const limiter = signInLimiter();
  const endpointsFor = async (): Promise<OidcEndpoints | undefined> => {
    const found = await discovery.get();
    if (!found.ok) {
      return undefined;
    }
    return {
      issuers: [config.issuer],
      authorizationEndpoint: found.value.discovered.authorizationEndpoint,
      tokenEndpoint: found.value.discovered.tokenEndpoint,
      keys: found.value.keys,
      tokenAuthMethod: found.value.discovered.tokenAuthMethod,
    };
  };
  return {
    id: 'oidc',
    displayName: config.buttonName,
    begin: async (request, flow) => {
      const limited = limitedStart(limiter, request, config.buttonName);
      if (limited !== undefined) {
        return limited;
      }
      const endpoints = await endpointsFor();
      if (endpoints === undefined) {
        throw new Error('OIDC discovery failed');
      }
      return redirect(await authorizationUrl(client, endpoints, flow));
    },
    identify: async (request, flow) => {
      const limited = limitedRefusal(limiter, request, context.now());
      if (limited !== undefined) {
        return refuse(limited);
      }
      const endpoints = await endpointsFor();
      if (endpoints === undefined) {
        return refuse({ problem: 'unavailable', reference: 'discovery' });
      }
      const redeemed = await redeemCallback(client, endpoints, request, flow);
      if (!redeemed.ok) {
        return refuse(redeemed.error);
      }
      const claims = redeemed.value;
      const email = claims.email === undefined || !claims.emailVerified ? undefined : normalizeEmail(claims.email);
      const subject = email ?? claims.subject;
      if (email === undefined && (claims.subject.includes('@') || /[\s,\u0000-\u001f\u007f]/u.test(claims.subject))) {
        // No verified email to name the person by, and the `sub` cannot be used safely.
        return refuse({ problem: 'email', reference: 'sub-unusable' });
      }
      if (`oidc:${subject}`.length > IDENTITY_LIMITS.identityCharsMax) {
        return refuse({ problem: 'unavailable', reference: 'subject-too-long' });
      }
      return person({
        identity: `oidc:${subject}`,
        name: claims.name ?? (email === undefined ? subject.slice(0, 40) : nameFromEmail(email)),
        email,
        avatarUrl: httpsAvatar(claims.picture),
      });
    },
    canEdit: policy.canEdit,
    canManage: policy.canManage,
  };
}
