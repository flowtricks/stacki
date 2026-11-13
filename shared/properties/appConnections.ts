// Stacki connections (docs/apps.md, "Connections"): OAuth providers Stacki has
// registered itself, so a person connects an app's account with one click and
// never creates an OAuth client or pastes a key. A manifest names one as
// `auth: [{ provider: 'google', scopes: [...] }]`.
//
// Who holds what:
// - This registry (public): each provider's endpoints, the scopes Stacki's
//   registered app may ask for, and whether the provider takes PKCE itself.
// - The broker on stacki.build (the marketing site's Worker,
//   worker/oauth/providers.ts, which must match this file): the client ids and
//   client secrets, and a fixed redirect, `/api/oauth/<provider>/callback`. It
//   checks the requested scopes against the same allowlist, exchanges and
//   refreshes codes with the secret, and keeps nothing: no code, no token.
// - The editor (electron/project/appSignIn.ts): the PKCE verifier, and the
//   tokens, sealed in the same vault as secret settings.
//
// The flow binds every step to this editor without any state on the broker:
// the editor sends the broker a PKCE challenge, its own state and its loopback
// return address; the broker signs them into a handoff that rides the
// provider's `state`; the provider returns to the broker, which sends the
// browser on to the editor's loopback listener with the code, the editor's
// state and the handoff; the editor posts the code, the handoff and its
// verifier to the broker, which exchanges the code only when the verifier
// matches the signed challenge. A code seen in transit is useless without the
// verifier, which never leaves the editor except to the broker over TLS.
import { assert } from '../core/assert';

export const STACKI_CONNECTION_PROVIDER_IDS = ['google', 'hubspot'] as const;
export type StackiConnectionProviderId = (typeof STACKI_CONNECTION_PROVIDER_IDS)[number];

export interface StackiConnectionProvider {
  readonly label: string;
  readonly authorizeURL: string;
  readonly tokenURL: string;
  /** Whether the provider itself takes PKCE; the broker enforces PKCE for every provider either way. */
  readonly pkce: boolean;
  readonly authorizeParams: Readonly<Record<string, string>>;
  /** The scopes Stacki's registered app may ask for; a manifest asks for a subset. */
  readonly scopes: readonly string[];
  /**
   * Whether an installer's own client for this provider can sign in through Stacki's random-port
   * loopback (RFC 8252 §7.3). HubSpot registers exact redirect URLs only, so its custom clients cannot;
   * a HubSpot app signs in through the broker's fixed redirect.
   */
  readonly loopbackClients: boolean;
}

/** Must match worker/oauth/providers.ts in the marketing site. */
export const STACKI_CONNECTION_PROVIDERS: { readonly [P in StackiConnectionProviderId]: StackiConnectionProvider } = {
  google: {
    label: 'Google', // i18n-ignore: brand name of the provider.
    authorizeURL: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenURL: 'https://oauth2.googleapis.com/token',
    pkce: true,
    loopbackClients: true,
    authorizeParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    scopes: ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/analytics.readonly', 'https://www.googleapis.com/auth/webmasters.readonly'],
  },
  hubspot: {
    label: 'HubSpot', // i18n-ignore: brand name of the provider.
    authorizeURL: 'https://app.hubspot.com/oauth/authorize',
    tokenURL: 'https://api.hubapi.com/oauth/v1/token',
    pkce: false,
    loopbackClients: false,
    authorizeParams: {},
    scopes: [
      'oauth',
      'crm.objects.contacts.read',
      'crm.objects.contacts.write',
      'crm.objects.companies.read',
      'crm.objects.deals.read',
      'forms',
      'content',
      // Meeting links (the meetings scheduler), read-only.
      'scheduler.meetings.meeting-link.read',
    ],
  },
};

/** Where the broker runs in a release. A development build may point elsewhere (`STACKI_OAUTH_BROKER`, e.g. `wrangler dev`). */
export const STACKI_BROKER_ORIGIN = 'https://stacki.build';

export function isStackiConnectionProvider(input: unknown): input is StackiConnectionProviderId {
  return STACKI_CONNECTION_PROVIDER_IDS.some((id) => id === input);
}

/** The broker's routes for one provider. */
export function brokerRoutes(
  origin: string,
  provider: StackiConnectionProviderId,
): { readonly start: string; readonly token: string; readonly refresh: string; readonly status: string } {
  const base = `${parseBrokerOrigin(origin)}/api/oauth/${provider}`;
  return { start: `${base}/start`, token: `${base}/token`, refresh: `${base}/refresh`, status: `${base}/status` };
}

/** A broker origin: https, or http on the loopback address for a local `wrangler dev`. No path. */
export function parseBrokerOrigin(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('The connections broker is not a URL');
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('The connections broker is https, or http on this computer');
  }
  assert(url.origin.length > 0, 'A broker has an origin');
  return url.origin;
}

/**
 * The broker a host uses: stacki.build in a release, always; a development build or a local Studio may
 * point at a local `wrangler dev` with `STACKI_OAUTH_BROKER`, so the flow is testable without deploying.
 */
export function stackiBrokerOrigin(environment: Readonly<Record<string, string | undefined>>, build: 'release' | 'development'): string {
  const override = environment['STACKI_OAUTH_BROKER'];
  if (build === 'release' || override === undefined || override === '') {
    return STACKI_BROKER_ORIGIN;
  }
  return parseBrokerOrigin(override);
}
