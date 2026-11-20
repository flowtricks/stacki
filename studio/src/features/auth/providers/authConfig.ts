// Goal: the configuration contract of the built-in providers, parsed once and reported the same way everywhere.
// `AUTH_PROVIDER` picks the provider; each provider's own variables follow (docs/auth-providers.md, "Built-in providers").
// The same functions run at build time (scripts/authProviderSlot.ts), at runtime (a misconfigured instance answers 503 and
// names the problem in its log) and in `astro-studio check-project`, so the three can never disagree about what is valid.
// A problem is a developer-facing sentence for the person who owns the instance, never shown on the sign-in page.
// i18n-ignore-file: configuration diagnostics for the instance owner.
import { err, ok, type Result } from '../../../../vendor/stacki/shared/core/result';
import { parseQualifiedIdentity, identityProvider, type QualifiedIdentity } from '../../../../vendor/stacki/shared/properties/memberIdentity';

export const BUILT_IN_PROVIDER_IDS = ['github', 'access', 'google', 'oidc', 'passkey'] as const;
export type BuiltInProviderId = (typeof BUILT_IN_PROVIDER_IDS)[number];

export const AUTH_CONFIG_LIMITS = {
  allowedEmailsMax: 200,
  allowedDomainsMax: 100,
  emailCharsMax: 200,
  domainCharsMax: 253,
  clientIdCharsMax: 300,
  scopesCharsMax: 300,
  buttonNameCharsMax: 40,
  issuerCharsMax: 300,
} as const satisfies Record<string, number>;

export type AuthEnvironment = Readonly<Record<string, unknown>>;

/** The provider the instance chose: absent or empty is GitHub; anything unknown is an error, never a silent fallback. */
export function parseAuthProviderId(value: unknown): Result<BuiltInProviderId, string> {
  if (value === undefined || value === '') {
    return ok('github');
  }
  const known = BUILT_IN_PROVIDER_IDS.find((id) => id === value);
  if (known === undefined) {
    return err(`AUTH_PROVIDER "${typeof value === 'string' ? value.slice(0, 40) : typeof value}" is unknown. Use one of: ${BUILT_IN_PROVIDER_IDS.join(', ')}.`);
  }
  return ok(known);
}

export interface PolicyConfig {
  readonly allowedEmails: readonly string[];
  readonly allowedDomains: readonly string[];
  readonly bootstrapAdmin: QualifiedIdentity;
  /** `EDITOR_ACCESS`: `authenticated` admits every verified person; `roles` ignores the allow-lists. */
  readonly editorAccess: string | undefined;
}

export interface GoogleConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly policy: PolicyConfig;
}

export interface OidcConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string | undefined;
  readonly scopes: string;
  readonly buttonName: string;
  readonly policy: PolicyConfig;
}

export interface AccessConfig {
  readonly teamDomain: string;
  readonly audience: string;
  readonly policy: PolicyConfig;
}

export interface PasskeyConfig {
  readonly bootstrapAdmin: QualifiedIdentity;
  /** The handle part of `bootstrapAdmin`: the person the first-admin setup page enrols. */
  readonly bootstrapHandle: string;
  /** `AUTH_SETUP_CODE`, a secret: the one-time code the first-admin setup page asks for. */
  readonly setupCode: string;
  readonly editorAccess: string | undefined;
}

const EMAIL_PATTERN = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const SCOPE_PATTERN = /^[A-Za-z0-9:/._-]+( [A-Za-z0-9:/._-]+)*$/;

function text(environment: AuthEnvironment, name: string): string {
  const value = environment[name];
  return typeof value === 'string' ? value.trim() : '';
}

function list(environment: AuthEnvironment, name: string, maximum: number, valid: (item: string) => boolean, what: string): Result<readonly string[], string> {
  const raw = text(environment, name);
  if (raw === '') {
    return ok([]);
  }
  const items = raw
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
  if (items.length > maximum) {
    return err(`${name} lists more than ${maximum} entries.`);
  }
  const bad = items.find((item) => !valid(item));
  return bad === undefined ? ok([...new Set(items)]) : err(`${name} has an entry that is not ${what}: "${bad.slice(0, 40)}".`);
}

export function normalizeEmail(email: string): string | undefined {
  const lowered = email.trim().toLowerCase();
  return lowered.length <= AUTH_CONFIG_LIMITS.emailCharsMax && EMAIL_PATTERN.test(lowered) ? lowered : undefined;
}

function policy(environment: AuthEnvironment, provider: BuiltInProviderId, problems: string[]): PolicyConfig | undefined {
  const emails = list(environment, 'AUTH_ALLOWED_EMAILS', AUTH_CONFIG_LIMITS.allowedEmailsMax, (item) => normalizeEmail(item) === item, 'an email address');
  const domains = list(
    environment,
    'AUTH_ALLOWED_DOMAINS',
    AUTH_CONFIG_LIMITS.allowedDomainsMax,
    (item) => item.length <= AUTH_CONFIG_LIMITS.domainCharsMax && DOMAIN_PATTERN.test(item),
    'a domain such as example.com',
  );
  for (const result of [emails, domains]) {
    if (!result.ok) {
      problems.push(result.error);
    }
  }
  const bootstrapAdmin = bootstrap(environment, provider, problems);
  if (!emails.ok || !domains.ok || bootstrapAdmin === undefined) {
    return undefined;
  }
  return { allowedEmails: emails.value, allowedDomains: domains.value, bootstrapAdmin, editorAccess: editorAccess(environment) };
}

function bootstrap(environment: AuthEnvironment, provider: BuiltInProviderId, problems: string[]): QualifiedIdentity | undefined {
  const raw = text(environment, 'AUTH_BOOTSTRAP_ADMIN');
  if (raw === '') {
    problems.push(`AUTH_BOOTSTRAP_ADMIN is required: the identity that is admin until .stacki/roles.json names one, such as ${provider}:<identity>.`);
    return undefined;
  }
  const parsed = parseQualifiedIdentity(provider === 'google' || provider === 'oidc' || provider === 'access' ? lowerEmailIdentity(raw) : raw);
  if (!parsed.ok) {
    problems.push(`AUTH_BOOTSTRAP_ADMIN is not an identity (${parsed.error.message}).`);
    return undefined;
  }
  if (identityProvider(parsed.value) !== provider) {
    problems.push(`AUTH_BOOTSTRAP_ADMIN must start with "${provider}:" for AUTH_PROVIDER=${provider}.`);
    return undefined;
  }
  return parsed.value;
}

// Google and OIDC identities hold a lowercased email, so the owner may type it in any case.
function lowerEmailIdentity(raw: string): string {
  const colon = raw.indexOf(':');
  const subject = raw.slice(colon + 1);
  return colon > 0 && subject.includes('@') ? `${raw.slice(0, colon)}:${subject.toLowerCase()}` : raw;
}

function editorAccess(environment: AuthEnvironment): string | undefined {
  const value = text(environment, 'EDITOR_ACCESS');
  return value === '' ? undefined : value;
}

function requireText(environment: AuthEnvironment, name: string, maximum: number, problems: string[]): string | undefined {
  const value = text(environment, name);
  if (value === '' || value.length > maximum || /[\s\u0000-\u001f]/u.test(value)) {
    problems.push(`${name} is required (at most ${maximum} characters, no spaces).`);
    return undefined;
  }
  return value;
}

export function parseGoogleConfig(environment: AuthEnvironment): Result<GoogleConfig, readonly string[]> {
  const problems: string[] = [];
  const clientId = requireText(environment, 'GOOGLE_CLIENT_ID', AUTH_CONFIG_LIMITS.clientIdCharsMax, problems);
  const clientSecret = requireText(environment, 'GOOGLE_CLIENT_SECRET', AUTH_CONFIG_LIMITS.clientIdCharsMax, problems);
  const parsedPolicy = policy(environment, 'google', problems);
  if (problems.length > 0 || clientId === undefined || clientSecret === undefined || parsedPolicy === undefined) {
    return err(problems);
  }
  return ok({ clientId, clientSecret, policy: parsedPolicy });
}

/** An issuer URL is https, has no query or fragment, and no trailing slash is added or removed: it must match the token's `iss` exactly. */
export function parseIssuer(value: string): Result<string, string> {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.username !== '' ||
      url.password !== '' ||
      value.length > AUTH_CONFIG_LIMITS.issuerCharsMax
    ) {
      return err('OIDC_ISSUER must be an https URL without credentials, query or fragment.');
    }
    return ok(value);
  } catch {
    return err('OIDC_ISSUER must be an https URL.');
  }
}

export function parseOidcConfig(environment: AuthEnvironment): Result<OidcConfig, readonly string[]> {
  const problems: string[] = [];
  const issuerText = text(environment, 'OIDC_ISSUER');
  const issuer = issuerText === '' ? err('OIDC_ISSUER is required: the https URL of your OpenID Connect provider.') : parseIssuer(issuerText);
  if (!issuer.ok) {
    problems.push(issuer.error);
  }
  const clientId = requireText(environment, 'OIDC_CLIENT_ID', AUTH_CONFIG_LIMITS.clientIdCharsMax, problems);
  const secret = text(environment, 'OIDC_CLIENT_SECRET');
  const scopes = text(environment, 'OIDC_SCOPES') || 'openid email profile';
  if (scopes.length > AUTH_CONFIG_LIMITS.scopesCharsMax || !SCOPE_PATTERN.test(scopes) || !scopes.split(' ').includes('openid')) {
    problems.push('OIDC_SCOPES must be space-separated scope names and include "openid".');
  }
  const buttonName = text(environment, 'OIDC_NAME') || 'SSO';
  if (buttonName.length > AUTH_CONFIG_LIMITS.buttonNameCharsMax || /[\u0000-\u001f\u007f]/u.test(buttonName)) {
    problems.push(`OIDC_NAME is the sign-in button label: at most ${AUTH_CONFIG_LIMITS.buttonNameCharsMax} printable characters.`);
  }
  const parsedPolicy = policy(environment, 'oidc', problems);
  if (problems.length > 0 || !issuer.ok || clientId === undefined || parsedPolicy === undefined) {
    return err(problems);
  }
  return ok({ issuer: issuer.value, clientId, clientSecret: secret === '' ? undefined : secret, scopes, buttonName, policy: parsedPolicy });
}

const TEAM_DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function parseAccessConfig(environment: AuthEnvironment): Result<AccessConfig, readonly string[]> {
  const problems: string[] = [];
  const teamDomain = text(environment, 'ACCESS_TEAM_DOMAIN').toLowerCase();
  const custom = text(environment, 'ACCESS_ALLOW_CUSTOM_TEAM_DOMAIN') === 'true';
  if (teamDomain === '' || teamDomain.length > AUTH_CONFIG_LIMITS.domainCharsMax || !TEAM_DOMAIN_PATTERN.test(teamDomain)) {
    problems.push('ACCESS_TEAM_DOMAIN is required: your Zero Trust team domain, such as myteam.cloudflareaccess.com (no https://, no path).');
  } else if (!custom && !teamDomain.endsWith('.cloudflareaccess.com')) {
    problems.push('ACCESS_TEAM_DOMAIN must end with .cloudflareaccess.com (set ACCESS_ALLOW_CUSTOM_TEAM_DOMAIN to "true" to use another domain).');
  }
  const audience = text(environment, 'ACCESS_AUD');
  if (!/^[A-Za-z0-9._-]{16,128}$/.test(audience)) {
    problems.push('ACCESS_AUD is required: the Application Audience (AUD) tag of your Access application (16 to 128 letters and digits).');
  }
  const parsedPolicy = policy(environment, 'access', problems);
  if (problems.length > 0 || parsedPolicy === undefined) {
    return err(problems);
  }
  return ok({ teamDomain, audience, policy: parsedPolicy });
}

export function parsePasskeyConfig(environment: AuthEnvironment): Result<PasskeyConfig, readonly string[]> {
  const problems: string[] = [];
  const bootstrapAdmin = bootstrap(environment, 'passkey', problems);
  const handle = bootstrapAdmin === undefined ? undefined : bootstrapAdmin.slice('passkey:'.length);
  if (handle !== undefined && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(handle)) {
    problems.push('AUTH_BOOTSTRAP_ADMIN must be passkey:<handle> with a lowercase handle of letters, digits, dots, hyphens or underscores (up to 64).');
  }
  const setupCode = text(environment, 'AUTH_SETUP_CODE');
  if (setupCode.length < 16 || setupCode.length > 200 || /\s/u.test(setupCode)) {
    problems.push(
      'AUTH_SETUP_CODE is required: a secret of 16 to 200 characters, no spaces. Set it with `wrangler secret put AUTH_SETUP_CODE`; it opens the first-admin setup page once.',
    );
  }
  if (bootstrapAdmin === undefined || handle === undefined || problems.length > 0) {
    return err(problems);
  }
  return ok({ bootstrapAdmin, bootstrapHandle: handle, setupCode, editorAccess: editorAccess(environment) });
}

/** Every configuration problem of the chosen provider, as sentences. Empty means the configuration is valid. */
export function authConfigProblems(environment: AuthEnvironment): readonly string[] {
  const chosen = parseAuthProviderId(environment['AUTH_PROVIDER']);
  if (!chosen.ok) {
    return [chosen.error];
  }
  switch (chosen.value) {
    case 'github':
      return [];
    case 'access': {
      const config = parseAccessConfig(environment);
      return config.ok ? [] : config.error;
    }
    case 'google': {
      const config = parseGoogleConfig(environment);
      return config.ok ? [] : config.error;
    }
    case 'oidc': {
      const config = parseOidcConfig(environment);
      return config.ok ? [] : config.error;
    }
    case 'passkey': {
      const config = parsePasskeyConfig(environment);
      return config.ok ? [] : config.error;
    }
  }
}
