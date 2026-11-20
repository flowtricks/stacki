// Goal: the Authorization Code flow with PKCE, shared by the Google and SSO (OIDC) providers.
// The browser leaves for the identity service in `begin` and returns to `/studio/auth/<id>/callback` where core checks
// `state` and calls `identify`, which exchanges the code and validates the ID token (jwt.ts) before saying who signed in.
// Where the PKCE verifier and nonce live: nowhere. A provider cannot set a cookie, and a Durable Object may restart while
// the person is signing in, so both are derived from the one-time `state` with an HMAC keyed by the session secret. Only
// this Worker can recompute them; the identity service sees only the verifier's hash and the nonce.
// Never logged: codes, tokens, secrets, and the identity service's response bodies.
import { err, ok, type Result } from '../../../../vendor/stacki/shared/core/result';
import type { SignInRefusal } from '../authProvider';
import { encodeBase64url, hmacSha256, sha256, utf8Bytes } from './base64url';
import { fetchJson, FETCH_LIMITS, type Fetcher } from './boundedFetch';
import { parseJwt, validateIdTokenClaims, verifyJwtSignature, type IdTokenClaims } from './jwt';
import type { JwksCache } from './jwks';

export const OIDC_LIMITS = {
  codeCharsMax: 2_048,
  tokenCharsMax: 16_384,
} as const satisfies Record<string, number>;

export type TokenAuthMethod = 'basic' | 'post' | 'none';

export interface OidcEndpoints {
  /** Exact `iss` values the ID token may carry. */
  readonly issuers: readonly string[];
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly keys: JwksCache;
  readonly tokenAuthMethod: TokenAuthMethod;
}

export interface OidcClient {
  readonly providerId: string;
  readonly clientId: string;
  readonly clientSecret: string | undefined;
  readonly scopes: string;
  readonly sessionSecret: string;
  readonly fetcher: Fetcher;
  readonly now: () => number;
  /** Extra authorization parameters, such as Google's `prompt`. */
  readonly authorizationExtras: Readonly<Record<string, string>>;
}

/** A value only this Worker can recompute for this sign-in: 32 bytes as base64url (43 characters, a valid PKCE verifier). */
export async function flowValue(client: Pick<OidcClient, 'providerId' | 'sessionSecret'>, purpose: 'verifier' | 'nonce', state: string): Promise<string> {
  const key = await hmacSha256(client.sessionSecret, `stacki:oidc:${client.providerId}:${purpose}`);
  const derived = await hmacSha256(encodeBase64url(key), state);
  return encodeBase64url(derived);
}

export async function authorizationUrl(
  client: OidcClient,
  endpoints: OidcEndpoints,
  flow: { readonly callbackUrl: string; readonly state: string },
): Promise<string> {
  const verifier = await flowValue(client, 'verifier', flow.state);
  const nonce = await flowValue(client, 'nonce', flow.state);
  const url = new URL(endpoints.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', client.clientId);
  url.searchParams.set('redirect_uri', flow.callbackUrl);
  url.searchParams.set('scope', client.scopes);
  url.searchParams.set('state', flow.state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', encodeBase64url(await sha256(utf8Bytes(verifier))));
  url.searchParams.set('code_challenge_method', 'S256');
  for (const [name, value] of Object.entries(client.authorizationExtras)) {
    url.searchParams.set(name, value);
  }
  return url.href;
}

/** The ID token's claims for the callback `request`, or the refusal core shows. */
export async function redeemCallback(
  client: OidcClient,
  endpoints: OidcEndpoints,
  request: Request,
  flow: { readonly callbackUrl: string; readonly state: string },
): Promise<Result<IdTokenClaims, SignInRefusal>> {
  const url = new URL(request.url);
  const denied = url.searchParams.get('error');
  if (denied !== null) {
    return err(denied === 'access_denied' ? { problem: 'cancelled' } : { problem: 'unavailable', reference: 'idp-error' });
  }
  const code = url.searchParams.get('code');
  if (code === null || code.length === 0 || code.length > OIDC_LIMITS.codeCharsMax) {
    return err({ problem: 'expired' });
  }
  const token = await exchangeCode(client, endpoints, code, flow);
  if (!token.ok) {
    return token;
  }
  return verifyIdToken(client, endpoints, token.value.idToken, token.value.accessToken, flow.state);
}

interface TokenAnswer {
  readonly idToken: string;
  readonly accessToken: string | undefined;
}

async function exchangeCode(
  client: OidcClient,
  endpoints: OidcEndpoints,
  code: string,
  flow: { readonly callbackUrl: string; readonly state: string },
): Promise<Result<TokenAnswer, SignInRefusal>> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: flow.callbackUrl,
    code_verifier: await flowValue(client, 'verifier', flow.state),
  });
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (endpoints.tokenAuthMethod === 'basic' && client.clientSecret !== undefined) {
    // RFC 6749 section 2.3.1: the id and secret are form-encoded before they are joined.
    headers['Authorization'] = `Basic ${btoa(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`)}`;
  } else {
    body.set('client_id', client.clientId);
    if (endpoints.tokenAuthMethod === 'post' && client.clientSecret !== undefined) {
      body.set('client_secret', client.clientSecret);
    }
  }
  const answer = await fetchJson(client.fetcher, endpoints.tokenEndpoint, { method: 'POST', headers, body: body.toString() });
  if (!answer.ok) {
    return err(refusalForFailure(answer.error));
  }
  const value = answer.value;
  const idToken: unknown = typeof value === 'object' && value !== null ? Reflect.get(value, 'id_token') : undefined;
  const accessToken: unknown = typeof value === 'object' && value !== null ? Reflect.get(value, 'access_token') : undefined;
  if (typeof idToken !== 'string' || idToken.length > OIDC_LIMITS.tokenCharsMax) {
    return err({ problem: 'unavailable', reference: 'token-missing' });
  }
  return ok({ idToken, accessToken: typeof accessToken === 'string' && accessToken.length <= OIDC_LIMITS.tokenCharsMax ? accessToken : undefined });
}

function refusalForFailure(failure: { readonly kind: string; readonly status?: number }): SignInRefusal {
  if (failure.kind === 'status') {
    // 400/401 from a token endpoint: an expired or reused code (invalid_grant) or wrong client credentials. Both are shown as
    // a prompt to sign in again; a wrong secret is the owner's to find from the reference.
    if (failure.status === 400 || failure.status === 401) {
      return { problem: failure.status === 400 ? 'expired' : 'configuration', reference: `token-${failure.status}` };
    }
    if (failure.status === 429) {
      return { problem: 'rate-limit', retryAtMs: Date.now() + 30_000 };
    }
    return { problem: 'unavailable', reference: `token-${failure.status ?? 0}` };
  }
  return { problem: 'unavailable', reference: `token-${failure.kind}` };
}

async function verifyIdToken(
  client: OidcClient,
  endpoints: OidcEndpoints,
  idToken: string,
  accessToken: string | undefined,
  state: string,
): Promise<Result<IdTokenClaims, SignInRefusal>> {
  const parsed = parseJwt(idToken);
  if (!parsed.ok) {
    return err({ problem: 'unavailable', reference: `idtoken-${parsed.error}` });
  }
  const key = await endpoints.keys.keyFor(parsed.value.kid, parsed.value.algorithm);
  if (!key.ok) {
    return err({ problem: 'unavailable', reference: `idtoken-${key.error}` });
  }
  if (!(await verifyJwtSignature(parsed.value, key.value))) {
    return err({ problem: 'unavailable', reference: 'idtoken-signature' });
  }
  const claims = await validateIdTokenClaims(parsed.value.payload, {
    issuers: endpoints.issuers,
    audience: client.clientId,
    nonce: await flowValue(client, 'nonce', state),
    nowMs: client.now(),
    accessToken,
  });
  return claims.ok ? ok(claims.value) : err({ problem: 'unavailable', reference: `idtoken-${claims.error}` });
}

export { FETCH_LIMITS };
