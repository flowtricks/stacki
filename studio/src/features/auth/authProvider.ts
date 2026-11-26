// The authentication-provider interface: the one seam an instance owner or fork uses to sign
// people in with something other than GitHub (Google, email codes, SSO, passkeys) without
// touching Studio core. Experimental: it may change in minor versions (docs/auth-providers.md).
//
// The split, and why it is drawn here:
//   - A provider PROVES WHO SOMEONE IS. It owns the sign-in routes (`begin`, `identify`), talks to
//     its identity service, and answers with a provider-qualified identity and display details.
//   - Core DECIDES WHAT THAT PERSON MAY DO. It owns the state/CSRF check, the signed session
//     cookie (signing, expiry, flags, preview tokens, sign-out), the roles check, and every
//     response header. A provider never sees the session secret and never writes a cookie, so it
//     cannot mint a session for anyone, skip a permission check, or sign someone in as another
//     provider's person (core rejects an identity outside the provider's own namespace).
//   - A provider may add a policy (`canEdit`, `canManage`) and extra role names (`memberKeys`);
//     core still applies roles.json on top. A provider can narrow access, never widen core's rules.
//
// Everything a provider returns is untrusted input to core and is parsed by `parsePerson`,
// `parseAliases` and `validateAuthProvider` below before it is used (AGENTS.md §2).
import { err, ok, type Result } from '../../../vendor/stacki/shared/core/result';
import {
  GITHUB_PROVIDER_ID,
  IDENTITY_LIMITS,
  identityProvider,
  parseProviderId,
  parseQualifiedIdentity,
  type ProviderId,
  type QualifiedIdentity,
} from '../../../vendor/stacki/shared/properties/memberIdentity';
import type { SignInProblem } from './signInFailure';
import type { GitHubProfile } from './profile';

export { GITHUB_PROVIDER_ID, IDENTITY_LIMITS, identityProvider, parseProviderId, parseQualifiedIdentity };
export type { ProviderId, QualifiedIdentity, SignInProblem };

// The bounds live beside the parsers that enforce them (AGENTS.md §10).
export const AUTH_LIMITS = {
  /** The hint shown in the Roles panel's invite form for a custom provider's identifier field. */
  inviteHintCharsMax: 80,
  /** The sentence a person reads on the sign-in button: "Continue with <name>". */
  displayNameCharsMax: 40,
  /** A signed-in person's name in the account menu and presence. */
  personNameCharsMax: 100,
  /** An email address (RFC 5321). */
  emailCharsMax: 254,
  avatarUrlCharsMax: 500,
  /** Other identities of the same person, all in the provider's own namespace. */
  aliasesMax: 8,
  /** A safe failure reference shown on the sign-in page. */
  referenceCharsMax: 80,
  /** The longest wait a provider may ask a visitor to honour: a bad value must never lock someone out for days. */
  retryWaitMsMax: 3_600_000,
} as const satisfies Record<string, number>;

/** Who is signed in, as core holds it after validation. `github` exists only for the built-in provider. */
export interface PersonClaims {
  readonly identity: QualifiedIdentity;
  readonly name: string;
  readonly email?: string;
  readonly avatarUrl?: string;
  readonly github?: GitHubProfile;
}

/** A verified, unexpired session: the person plus when core's session for them ends (epoch ms). */
export interface Principal extends PersonClaims {
  readonly expires: number;
}

/** What a provider hands back when it has verified someone. Core parses every field again. */
export interface ProviderPerson {
  readonly identity: string;
  readonly name: string;
  readonly email?: string;
  readonly avatarUrl?: string;
  /** Built-in GitHub provider only: GitHub's numeric id and login. Core ignores it from any other provider. */
  readonly github?: GitHubProfile;
}

/** An expected sign-in failure (denied, expired code, upstream down, rate limited): a value, not a throw. */
export interface SignInRefusal {
  readonly problem: SignInProblem;
  /** A short code for the safe reference on the page, such as `token-502`. Letters, digits, `_` and `-` only. */
  readonly reference?: string;
  /** For `rate-limit`: epoch ms before which the visitor should not try again. Clamped by core. */
  readonly retryAtMs?: number;
}

/** What core hands a provider for one sign-in step. */
export interface SignInFlow {
  /** `https://<studio>/studio/auth/callback`: where the identity service must send the person back. */
  readonly callbackUrl: string;
  /**
   * The one-time state value. `begin` must carry it to the identity service and the service must return it
   * as the `state` query parameter of the callback URL; core compares it with the signed cookie it set
   * and refuses the callback before `identify` runs if it differs. `identify` receives the matching value.
   */
  readonly state: string;
  /** The visitor's `Accept-Language`, for any text the provider shows. */
  readonly languages: string | undefined;
}

export type FreshnessRequest = 'cached' | 'fresh';

export interface AuthProvider {
  /** Lowercase letters, digits and hyphens. Becomes the prefix of every identity. `github` is reserved for the built-in provider. */
  readonly id: string;
  /** Shown on the sign-in page as "Continue with <displayName>". Plain text, at most 40 characters. */
  readonly displayName: string;
  /**
   * Start sign-in (GET `/studio/auth/login`): usually a redirect to the identity service, or a page with a form.
   * Core strips any `Set-Cookie`, forces `Cache-Control: no-store`, and has already set the state cookie.
   */
  readonly begin: (request: Request, flow: SignInFlow) => Promise<Response>;
  /**
   * Finish sign-in (GET `/studio/auth/callback`, or POST from the Studio origin): verify the proof in the
   * request and say who the person is. Runs only after core verified `state`. Never writes a session.
   */
  readonly identify: (request: Request, flow: SignInFlow) => Promise<Result<ProviderPerson, SignInRefusal>>;
  /**
   * Optional extra routes under `/studio/auth/provider/` (a form POST that sends a code, a passkey challenge).
   * Return undefined for a path you do not own. Core enforces the Studio origin on every non-GET request, strips
   * `Set-Cookie` and caches nothing. `flow.state` is the person's current sign-in state; put it in any link you
   * email or redirect to, so the callback can be tied to the browser that started it.
   */
  readonly handle?: (request: Request, flow: SignInFlow) => Promise<Response | undefined>;
  /**
   * Whether this person may edit this instance, called on sign-in (`fresh`) and on every request (`cached`:
   * a recent answer is fine, so a provider that asks a remote service should cache briefly).
   * Omitted: nobody may edit unless the instance sets `EDITOR_ACCESS` to `authenticated` (any verified person).
   * Roles in `.stacki/roles.json` still decide WHAT an allowed person may do.
   */
  readonly canEdit?: (principal: Principal, freshness: FreshnessRequest) => Promise<boolean>;
  /**
   * Whether this person may manage the instance itself: CMS and media connections and Studio updates.
   * Omitted: nobody. (The built-in provider answers with GitHub repository Write or Admin access.)
   */
  readonly canManage?: (principal: Principal) => Promise<boolean>;
  /**
   * Other identities the same person is known by, all in this provider's own namespace, matched against the
   * members of `.stacki/roles.json` roles in addition to `principal.identity` (for example the same person's
   * `email:` identity and the stable `google:<sub>` one). Core drops any alias outside the provider's namespace.
   */
  readonly memberKeys?: (principal: Principal) => readonly string[];
  /**
   * Optional, for the Roles panel's "Invite member" form of a CUSTOM provider: a short hint for the identifier field
   * ("work email", "employee number"). Plain text, at most 80 characters. Without it the form says "Identifier".
   */
  readonly inviteHint?: string;
  /**
   * Optional: turn what an admin typed into this provider's subject (lowercase an email, strip a prefix), or undefined when
   * it is not one. Core adds `<id>:<subject>` to roles.json only if the result parses as an identity in your namespace.
   * Without it the typed text is used as the subject after the same bounds every identity has.
   */
  readonly parseInviteIdentifier?: (input: string) => string | undefined;
}

/** What core gives a provider factory at startup. `environment` holds Worker vars and secrets minus core's own credentials. */
export interface AuthProviderSetup {
  readonly origin: string;
  readonly environment: Readonly<Record<string, unknown>>;
}

/** The default export of `studio/cloudflare/auth-provider.ts`. */
export type AuthProviderFactory = (setup: AuthProviderSetup) => AuthProvider;

/** Names core keeps out of the environment a provider sees: the session secret and every core credential. */
export const CORE_CREDENTIAL_NAMES: readonly string[] = [
  'SESSION_SECRET',
  'CONTAINER_TOKEN',
  'GITHUB_PRIVATE_KEY',
  'GITHUB_CLIENT_SECRET',
  'PUBLISH_CLOUDFLARE_API_TOKEN',
  'PUBLISH_VERCEL_TOKEN',
  'PUBLISH_NETLIFY_TOKEN',
  'AI_API_KEY',
  'PREVIEW',
  'DRAFTS',
  'ASSETS',
];

/** The provider's view of the Worker environment, without core credentials. */
export function providerEnvironment(environment: object): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !CORE_CREDENTIAL_NAMES.includes(name)));
}

// A property of untrusted output as `unknown`: `Reflect.get` is typed `any`, and an `any` must not flow on.
export function field(input: object, key: string): unknown {
  const value: unknown = Reflect.get(input, key);
  return value;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

/** A provider that has the shape core needs, or why not. Run once at startup and by the conformance kit. */
export function validateAuthProvider(input: unknown, origin: 'built-in' | 'custom'): Result<AuthProvider, string> {
  if (typeof input !== 'object' || input === undefined || input === null) {
    return err('The auth provider factory must return an object');
  }
  const id = parseProviderId(field(input, 'id'));
  if (!id.ok) {
    return err(`provider.id: ${id.error.message}`);
  }
  if (origin === 'custom' && id.value === GITHUB_PROVIDER_ID) {
    return err('provider.id: "github" is reserved for the built-in provider');
  }
  const displayName = field(input, 'displayName');
  if (
    typeof displayName !== 'string' ||
    displayName.length === 0 ||
    displayName.length > AUTH_LIMITS.displayNameCharsMax ||
    CONTROL_CHARACTERS.test(displayName)
  ) {
    return err(`provider.displayName: 1 to ${AUTH_LIMITS.displayNameCharsMax} printable characters`);
  }
  for (const required of ['begin', 'identify']) {
    if (typeof field(input, required) !== 'function') {
      return err(`provider.${required} must be a function`);
    }
  }
  for (const optional of ['handle', 'canEdit', 'canManage', 'memberKeys', 'parseInviteIdentifier']) {
    const value = field(input, optional);
    if (value !== undefined && typeof value !== 'function') {
      return err(`provider.${optional} must be a function when present`);
    }
  }
  const hint = field(input, 'inviteHint');
  if (hint !== undefined && (typeof hint !== 'string' || hint.length > AUTH_LIMITS.inviteHintCharsMax || CONTROL_CHARACTERS.test(hint))) {
    return err(`provider.inviteHint: at most ${AUTH_LIMITS.inviteHintCharsMax} printable characters`);
  }
  // The checks above prove each member's type; the interface is structural, so the checked object is the provider.
  return ok(input as AuthProvider);
}

/**
 * The person a provider vouched for, or why core refuses the answer. `provider` is the active provider's id:
 * an identity from any other namespace is refused, so a provider can never sign someone in as a person another
 * provider (or the built-in GitHub sign-in) owns. Unknown fields are dropped, never copied.
 */
export function parsePerson(input: unknown, provider: ProviderId): Result<PersonClaims, string> {
  if (typeof input !== 'object' || input === undefined || input === null) {
    return err('The provider returned no person');
  }
  const identity = parseQualifiedIdentity(field(input, 'identity'));
  if (!identity.ok) {
    return err(`identity: ${identity.error.message}`);
  }
  if (identityProvider(identity.value) !== provider) {
    return err('identity: it is outside the provider namespace');
  }
  const name = field(input, 'name');
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > AUTH_LIMITS.personNameCharsMax || CONTROL_CHARACTERS.test(name)) {
    return err(`name: 1 to ${AUTH_LIMITS.personNameCharsMax} printable characters`);
  }
  const email = optionalText(field(input, 'email'), AUTH_LIMITS.emailCharsMax);
  if (!email.ok) {
    return err('email: expected text of bounded length');
  }
  if (email.value !== undefined && !/^[^\s@,]+@[^\s@,]+$/u.test(email.value)) {
    return err('email: expected an address');
  }
  const avatar = optionalText(field(input, 'avatarUrl'), AUTH_LIMITS.avatarUrlCharsMax);
  if (!avatar.ok) {
    return err('avatarUrl: expected text of bounded length');
  }
  if (avatar.value !== undefined && !httpsUrl(avatar.value)) {
    return err('avatarUrl: expected an https URL');
  }
  const base = {
    identity: identity.value,
    name: name.trim(),
    ...(email.value === undefined ? {} : { email: email.value }),
    ...(avatar.value === undefined ? {} : { avatarUrl: avatar.value }),
  };
  if (provider !== GITHUB_PROVIDER_ID) {
    // `github` is dropped, not copied: only the built-in provider can name a GitHub person.
    return ok(base);
  }
  const github = field(input, 'github');
  if (typeof github !== 'object' || github === null) {
    return err('github: the built-in provider returns GitHub id and login');
  }
  const id = field(github, 'id');
  const login = field(github, 'login');
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || typeof login !== 'string' || !/^[\w-]{1,100}$/.test(login)) {
    return err('github: expected a numeric id and a login');
  }
  if (identity.value !== `${GITHUB_PROVIDER_ID}:${login}`) {
    return err('github: the identity must be github:<login>');
  }
  return ok({ ...base, github: { id, login } });
}

/** Aliases a provider listed, kept only when they are valid identities in its own namespace, at most `aliasesMax`. */
export function parseAliases(input: unknown, provider: ProviderId, primary: QualifiedIdentity): readonly QualifiedIdentity[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const kept: QualifiedIdentity[] = [];
  // Bounded by the slice: a hostile provider cannot make core read an unbounded list.
  for (const item of input.slice(0, AUTH_LIMITS.aliasesMax * 4)) {
    const parsed = parseQualifiedIdentity(item);
    if (parsed.ok && identityProvider(parsed.value) === provider && parsed.value !== primary && !kept.includes(parsed.value)) {
      kept.push(parsed.value);
    }
    if (kept.length >= AUTH_LIMITS.aliasesMax) {
      break;
    }
  }
  return kept;
}

/** A refusal, bounded and cleaned, from whatever the provider returned. Anything malformed becomes `unavailable`. */
export function parseRefusal(input: unknown, nowMs: number): SignInRefusal {
  if (typeof input !== 'object' || input === undefined || input === null) {
    return { problem: 'unavailable' };
  }
  const problem = field(input, 'problem');
  if (!isSignInProblem(problem)) {
    return { problem: 'unavailable' };
  }
  const reference = field(input, 'reference');
  const retry = field(input, 'retryAtMs');
  const cleaned = typeof reference === 'string' ? reference.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, AUTH_LIMITS.referenceCharsMax) : '';
  const retryAtMs = typeof retry === 'number' && Number.isSafeInteger(retry) ? Math.min(retry, nowMs + AUTH_LIMITS.retryWaitMsMax) : undefined;
  return {
    problem,
    ...(cleaned.length > 0 ? { reference: cleaned } : {}),
    ...(retryAtMs === undefined ? {} : { retryAtMs }),
  };
}

const SIGN_IN_PROBLEMS: readonly SignInProblem[] = ['expired', 'cancelled', 'configuration', 'unavailable', 'access', 'email', 'rate-limit'];

function isSignInProblem(value: unknown): value is SignInProblem {
  return SIGN_IN_PROBLEMS.some((problem) => problem === value);
}

function optionalText(value: unknown, maximum: number): Result<string | undefined, string> {
  if (value === undefined) {
    return ok(undefined);
  }
  if (typeof value !== 'string' || value.length > maximum) {
    return err('text');
  }
  return ok(value.length === 0 ? undefined : value);
}

function httpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}
