// Goal: "Continue with Google": the Authorization Code flow with PKCE against Google's OpenID Connect endpoints.
// Identity `google:<verified lowercased email>`. Only an ID token whose `email_verified` is true is accepted, its signature
// is checked against Google's published keys, and a Workspace domain allow-list also requires the `hd` claim, because an
// address on your domain registered at a consumer Google account (no `hd`) is not controlled by your domain.
// Who may edit follows editorPolicy.ts: roles.json first, then the allow-lists.
import type { AuthProvider } from '../authProvider';
import { parseGoogleConfig, normalizeEmail } from './authConfig';
import type { BuiltInContext } from './builtIn';
import { createEditorPolicy } from './editorPolicy';
import { createJwksCache } from './jwks';
import { authorizationUrl, redeemCallback, type OidcClient, type OidcEndpoints } from './oidcFlow';
import { httpsAvatar, limitedRefusal, limitedStart, nameFromEmail, person, redirect, refuse, signInLimiter } from './providerCommon';
import { IDENTITY_LIMITS } from '../authProvider';

export const GOOGLE_ENDPOINTS = {
  authorization: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  keys: 'https://www.googleapis.com/oauth2/v3/certs',
  /** Google documents both spellings of the issuer. */
  issuers: ['https://accounts.google.com', 'accounts.google.com'],
} as const;

export function createGoogleProvider(context: BuiltInContext): AuthProvider {
  const parsed = parseGoogleConfig(context.environment);
  if (!parsed.ok) {
    throw new Error(`Studio AUTH_PROVIDER=google is misconfigured: ${parsed.error.join(' ')}`);
  }
  const config = parsed.value;
  const client: OidcClient = {
    providerId: 'google',
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    scopes: 'openid email profile',
    sessionSecret: context.sessionSecret,
    fetcher: context.fetcher,
    now: context.now,
    authorizationExtras: { prompt: 'select_account' },
  };
  const endpoints: OidcEndpoints = {
    issuers: GOOGLE_ENDPOINTS.issuers,
    authorizationEndpoint: GOOGLE_ENDPOINTS.authorization,
    tokenEndpoint: GOOGLE_ENDPOINTS.token,
    keys: createJwksCache({ uri: GOOGLE_ENDPOINTS.keys, fetcher: context.fetcher, now: context.now }),
    tokenAuthMethod: 'post',
  };
  const policy = createEditorPolicy({ policy: config.policy, roles: context.roles });
  const limiter = signInLimiter();
  return {
    id: 'google',
    displayName: 'Google',
    begin: async (request, flow) => limitedStart(limiter, request, 'Google') ?? redirect(await authorizationUrl(client, endpoints, flow)),
    identify: async (request, flow) => {
      const limited = limitedRefusal(limiter, request, context.now());
      if (limited !== undefined) {
        return refuse(limited);
      }
      const redeemed = await redeemCallback(client, endpoints, request, flow);
      if (!redeemed.ok) {
        return refuse(redeemed.error);
      }
      const claims = redeemed.value;
      const email = claims.email === undefined ? undefined : normalizeEmail(claims.email);
      if (email === undefined || !claims.emailVerified || `google:${email}`.length > IDENTITY_LIMITS.identityCharsMax) {
        return refuse({ problem: 'email' });
      }
      const domain = email.slice(email.indexOf('@') + 1);
      const hostedDomain = claims.hostedDomain?.toLowerCase();
      // `hd` names the Workspace that owns the account; it must agree with the address, and a listed domain must have it.
      if (hostedDomain !== undefined && hostedDomain !== domain) {
        return refuse({ problem: 'access', reference: 'hd-mismatch' });
      }
      if (config.policy.allowedDomains.includes(domain) && hostedDomain !== domain) {
        return refuse({ problem: 'access', reference: 'hd-missing' });
      }
      return person({ identity: `google:${email}`, name: claims.name ?? nameFromEmail(email), email, avatarUrl: httpsAvatar(claims.picture) });
    },
    canEdit: policy.canEdit,
    canManage: policy.canManage,
  };
}
