// How people sign in to a hosted Studio: the choices, the non-secret values each one needs, and
// the text that tells the owner what is left to do. One pure module, used by `npm create stacki`
// and by Desktop's "Add Studio" dialog, so the two cannot disagree about a variable's name or a
// next step. It reads no files and runs nothing; the wrangler.jsonc edit lives in
// studioAuthConfigFile.ts. The contract with Studio's providers is documented in
// studio/docs/auth-providers.md ("Built-in providers"); a variable name here is a name there.
//
// Secrets never pass through this module. A client secret is entered by its owner into
// `wrangler secret put`; the guide below only prints that command.
import { assert } from '../core/assert';
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
export const PASSKEY_BOOTSTRAP_PATH = '/studio/auth/passkey/bootstrap';
export const SETUP_CODE_CHARS = { min: 16, max: 200 } as const;
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
  assert(isStudioAuthKind(kind), 'emptyStudioAuthDraft: the kind is one of the known sign-ins');
  assert(STUDIO_AUTH_KINDS.includes(STUDIO_AUTH_DEFAULT), 'emptyStudioAuthDraft: the default sign-in is a known kind');
  return { kind, admin: '', allowedDomains: '', allowedEmails: '', clientId: '', issuer: '', name: '', teamDomain: '', aud: '', teamDomainCheck: 'strict' };
}

export function isStudioAuthKind(input: unknown): input is StudioAuthKind {
  assert(STUDIO_AUTH_KINDS.length > 0, 'isStudioAuthKind: there is at least one sign-in kind');
  return STUDIO_AUTH_KINDS.some((kind) => kind === input);
}

// Checking ------------------------------------------------------------------

/** Check a draft. Every problem is reported at once, so a form can mark each field. */
export function buildStudioAuth(draft: StudioAuthDraft): Result<StudioAuthConfig, readonly StudioAuthProblem[]> {
  const problems: StudioAuthProblem[] = [];
  const collect = <T>(field: StudioAuthField, result: Result<T, StudioAuthProblemCode>): T | undefined => {
    assert(problems.length <= STUDIO_AUTH_FIELDS_MAX, 'buildStudioAuth: at most one problem per field is collected');
    if (result.ok) {
      return result.value;
    }
    problems.push({ field, code: result.error });
    return undefined;
  };
  const config = buildChecked(draft, collect);
  if (problems.length > 0) {
    return err(problems);
  }
  // Pair of the check above: a draft with no problem always built a config, so the next step cannot return an empty failure.
  assert(config !== undefined, 'buildStudioAuth: a draft with no problems built a config');
  assert(config.kind === draft.kind, 'buildStudioAuth: the config keeps the draft kind');
  return ok(config);
}

const STUDIO_AUTH_FIELDS_MAX = 16;

type Collect = <T>(field: StudioAuthField, result: Result<T, StudioAuthProblemCode>) => T | undefined;

function buildChecked(draft: StudioAuthDraft, collect: Collect): StudioAuthConfig | undefined {
  assert(isStudioAuthKind(draft.kind), 'buildChecked: the draft kind is known');
  assert(draft.teamDomainCheck === 'strict' || draft.teamDomainCheck === 'custom', 'buildChecked: the team domain check is strict or custom');
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
  assert(typeof input === 'string', 'teamDomainOf: the input is text');
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
  assert(value === value.toLowerCase(), 'teamDomainOf: a checked domain is lower case');
  return check === 'strict' && !value.endsWith(ACCESS_DOMAIN_SUFFIX) ? err('customDomain') : ok(value);
}

// The application's audience tag: a long hex or base64url-like string.
function audOf(input: string): Result<string, StudioAuthProblemCode> {
  assert(STUDIO_AUTH_LIMITS.audCharsMin < STUDIO_AUTH_LIMITS.audCharsMax, 'audOf: the audience bounds are ordered');
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
  assert(value.length >= STUDIO_AUTH_LIMITS.audCharsMin, 'audOf: a value that reaches the pattern is long enough');
  return /^[A-Za-z0-9_-]+$/.test(value) ? ok(value) : err('invalid');
}

function clientIdOf(input: string): Result<string, StudioAuthProblemCode> {
  assert(typeof input === 'string', 'clientIdOf: the input is text');
  const value = input.trim();
  if (value.length === 0) {
    return err('required');
  }
  if (value.length > STUDIO_AUTH_LIMITS.clientIdCharsMax) {
    return err('tooLong');
  }
  // Printable characters an OAuth client identifier uses; no whitespace, quote, comma or backslash.
  assert(value.length <= STUDIO_AUTH_LIMITS.clientIdCharsMax, 'clientIdOf: a value that reaches the pattern is within its bound');
  return /^[A-Za-z0-9._~@:/+=-]+$/.test(value) ? ok(value) : err('invalid');
}

function issuerOf(input: string): Result<string, StudioAuthProblemCode> {
  assert(typeof input === 'string', 'issuerOf: the input is text');
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
  assert(parsed.protocol === 'https:', 'issuerOf: an accepted issuer is https');
  assert(value.length <= STUDIO_AUTH_LIMITS.issuerCharsMax, 'issuerOf: an accepted issuer is within its bound');
  return ok(value);
}

function nameOf(input: string): Result<string, StudioAuthProblemCode> {
  assert(OIDC_NAME_DEFAULT.length <= STUDIO_AUTH_LIMITS.nameCharsMax, 'nameOf: the default name fits its own bound');
  const value = input.trim();
  if (value.length === 0) {
    return ok(OIDC_NAME_DEFAULT);
  }
  if (value.length > STUDIO_AUTH_LIMITS.nameCharsMax) {
    return err('tooLong');
  }
  // A button label holds no control characters.
  assert(value.length > 0, 'nameOf: a name that reaches the control-character check is not empty');
  return /[\u0000-\u001f\u007f]/.test(value) ? err('invalid') : ok(value);
}

const EMAIL_PATTERN = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
const DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

function emailOf(input: string): Result<string, StudioAuthProblemCode> {
  assert(typeof input === 'string', 'emailOf: the input is text');
  const value = input.trim().toLowerCase();
  if (value.length === 0) {
    return err('required');
  }
  if (value.length > STUDIO_AUTH_LIMITS.emailCharsMax) {
    return err('tooLong');
  }
  assert(value === value.trim(), 'emailOf: a checked email has no surrounding space');
  return EMAIL_PATTERN.test(value) ? ok(value) : err('invalid');
}

// An identity is `<provider>:<subject>` and the subject has its own bound (studio/docs/auth-providers.md).
function adminEmailOf(input: string): Result<string, StudioAuthProblemCode> {
  assert(STUDIO_AUTH_LIMITS.adminCharsMax <= STUDIO_AUTH_LIMITS.emailCharsMax, 'adminEmailOf: the administrator bound is not wider than an email');
  const email = emailOf(input);
  if (email.ok && email.value.length > STUDIO_AUTH_LIMITS.adminCharsMax) {
    return err('tooLong');
  }
  assert(!email.ok || email.value.length <= STUDIO_AUTH_LIMITS.adminCharsMax, 'adminEmailOf: an accepted administrator is within its bound');
  return email;
}

function passkeyHandle(input: string): Result<string, StudioAuthProblemCode> {
  assert(PASSKEY_ADMIN_DEFAULT.length > 0, 'passkeyHandle: the default handle is not empty');
  const value = input.trim().toLowerCase();
  if (value.length === 0) {
    return ok(PASSKEY_ADMIN_DEFAULT);
  }
  if (value.length > 64) {
    return err('tooLong');
  }
  assert(value.length <= 64, 'passkeyHandle: a handle that reaches the pattern is within its bound');
  return /^[a-z0-9][a-z0-9._-]*$/.test(value) ? ok(value) : err('invalid');
}

function splitList(input: string): readonly string[] {
  assert(typeof input === 'string', 'splitList: the input is text');
  const items = input
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  assert(!items.some((item) => /[\s,;]/.test(item)), 'splitList: no item holds a separator');
  return items;
}

function listOf(input: string, one: (item: string) => Result<string, StudioAuthProblemCode>): Result<readonly string[], StudioAuthProblemCode> {
  const items = splitList(input);
  if (items.length > STUDIO_AUTH_LIMITS.listItemsMax) {
    return err('tooMany');
  }
  assert(items.length <= STUDIO_AUTH_LIMITS.listItemsMax, 'listOf: the loop below runs at most listItemsMax times');
  const seen = new Set<string>();
  for (const item of items) {
    const checked = one(item);
    if (!checked.ok) {
      return err(checked.error);
    }
    seen.add(checked.value);
  }
  assert(seen.size <= items.length, 'listOf: de-duplicating never adds an item');
  return ok([...seen]);
}

function domainsOf(input: string): Result<readonly string[], StudioAuthProblemCode> {
  return listOf(input, (item) => {
    assert(item.length > 0, 'domainsOf: a list item is not empty');
    const value = item.replace(/^@/, '').toLowerCase();
    if (value.length > STUDIO_AUTH_LIMITS.domainCharsMax) {
      return err('tooLong');
    }
    assert(!value.startsWith('@'), 'domainsOf: the leading @ is removed');
    return DOMAIN_PATTERN.test(value) ? ok(value) : err('invalid');
  });
}

function emailsOf(input: string): Result<readonly string[], StudioAuthProblemCode> {
  assert(typeof input === 'string', 'emailsOf: the input is text');
  return listOf(input, emailOf);
}

// Variables -----------------------------------------------------------------

/**
 * The variables a choice writes, in file order. GitHub writes none: it is the default, so a project
 * that never chose stays exactly as Studio shipped it.
 */
export function studioAuthVariables(config: StudioAuthConfig): ReadonlyArray<readonly [StudioAuthVariable, string]> {
  assert(isStudioAuthKind(config.kind), 'studioAuthVariables: the config kind is known');
  const lists = (domains: readonly string[], emails: readonly string[]): ReadonlyArray<readonly [StudioAuthVariable, string]> => {
    assert(domains.length <= STUDIO_AUTH_LIMITS.listItemsMax, 'studioAuthVariables: the domain list is within its bound');
    assert(emails.length <= STUDIO_AUTH_LIMITS.listItemsMax, 'studioAuthVariables: the email list is within its bound');
    const rows: Array<readonly [StudioAuthVariable, string]> = [];
    if (domains.length > 0) {
      rows.push(['AUTH_ALLOWED_DOMAINS', domains.join(',')]);
    }
    if (emails.length > 0) {
      rows.push(['AUTH_ALLOWED_EMAILS', emails.join(',')]);
    }
    assert(rows.length <= 2, 'studioAuthVariables: the lists write at most two variables');
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
  /** Passkeys only: the page, after the site's origin, opened once to create the first passkey. */
  readonly bootstrapPath: string | undefined;
  /** The secret names, in the order of `secretLines`. */
  readonly secretNames: readonly string[];
}

export function studioAuthGuide(config: StudioAuthConfig): StudioAuthGuide {
  assert(isStudioAuthKind(config.kind), 'studioAuthGuide: the config kind is known');
  return studioAuthGuideFor(config.kind);
}

/** The guide depends only on the kind, so a form can show it before the values are valid. */
export function studioAuthGuideFor(kind: StudioAuthKind): StudioAuthGuide {
  assert(isStudioAuthKind(kind), 'studioAuthGuideFor: the kind is known');
  switch (kind) {
    case 'github':
    case 'access':
      return { secretLines: [], redirectPath: undefined, bootstrapPath: undefined, secretNames: [] };
    case 'passkey':
      // The setup code opens the first-admin page once; the owner chooses it, so it is never generated or stored here.
      return {
        secretLines: ['cd studio', 'npx wrangler secret put AUTH_SETUP_CODE --config cloudflare/wrangler.jsonc'],
        redirectPath: undefined,
        bootstrapPath: PASSKEY_BOOTSTRAP_PATH,
        secretNames: ['AUTH_SETUP_CODE'],
      };
    case 'google':
      return guideFor('google', 'GOOGLE_CLIENT_SECRET');
    case 'oidc':
      return guideFor('oidc', 'OIDC_CLIENT_SECRET');
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function guideFor(provider: 'google' | 'oidc', secret: string): StudioAuthGuide {
  assert(/^[A-Z][A-Z0-9_]*$/.test(secret), 'guideFor: a secret name is an upper case variable name');
  assert(provider === 'google' || provider === 'oidc', 'guideFor: the provider has a callback route');
  return {
    secretLines: ['cd studio', `npx wrangler secret put ${secret} --config cloudflare/wrangler.jsonc`],
    redirectPath: `/studio/auth/${provider}/callback`,
    bootstrapPath: undefined,
    secretNames: [secret],
  };
}

/**
 * The English lines the command line and a coding agent print after setup. Desktop draws the same
 * facts (secret commands, redirect path) in its own translated words, from `studioAuthGuide`.
 */
export function studioAuthNextSteps(config: StudioAuthConfig): readonly string[] {
  const guide = studioAuthGuide(config);
  assert(guide.secretNames.length === 0 || guide.secretLines.length > 0, 'studioAuthNextSteps: a guide that names a secret also has its command');
  switch (config.kind) {
    case 'github':
      return ['Sign-in: GitHub (the default). Nothing else to choose; the GitHub App steps in studio/docs/cloudflare.md cover it.'];
    case 'access':
      return [
        `Sign-in: Cloudflare Access. The first administrator is ${config.admin}. There are no secrets to store.`,
        `Setup recorded ACCESS_TEAM_DOMAIN (${config.teamDomain}) and ACCESS_AUD in cloudflare/wrangler.jsonc.`,
        'In Cloudflare Zero Trust, create an Access application (Self-hosted) that covers your site hostname and the path /studio*',
        '(or turn on Access for the workers.dev route), with a policy that allows your team.',
        `Copy the application's Audience (AUD) tag into ACCESS_AUD (setup recorded the one you gave, ${config.aud.slice(0, 8)}...); update it if it differs.`,
        'People need BOTH: to be allowed by the Access policy AND to be listed in .stacki/roles.json (invite them from the Roles panel).',
      ];
    case 'passkey':
      return [
        `Sign-in: Passkeys. The first administrator is ${config.admin} (AUTH_BOOTSTRAP_ADMIN).`,
        `Choose a long random code (${SETUP_CODE_CHARS.min} to ${SETUP_CODE_CHARS.max} characters, no spaces) and store it yourself; Stacki never asks for it or saves it:`,
        ...guide.secretLines.map((line) => `  ${line}`),
        `Deploy, then open https://<your-site>${PASSKEY_BOOTSTRAP_PATH} once and enter the code to create the first passkey.`,
        'After that, create invites for everyone else from the Roles view in Studio.',
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

const WIRE_TEXT_CHARS_MAX = 1024;
const WIRE_KEYS = ['kind', 'admin', 'allowedDomains', 'allowedEmails', 'aud', 'clientId', 'issuer', 'name', 'teamDomain', 'teamDomainCustom'] as const;

/**
 * Parse the choice that crosses IPC. Unknown keys are refused so a client secret can never ride along
 * in a field nobody reads; everything else is checked again by `buildStudioAuth`.
 */
export function parseStudioAuth(input: unknown): StudioAuthConfig {
  assert(WIRE_KEYS.length > 0, 'parseStudioAuth: the wire has known keys');
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
  assert(built.value.kind === kind, 'parseStudioAuth: the parsed choice keeps the wire kind');
  return built.value;
}

function wireText(input: unknown): string {
  assert(WIRE_TEXT_CHARS_MAX > 0, 'wireText: the text bound is positive');
  if (input === undefined) {
    return '';
  }
  if (typeof input !== 'string' || input.length > WIRE_TEXT_CHARS_MAX) {
    throw new Error('Studio sign-in field must be a short string');
  }
  assert(input.length <= WIRE_TEXT_CHARS_MAX, 'wireText: an accepted field is within its bound');
  return input;
}

function wireList(input: unknown): string {
  assert(STUDIO_AUTH_LIMITS.listItemsMax > 0, 'wireList: the list bound is positive');
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
  assert(isStudioAuthKind(kind), 'unqualified: the kind is known');
  const value = wireText(input);
  if (kind === 'github' || value === '') {
    return value;
  }
  const prefix = `${kind}:`;
  if (!value.startsWith(prefix)) {
    throw new Error(`Studio sign-in admin must start with ${prefix}`);
  }
  assert(value.length >= prefix.length, 'unqualified: a prefixed value is at least as long as its prefix');
  return value.slice(prefix.length);
}

/** The first administrator's subject, for a form that shows the email or handle without its prefix. */
export function studioAuthAdminSubject(config: StudioAuthConfig): string {
  assert(config.kind === 'github' || config.admin.startsWith(`${config.kind}:`), 'studioAuthAdminSubject: an administrator is qualified by its sign-in kind');
  return config.kind === 'github' ? '' : config.admin.slice(config.kind.length + 1);
}

/** A random code the owner may copy for AUTH_SETUP_CODE: 32 random bytes as 43 URL-safe characters. Never stored by Stacki. */
export function suggestSetupCode(randomBytes: Uint8Array): string {
  if (randomBytes.length !== 32) {
    throw new Error('A setup code suggestion needs exactly 32 random bytes');
  }
  assert(SETUP_CODE_CHARS.min < SETUP_CODE_CHARS.max, 'suggestSetupCode: the setup code bounds are ordered');
  const code = btoa(String.fromCharCode(...randomBytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  if (code.length < SETUP_CODE_CHARS.min || code.length > SETUP_CODE_CHARS.max) {
    throw new Error('The suggested setup code is outside its length bounds');
  }
  assert(!/[+/=]/.test(code), 'suggestSetupCode: the code is URL-safe');
  return code;
}
