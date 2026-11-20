// How people sign in to a hosted Studio: the choices, the non-secret values each one needs, and
// the text that tells the owner what is left to do. One pure module, used by `npm create stacki`
// and by Desktop's "Add Studio" dialog, so the two cannot disagree about a variable's name or a
// next step. It reads no files and runs nothing; the wrangler.jsonc edit lives in
// studioAuthConfigFile.ts. The contract with Studio's providers is documented in
// studio/docs/auth-providers.md ("Built-in providers"); a variable name here is a name there.
//
// Secrets never pass through this module. A client secret is entered by its owner into
// `wrangler secret put`; the guide below only prints that command.
import { record } from '../core/boundary';
import { err, ok, type Result } from '../core/result';

export const STUDIO_AUTH_KINDS = ['github', 'access', 'google', 'oidc', 'passkey'] as const;
export type StudioAuthKind = (typeof STUDIO_AUTH_KINDS)[number];
/** What a project's wrangler.jsonc says today: one of the four, or a provider Stacki did not write. */
export type StudioSignIn = StudioAuthKind | 'custom';

export const STUDIO_AUTH_LIMITS = {
  adminCharsMax: 200,
  clientIdCharsMax: 256,
  domainCharsMax: 253,
  emailCharsMax: 254,
  issuerCharsMax: 512,
  listItemsMax: 50,
  nameCharsMax: 60,
  audCharsMax: 128,
  audCharsMin: 32,
} as const;

/** The default sign-in: Studio's own GitHub provider. Written as no variables at all. */
export const STUDIO_AUTH_DEFAULT: StudioAuthKind = 'github';
export const PASSKEY_ADMIN_DEFAULT = 'owner';
export const OIDC_NAME_DEFAULT = 'SSO';
export const ACCESS_DOMAIN_SUFFIX = '.cloudflareaccess.com';

export type StudioAuthField = 'admin' | 'allowedDomains' | 'allowedEmails' | 'aud' | 'clientId' | 'issuer' | 'name' | 'teamDomain';
// `customDomain`: a valid hostname that does not end in .cloudflareaccess.com and was not confirmed.
export type StudioAuthProblemCode = 'customDomain' | 'invalid' | 'required' | 'tooLong' | 'tooMany' | 'tooShort';
export interface StudioAuthProblem {
  readonly field: StudioAuthField;
  readonly code: StudioAuthProblemCode;
}

/** The text a person typed, before any check. Empty means "not given". Lists are comma, space or line separated. */
export interface StudioAuthDraft {
  readonly kind: StudioAuthKind;
  readonly admin: string;
  readonly allowedDomains: string;
  readonly allowedEmails: string;
  readonly clientId: string;
  readonly issuer: string;
  readonly name: string;
  readonly teamDomain: string;
  readonly aud: string;
  /** `custom` confirms a team domain outside cloudflareaccess.com; `strict` requires the usual suffix. */
  readonly teamDomainCheck: 'strict' | 'custom';
}

/** A checked choice. `admin` is the qualified identity of the first administrator, such as `google:me@example.com`. */
export type StudioAuthConfig =
  | { readonly kind: 'github' }
  | {
      readonly kind: 'access';
      readonly teamDomain: string;
      readonly aud: string;
      readonly admin: string;
      /** `confirmed`: the owner accepted a team domain outside cloudflareaccess.com. */
      readonly teamDomainCustom: 'confirmed' | 'standard';
    }
  | {
      readonly kind: 'google';
      readonly clientId: string;
      readonly allowedDomains: readonly string[];
      readonly allowedEmails: readonly string[];
      readonly admin: string;
    }
  | {
      readonly kind: 'oidc';
      readonly issuer: string;
      readonly clientId: string;
      readonly name: string;
      readonly allowedDomains: readonly string[];
      readonly allowedEmails: readonly string[];
      readonly admin: string;
    }
  | { readonly kind: 'passkey'; readonly admin: string };

/** Every variable setup may write. A change of sign-in removes the ones the new choice does not use. */
export const STUDIO_AUTH_VARIABLES = [
  'AUTH_PROVIDER',
  'ACCESS_TEAM_DOMAIN',
  'ACCESS_AUD',
  'GOOGLE_CLIENT_ID',
  'OIDC_ISSUER',
  'OIDC_CLIENT_ID',
  'OIDC_NAME',
  'AUTH_ALLOWED_DOMAINS',
  'AUTH_ALLOWED_EMAILS',
  'AUTH_BOOTSTRAP_ADMIN',
] as const;
export type StudioAuthVariable = (typeof STUDIO_AUTH_VARIABLES)[number];

export function emptyStudioAuthDraft(kind: StudioAuthKind): StudioAuthDraft {
  return { kind, admin: '', allowedDomains: '', allowedEmails: '', clientId: '', issuer: '', name: '', teamDomain: '', aud: '', teamDomainCheck: 'strict' };
}

export function isStudioAuthKind(input: unknown): input is StudioAuthKind {
  return STUDIO_AUTH_KINDS.some((kind) => kind === input);
}

// Checking ------------------------------------------------------------------

/** Check a draft. Every problem is reported at once, so a form can mark each field. */
export function buildStudioAuth(draft: StudioAuthDraft): Result<StudioAuthConfig, readonly StudioAuthProblem[]> {
  const problems: StudioAuthProblem[] = [];
  const collect = <T>(field: StudioAuthField, result: Result<T, StudioAuthProblemCode>): T | undefined => {
    if (result.ok) {
      return result.value;
    }
    problems.push({ field, code: result.error });
    return undefined;
  };
  const config = buildChecked(draft, collect);
  if (problems.length > 0 || config === undefined) {
    return err(problems);
  }
  return ok(config);
}

type Collect = <T>(field: StudioAuthField, result: Result<T, StudioAuthProblemCode>) => T | undefined;

function buildChecked(draft: StudioAuthDraft, collect: Collect): StudioAuthConfig | undefined {
  switch (draft.kind) {
    case 'github':
      return { kind: 'github' };
    case 'access': {
      const teamDomain = collect('teamDomain', teamDomainOf(draft.teamDomain, draft.teamDomainCheck));
      const aud = collect('aud', audOf(draft.aud));
      const email = collect('admin', adminEmailOf(draft.admin));
      if (teamDomain === undefined || aud === undefined || email === undefined) {
        return undefined;
      }
      return { kind: 'access', teamDomain, aud, admin: `access:${email}`, teamDomainCustom: draft.teamDomainCheck === 'custom' ? 'confirmed' : 'standard' };
    }
    case 'passkey': {
      const handle = collect('admin', passkeyHandle(draft.admin));
      return handle === undefined ? undefined : { kind: 'passkey', admin: `passkey:${handle}` };
    }
    case 'google': {
      const clientId = collect('clientId', clientIdOf(draft.clientId));
      const allowedDomains = collect('allowedDomains', domainsOf(draft.allowedDomains));
      const allowedEmails = collect('allowedEmails', emailsOf(draft.allowedEmails));
      const email = collect('admin', adminEmailOf(draft.admin));
      if (clientId === undefined || allowedDomains === undefined || allowedEmails === undefined || email === undefined) {
        return undefined;
      }
      return { kind: 'google', clientId, allowedDomains, allowedEmails, admin: `google:${email}` };
    }
    case 'oidc': {
      const issuer = collect('issuer', issuerOf(draft.issuer));
      const clientId = collect('clientId', clientIdOf(draft.clientId));
      const name = collect('name', nameOf(draft.name));
      const allowedDomains = collect('allowedDomains', domainsOf(draft.allowedDomains));
      const allowedEmails = collect('allowedEmails', emailsOf(draft.allowedEmails));
      const email = collect('admin', adminEmailOf(draft.admin));
      if (
        issuer === undefined ||
        clientId === undefined ||
        name === undefined ||
        allowedDomains === undefined ||
        allowedEmails === undefined ||
        email === undefined
      ) {
        return undefined;
      }
      return { kind: 'oidc', issuer, clientId, name, allowedDomains, allowedEmails, admin: `oidc:${email}` };
    }
    default: {
      const exhaustive: never = draft.kind;
      return exhaustive;
    }
  }
}

function teamDomainOf(input: string, check: StudioAuthDraft['teamDomainCheck']): Result<string, StudioAuthProblemCode> {
  const value = input
    .trim()
    .toLowerCase()
    .replace(/^https:\/\//, '')
    .replace(/\/$/, '');
  if (value.length === 0) {
    return err('required');
  }
  if (value.length > STUDIO_AUTH_LIMITS.domainCharsMax) {
    return err('tooLong');
  }
  if (!DOMAIN_PATTERN.test(value)) {
    return err('invalid');
  }
  return check === 'strict' && !value.endsWith(ACCESS_DOMAIN_SUFFIX) ? err('customDomain') : ok(value);
}

// The application's audience tag: a long hex or base64url-like string.
function audOf(input: string): Result<string, StudioAuthProblemCode> {
  const value = input.trim();
  if (value.length === 0) {
    return err('required');
  }
  if (value.length > STUDIO_AUTH_LIMITS.audCharsMax) {
    return err('tooLong');
  }
  if (value.length < STUDIO_AUTH_LIMITS.audCharsMin) {
    return err('tooShort');
  }
  return /^[A-Za-z0-9_-]+$/.test(value) ? ok(value) : err('invalid');
}

function clientIdOf(input: string): Result<string, StudioAuthProblemCode> {
  const value = input.trim();
  if (value.length === 0) {
    return err('required');
  }
  if (value.length > STUDIO_AUTH_LIMITS.clientIdCharsMax) {
    return err('tooLong');
  }
  // Printable characters an OAuth client identifier uses; no whitespace, quote, comma or backslash.
  return /^[A-Za-z0-9._~@:/+=-]+$/.test(value) ? ok(value) : err('invalid');
}

function issuerOf(input: string): Result<string, StudioAuthProblemCode> {
  const value = input.trim();
  if (value.length === 0) {
    return err('required');
  }
  if (value.length > STUDIO_AUTH_LIMITS.issuerCharsMax) {
    return err('tooLong');
  }
  const parsed = URL.canParse(value) ? new URL(value) : undefined;
  if (parsed === undefined) {
    return err('invalid');
  }
  // An issuer is compared exactly by the provider, so it is kept as typed (a trailing slash matters to some identity services).
  if (parsed.protocol !== 'https:') {
    return err('invalid');
  }
  if (parsed.hostname.length === 0 || parsed.username !== '' || parsed.password !== '') {
    return err('invalid');
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    return err('invalid');
  }
  return ok(value);
}

function nameOf(input: string): Result<string, StudioAuthProblemCode> {
  const value = input.trim();
  if (value.length === 0) {
    return ok(OIDC_NAME_DEFAULT);
  }
  if (value.length > STUDIO_AUTH_LIMITS.nameCharsMax) {
    return err('tooLong');
  }
  // A button label holds no control characters.
  return /[\u0000-\u001f\u007f]/.test(value) ? err('invalid') : ok(value);
}

const EMAIL_PATTERN = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
const DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

function emailOf(input: string): Result<string, StudioAuthProblemCode> {
  const value = input.trim().toLowerCase();
  if (value.length === 0) {
    return err('required');
  }
  if (value.length > STUDIO_AUTH_LIMITS.emailCharsMax) {
    return err('tooLong');
  }
  return EMAIL_PATTERN.test(value) ? ok(value) : err('invalid');
}

// An identity is `<provider>:<subject>` and the subject has its own bound (studio/docs/auth-providers.md).
function adminEmailOf(input: string): Result<string, StudioAuthProblemCode> {
  const email = emailOf(input);
  if (email.ok && email.value.length > STUDIO_AUTH_LIMITS.adminCharsMax) {
    return err('tooLong');
  }
  return email;
}

function passkeyHandle(input: string): Result<string, StudioAuthProblemCode> {
  const value = input.trim().toLowerCase();
  if (value.length === 0) {
    return ok(PASSKEY_ADMIN_DEFAULT);
  }
  if (value.length > 64) {
    return err('tooLong');
  }
  return /^[a-z0-9][a-z0-9._-]*$/.test(value) ? ok(value) : err('invalid');
}

function splitList(input: string): readonly string[] {
  return input
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function listOf(input: string, one: (item: string) => Result<string, StudioAuthProblemCode>): Result<readonly string[], StudioAuthProblemCode> {
  const items = splitList(input);
  if (items.length > STUDIO_AUTH_LIMITS.listItemsMax) {
    return err('tooMany');
  }
  const seen = new Set<string>();
  for (const item of items) {
    const checked = one(item);
    if (!checked.ok) {
      return err(checked.error);
    }
    seen.add(checked.value);
  }
  return ok([...seen]);
}

function domainsOf(input: string): Result<readonly string[], StudioAuthProblemCode> {
  return listOf(input, (item) => {
    const value = item.replace(/^@/, '').toLowerCase();
    if (value.length > STUDIO_AUTH_LIMITS.domainCharsMax) {
      return err('tooLong');
    }
    return DOMAIN_PATTERN.test(value) ? ok(value) : err('invalid');
  });
}

function emailsOf(input: string): Result<readonly string[], StudioAuthProblemCode> {
  return listOf(input, emailOf);
}

// Variables -----------------------------------------------------------------

/**
 * The variables a choice writes, in file order. GitHub writes none: it is the default, so a project
 * that never chose stays exactly as Studio shipped it.
 */
export function studioAuthVariables(config: StudioAuthConfig): ReadonlyArray<readonly [StudioAuthVariable, string]> {
  const lists = (domains: readonly string[], emails: readonly string[]): ReadonlyArray<readonly [StudioAuthVariable, string]> => {
    const rows: Array<readonly [StudioAuthVariable, string]> = [];
    if (domains.length > 0) {
      rows.push(['AUTH_ALLOWED_DOMAINS', domains.join(',')]);
    }
    if (emails.length > 0) {
      rows.push(['AUTH_ALLOWED_EMAILS', emails.join(',')]);
    }
    return rows;
  };
  switch (config.kind) {
    case 'github':
      return [];
    case 'access':
      return [
        ['AUTH_PROVIDER', 'access'],
        ['ACCESS_TEAM_DOMAIN', config.teamDomain],
        ['ACCESS_AUD', config.aud],
        ['AUTH_BOOTSTRAP_ADMIN', config.admin],
      ];
    case 'google':
      return [
        ['AUTH_PROVIDER', 'google'],
        ['GOOGLE_CLIENT_ID', config.clientId],
        ...lists(config.allowedDomains, config.allowedEmails),
        ['AUTH_BOOTSTRAP_ADMIN', config.admin],
      ];
    case 'oidc':
      return [
        ['AUTH_PROVIDER', 'oidc'],
        ['OIDC_ISSUER', config.issuer],
        ['OIDC_CLIENT_ID', config.clientId],
        ['OIDC_NAME', config.name],
        ...lists(config.allowedDomains, config.allowedEmails),
        ['AUTH_BOOTSTRAP_ADMIN', config.admin],
      ];
    case 'passkey':
      return [
        ['AUTH_PROVIDER', 'passkey'],
        ['AUTH_BOOTSTRAP_ADMIN', config.admin],
      ];
    default: {
      const exhaustive: never = config;
      return exhaustive;
    }
  }
}

// The guide -----------------------------------------------------------------

export interface StudioAuthGuide {
  /** Shell lines to run once, in order, from the project root. Each secret is typed at Wrangler's own prompt. */
  readonly secretLines: readonly string[];
  /** The path the identity service must be told to send people back to, after the site's origin. */
  readonly redirectPath: string | undefined;
  /** The secret names, in the order of `secretLines`. */
  readonly secretNames: readonly string[];
}

export function studioAuthGuide(config: StudioAuthConfig): StudioAuthGuide {
  switch (config.kind) {
    case 'github':
    case 'access':
    case 'passkey':
      return { secretLines: [], redirectPath: undefined, secretNames: [] };
    case 'google':
      return guideFor('google', 'GOOGLE_CLIENT_SECRET');
    case 'oidc':
      return guideFor('oidc', 'OIDC_CLIENT_SECRET');
    default: {
      const exhaustive: never = config;
      return exhaustive;
    }
  }
}

function guideFor(provider: 'google' | 'oidc', secret: string): StudioAuthGuide {
  return {
    secretLines: ['cd studio', `npx wrangler secret put ${secret} --config cloudflare/wrangler.jsonc`],
    redirectPath: `/studio/auth/${provider}/callback`,
    secretNames: [secret],
  };
}

/**
 * The English lines the command line and a coding agent print after setup. Desktop draws the same
 * facts (secret commands, redirect path) in its own translated words, from `studioAuthGuide`.
 */
export function studioAuthNextSteps(config: StudioAuthConfig): readonly string[] {
  const guide = studioAuthGuide(config);
  switch (config.kind) {
    case 'github':
      return ['Sign-in: GitHub (the default). Nothing else to choose; the GitHub App steps in studio/docs/cloudflare.md cover it.'];
    case 'access':
      return [
        `Sign-in: Cloudflare Access. The first administrator is ${config.admin}. There are no secrets to store.`,
        'In Cloudflare Zero Trust, create an Access application (Self-hosted) that covers your site hostname and the path /studio*',
        '(or turn on Access for the workers.dev route), with a policy that allows your team.',
        `Copy the application's AUD tag; setup recorded the value you gave (${config.aud.slice(0, 8)}...). Update ACCESS_AUD if it differs.`,
        'People need BOTH: to be allowed by the Access policy AND to be listed in .stacki/roles.json (invite them from the Roles panel).',
      ];
    case 'passkey':
      return [
        `Sign-in: Passkeys. The first administrator is ${config.admin}; they register a passkey on the first visit.`,
        'Invite everyone else from Studio settings once you are signed in. Nothing to create at an identity service.',
      ];
    case 'google':
    case 'oidc': {
      const label = config.kind === 'google' ? 'Google' : `SSO (${config.name})`;
      const lines = [
        `Sign-in: ${label}. The first administrator is ${config.admin}.`,
        config.kind === 'google'
          ? 'Create an OAuth client (type: Web application) in the Google Cloud console, under APIs & Services, Credentials.'
          : `Create an application (a confidential or a public PKCE client) at your identity provider, ${config.issuer}.`,
        `Register this redirect URI: https://<your-site>${guide.redirectPath ?? ''}`,
        `Then store the client secret yourself; Stacki never asks for it:`,
        ...guide.secretLines.map((line) => `  ${line}`),
      ];
      if (config.kind === 'oidc') {
        lines.push('A public PKCE client has no client secret: skip the command.');
      }
      return lines;
    }
    default: {
      const exhaustive: never = config;
      return exhaustive;
    }
  }
}

// Boundary ------------------------------------------------------------------

const WIRE_KEYS = ['kind', 'admin', 'allowedDomains', 'allowedEmails', 'aud', 'clientId', 'issuer', 'name', 'teamDomain', 'teamDomainCustom'] as const;

/**
 * Parse the choice that crosses IPC. Unknown keys are refused so a client secret can never ride along
 * in a field nobody reads; everything else is checked again by `buildStudioAuth`.
 */
export function parseStudioAuth(input: unknown): StudioAuthConfig {
  const value = record(input);
  for (const key of Object.keys(value)) {
    if (!WIRE_KEYS.some((allowed) => allowed === key)) {
      throw new Error('Studio sign-in has an unknown field');
    }
  }
  const kind = value['kind'];
  if (!isStudioAuthKind(kind)) {
    throw new Error('Studio sign-in must be github, google, oidc or passkey');
  }
  const built = buildStudioAuth({
    kind,
    admin: unqualified(value['admin'], kind),
    allowedDomains: wireList(value['allowedDomains']),
    allowedEmails: wireList(value['allowedEmails']),
    clientId: wireText(value['clientId']),
    issuer: wireText(value['issuer']),
    name: wireText(value['name']),
    teamDomain: wireText(value['teamDomain']),
    aud: wireText(value['aud']),
    // A stored custom domain was confirmed when it was saved; the wire marks that with this key.
    teamDomainCheck: value['teamDomainCustom'] === 'confirmed' ? 'custom' : 'strict',
  });
  if (!built.ok) {
    const first = built.error[0];
    throw new Error(`Studio sign-in ${first?.field ?? 'value'} is ${first?.code ?? 'invalid'}`);
  }
  return built.value;
}

function wireText(input: unknown): string {
  if (input === undefined) {
    return '';
  }
  if (typeof input !== 'string' || input.length > 1024) {
    throw new Error('Studio sign-in field must be a short string');
  }
  return input;
}

function wireList(input: unknown): string {
  if (input === undefined) {
    return '';
  }
  if (!Array.isArray(input) || input.length > STUDIO_AUTH_LIMITS.listItemsMax) {
    throw new Error('Studio sign-in list must be a short array');
  }
  return input.map((item: unknown) => wireText(item)).join(',');
}

// The wire carries the qualified identity (`google:me@x.com`); the builder takes the subject.
function unqualified(input: unknown, kind: StudioAuthKind): string {
  const value = wireText(input);
  if (kind === 'github' || value === '') {
    return value;
  }
  const prefix = `${kind}:`;
  if (!value.startsWith(prefix)) {
    throw new Error(`Studio sign-in admin must start with ${prefix}`);
  }
  return value.slice(prefix.length);
}

/** The first administrator's subject, for a form that shows the email or handle without its prefix. */
export function studioAuthAdminSubject(config: StudioAuthConfig): string {
  return config.kind === 'github' ? '' : config.admin.slice(config.kind.length + 1);
}
