// Goal: sign-in through Cloudflare Access. Access sits in front of the Worker's `/studio` route, authenticates the person
// with the organisation's own policy, and forwards a signed JWT in `Cf-Access-Jwt-Assertion`. This provider has no login
// of its own: `identify` verifies that JWT and nothing else.
// What is trusted: only the verified JWT (RS256 against the team's published keys, `iss` the team domain, `aud` the
// application's tag, expiry). Headers such as `Cf-Access-Authenticated-User-Email` are plain text any client can send
// when Access is not in front of the route, so they are never read.
// Identity `access:<lowercased email>`. A service token (no email) becomes `access:service-<client id>`; it can edit only
// when roles.json lists it and never manages unless roles.json makes it an admin.
import { err, ok } from '../../../../vendor/stacki/shared/core/result';
import { IDENTITY_LIMITS, type AuthProvider } from '../authProvider';
import { stackiFavicon } from '../../../shared/stackiBrand';
import { translatorForLanguages } from '../../../shared/requestTranslate';
import { normalizeEmail, parseAccessConfig } from './authConfig';
import type { BuiltInContext } from './builtIn';
import { createEditorPolicy } from './editorPolicy';
import { createJwksCache } from './jwks';
import { parseJwt, validateIdTokenClaims, verifyJwtSignature, type JwtFailure } from './jwt';
import { limitedRefusal, limitedStart, nameFromEmail, person, redirect, refuse, signInLimiter } from './providerCommon';

export const ACCESS_HEADER = 'Cf-Access-Jwt-Assertion';

export function createAccessProvider(context: BuiltInContext): AuthProvider {
  const parsed = parseAccessConfig(context.environment);
  if (!parsed.ok) {
    throw new Error(`Studio AUTH_PROVIDER=access is misconfigured: ${parsed.error.join(' ')}`);
  }
  const config = parsed.value;
  const issuer = `https://${config.teamDomain}`;
  const keys = createJwksCache({ uri: `${issuer}/cdn-cgi/access/certs`, fetcher: context.fetcher, now: context.now });
  const policy = createEditorPolicy({ policy: config.policy, roles: context.roles });
  const limiter = signInLimiter();

  // The verified claims of the request's Access JWT, or why there are none.
  const verify = async (request: Request) => {
    const token = request.headers.get(ACCESS_HEADER);
    if (token === null) {
      return err('missing' as const);
    }
    const jwt = parseJwt(token);
    if (!jwt.ok) {
      return err(jwt.error);
    }
    // Access signs with RS256 only; an ES256 token is not one of its.
    if (jwt.value.algorithm !== 'RS256') {
      return err('algorithm' as const);
    }
    const key = await keys.keyFor(jwt.value.kid, 'RS256');
    if (!key.ok) {
      return err(key.error);
    }
    if (!(await verifyJwtSignature(jwt.value, key.value))) {
      return err('signature' as const);
    }
    const claims = await validateIdTokenClaims(jwt.value.payload, {
      issuers: [issuer],
      audience: config.audience,
      nonce: undefined,
      nowMs: context.now(),
      subjectOptional: true,
    });
    return claims.ok ? ok({ claims: claims.value, payload: jwt.value.payload }) : err(claims.error);
  };

  return {
    id: 'access',
    displayName: 'Cloudflare Access',
    begin: async (request, flow) => {
      const limited = limitedStart(limiter, request, 'Cloudflare Access');
      if (limited !== undefined) {
        return limited;
      }
      const checked = await verify(request);
      if (!checked.ok) {
        console.error('Cloudflare Access did not authenticate this request', { reason: failureName(checked.error) });
        return notAuthenticatedPage(request, failureName(checked.error));
      }
      // Access already authenticated the person; the callback only has to be reached with core's state.
      return redirect(`${flow.callbackUrl}?state=${encodeURIComponent(flow.state)}`);
    },
    identify: async (request) => {
      const limited = limitedRefusal(limiter, request, context.now());
      if (limited !== undefined) {
        return refuse(limited);
      }
      const checked = await verify(request);
      if (!checked.ok) {
        return refuse({ problem: checked.error === 'missing' ? 'configuration' : 'unavailable', reference: `access-${failureName(checked.error)}` });
      }
      const { claims, payload } = checked.value;
      const email = claims.email === undefined ? undefined : normalizeEmail(claims.email);
      if (email !== undefined) {
        return `access:${email}`.length > IDENTITY_LIMITS.identityCharsMax
          ? refuse({ problem: 'email' })
          : person({ identity: `access:${email}`, name: claims.name ?? nameFromEmail(email), email });
      }
      const commonName = payload['common_name'];
      const service =
        typeof commonName === 'string'
          ? commonName
              .toLowerCase()
              .replace(/[^a-z0-9._-]/g, '')
              .slice(0, 100)
          : '';
      if (service.length === 0 || claims.email !== undefined) {
        return refuse({ problem: 'email', reference: 'access-no-email' });
      }
      return person({ identity: `access:service-${service}`, name: `Service token ${service}`.slice(0, 100) });
    },
    canEdit: policy.canEdit,
    canManage: policy.canManage,
  };
}

function failureName(reason: JwtFailure | 'missing' | 'unavailable' | 'key-unknown'): string {
  return reason;
}

// Shown instead of a sign-in button: without a verified Access JWT the request did not come through Access, so a button
// could only loop. The page says what to check and keeps the reason code for the owner (never the token).
function notAuthenticatedPage(request: Request, reason: string): Response {
  const { locale, translate } = translatorForLanguages(request.headers.get('Accept-Language'));
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const html = `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(translate('studio.login.title'))}</title><link rel="icon" type="image/svg+xml" href="${stackiFavicon}"><style>body{background:#111;color:#eee;font:14px system-ui;display:grid;place-items:center;min-height:100dvh;margin:0}main{max-width:32rem;padding:24px;text-align:center}p{color:#999;line-height:1.6}</style></head><body><main><h1>${escape(translate('studio.login.failedHeading'))}</h1><p>${escape(translate('studio.access.notInFront'))}</p><p>${escape(translate('studio.login.reference', { reference: reason.replace(/[^a-z0-9-]/g, '') }))}</p></main></body></html>`;
  return new Response(html, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'none'",
    },
  });
}
