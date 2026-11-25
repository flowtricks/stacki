// Goal: core owns every signed session, whichever provider signed the person in.
// Why one place: cookie signing, expiry, audience, SameSite/HttpOnly/Secure and sign-out are the
// security-critical part of authentication. Keeping them here, and never handing the secret to a
// provider, means a provider can only SAY who someone is; it cannot create a session for them.
//
// GitHub sessions keep the byte-for-byte payload they had before providers existed, so a session
// minted before an update still verifies after it. Other providers' sessions carry `v: 2`.
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { err, ok, type Result } from '../../../vendor/stacki/shared/core/result';
import { githubIdentity } from '../../../vendor/stacki/shared/properties/memberIdentity';
import { GITHUB_PROVIDER_ID, identityProvider, parsePerson, parseProviderId, type PersonClaims, type Principal } from './authProvider';
import { signClaims, signSession, verifyClaims, verifySession, type Identity } from './session';

export const SESSION_LIFETIME_MS = 28_800_000;
export const SESSION_LIFETIME_SECONDS = 28_800;
const PROVIDER_SESSION_VERSION = 2;

/** The audiences a person's session can be for; `login` is core's own short-lived sign-in step and never names a person. */
export type SessionAudience = Exclude<Identity['audience'], 'login'>;

/**
 * Signs `person` for `audience` until `expires`. The caller (core) has already validated the person
 * against the active provider; this refuses a GitHub identity without GitHub's own numeric id, so a
 * provider-shaped record can never become a GitHub session.
 */
export async function signPrincipal(person: PersonClaims, audience: SessionAudience, expires: number, secret: string): Promise<Result<string, string>> {
  assert(expires > Date.now(), 'A session is signed for the future');
  if (identityProvider(person.identity) === GITHUB_PROVIDER_ID) {
    if (person.github === undefined) {
      return err('A github identity needs its GitHub profile');
    }
    return ok(await signSession({ id: person.github.id, login: person.github.login, expires, audience }, secret));
  }
  const claims = {
    v: PROVIDER_SESSION_VERSION,
    identity: person.identity,
    name: person.name,
    ...(person.email === undefined ? {} : { email: person.email }),
    ...(person.avatarUrl === undefined ? {} : { avatarUrl: person.avatarUrl }),
    expires,
    audience,
  };
  return ok(await signClaims(claims, secret));
}

/** The verified, unexpired principal a token proves, or undefined. Never throws on a bad token. */
export async function verifyPrincipal(token: string, secret: string, audience: SessionAudience): Promise<Principal | undefined> {
  const github = await verifySession(token, secret, audience);
  if (github) {
    const identity = githubIdentity(github.login);
    if (!identity.ok) {
      return undefined;
    }
    return { identity: identity.value, name: github.login, github: { id: github.id, login: github.login }, expires: github.expires };
  }
  const claims = await verifyClaims(token, secret);
  if (!claims || claims['v'] !== PROVIDER_SESSION_VERSION || claims['audience'] !== audience) {
    return undefined;
  }
  const expires = claims['expires'];
  if (typeof expires !== 'number' || !Number.isSafeInteger(expires) || expires < Date.now()) {
    return undefined;
  }
  const namespace = parseProviderId(typeof claims['identity'] === 'string' ? claims['identity'].slice(0, claims['identity'].indexOf(':')) : '');
  if (!namespace.ok || namespace.value === GITHUB_PROVIDER_ID) {
    // A provider-shaped session can never name a GitHub person.
    return undefined;
  }
  const person = parsePerson(claims, namespace.value);
  return person.ok ? { ...person.value, expires } : undefined;
}
