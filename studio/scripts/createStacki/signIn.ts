// The "How should people sign in to Studio?" step of `npm create stacki`. It collects only
// non-secret values, writes them into studio/cloudflare/wrangler.jsonc with a surgical edit, and
// prints what the owner must still do by hand (the client secret goes to `wrangler secret put`,
// never through this program and never into a file).
import { lstat, open, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  STUDIO_AUTH_KINDS,
  suggestSetupCode,
  buildStudioAuth,
  emptyStudioAuthDraft,
  studioAuthNextSteps,
  type StudioAuthConfig,
  type StudioAuthDraft,
  type StudioAuthField,
  type StudioAuthKind,
  type StudioAuthProblem,
} from '../../vendor/stacki/shared/ipc/studioAuth';
import { STUDIO_CONFIG_BYTES_MAX, applyStudioAuth } from '../../vendor/stacki/shared/ipc/studioAuthConfigFile';
import type { Result } from '../../vendor/stacki/shared/core/result';
import { err, ok } from '../../vendor/stacki/shared/core/result';
import type { AuthFlags } from './options';
import type { Choice, Prompter } from './prompter';

const CHOICES: readonly (Choice & { readonly kind: StudioAuthKind })[] = [
  { kind: 'github', label: 'GitHub (default)', hint: 'People sign in with their GitHub account.' },
  { kind: 'access', label: 'Cloudflare Access', hint: 'Put Studio behind Cloudflare Zero Trust Access.' },
  { kind: 'google', label: 'Google', hint: 'Google accounts; limit access by email or domain.' },
  { kind: 'oidc', label: 'SSO (OpenID Connect)', hint: 'Okta, Entra ID, Auth0, Keycloak and other identity providers.' },
  { kind: 'passkey', label: 'Passkeys', hint: 'No accounts to connect; the first admin invites people.' },
];

const FIELD_QUESTIONS: Readonly<Record<StudioAuthField, string>> = {
  issuer: 'Issuer URL (https, as your identity provider shows it): ',
  clientId: 'Client ID (not the secret): ',
  name: 'Name on the sign-in button [SSO]: ',
  teamDomain: 'Access team domain (for example myteam.cloudflareaccess.com): ',
  aud: 'Access application AUD tag (not a secret): ',
  allowedDomains: 'Only allow these email domains, comma separated (Enter for any): ',
  allowedEmails: 'Only allow these emails, comma separated (Enter for any): ',
  admin: 'First administrator',
};

const FIELD_REQUIRED: Readonly<Record<StudioAuthKind, readonly StudioAuthField[]>> = {
  github: [],
  access: ['teamDomain', 'aud', 'admin'],
  google: ['clientId', 'admin'],
  oidc: ['issuer', 'clientId', 'admin'],
  passkey: [],
};
const FIELD_ORDER: Readonly<Record<StudioAuthKind, readonly StudioAuthField[]>> = {
  github: [],
  access: ['teamDomain', 'aud', 'admin'],
  google: ['clientId', 'allowedDomains', 'allowedEmails', 'admin'],
  oidc: ['issuer', 'clientId', 'name', 'allowedDomains', 'allowedEmails', 'admin'],
  passkey: ['admin'],
};

const ATTEMPTS_MAX = 5;

function adminQuestion(kind: StudioAuthKind): string {
  return kind === 'passkey'
    ? 'First administrator handle, a name you choose (Enter for "owner"): '
    : `First administrator's email (they can always sign in and invite others): `;
}

/**
 * Decide the sign-in before anything is installed, so a bad flag fails with no files changed.
 * Without a prompter (`--yes`, CI) every needed value must come from flags.
 */
export async function chooseSignIn(flags: AuthFlags, prompter: Prompter | undefined): Promise<Result<StudioAuthConfig, string>> {
  const kind = flags.auth ?? (prompter === undefined ? 'github' : await askKind(prompter));
  const draft: StudioAuthDraft = {
    ...emptyStudioAuthDraft(kind),
    admin: flags.admin,
    allowedDomains: flags.allowedDomains,
    allowedEmails: flags.allowedEmails,
    clientId: flags.clientId,
    issuer: flags.issuer,
    name: flags.name,
    teamDomain: flags.teamDomain,
    aud: flags.aud,
    teamDomainCheck: flags.teamDomainCheck,
  };
  if (prompter === undefined) {
    return finalDraft(draft);
  }
  let current = draft;
  for (const field of FIELD_ORDER[kind]) {
    if (fieldValue(current, field) === '' || fieldProblems(current, field).length > 0) {
      const asked = await askField(prompter, current, field);
      if (!asked.ok) {
        return asked;
      }
      current = asked.value;
    }
  }
  return finalDraft(current);
}

async function askKind(prompter: Prompter): Promise<StudioAuthKind> {
  const index = await prompter.select('How should people sign in to Studio?', CHOICES, 0);
  return CHOICES[index]?.kind ?? 'github';
}

function fieldValue(draft: StudioAuthDraft, field: StudioAuthField): string {
  return draft[field];
}

function fieldProblems(draft: StudioAuthDraft, field: StudioAuthField): readonly StudioAuthProblem[] {
  const built = buildStudioAuth(draft);
  return built.ok ? [] : built.error.filter((problem) => problem.field === field);
}

async function askField(prompter: Prompter, draft: StudioAuthDraft, field: StudioAuthField): Promise<Result<StudioAuthDraft, string>> {
  const question = field === 'admin' ? adminQuestion(draft.kind) : FIELD_QUESTIONS[field];
  for (let attempt = 0; attempt < ATTEMPTS_MAX; attempt += 1) {
    const answer = await prompter.ask(question);
    const next: StudioAuthDraft = { ...draft, [field]: answer };
    let problems = fieldProblems(next, field);
    if (field === 'teamDomain' && problems.some((problem) => problem.code === 'customDomain')) {
      const confirmed = await prompter.ask('That is not a *.cloudflareaccess.com domain. Use it anyway (a custom Access domain)? [y/N] ');
      if (/^(y|yes)$/i.test(confirmed)) {
        const custom: StudioAuthDraft = { ...next, teamDomainCheck: 'custom' };
        problems = fieldProblems(custom, field);
        if (problems.length === 0) {
          return ok(custom);
        }
      }
    }
    if (problems.length === 0) {
      return ok(next);
    }
    prompter.say(`  ${describe(problems)}`);
  }
  return err(`No valid ${field} was given`);
}

function finalDraft(draft: StudioAuthDraft): Result<StudioAuthConfig, string> {
  const built = buildStudioAuth(draft);
  if (built.ok) {
    return ok(built.value);
  }
  const missing = built.error.filter((problem) => problem.code === 'required' && FIELD_REQUIRED[draft.kind].includes(problem.field));
  if (missing.length > 0) {
    return err(`--auth ${draft.kind} also needs ${missing.map((problem) => FLAG_OF[problem.field]).join(', ')}`);
  }
  return err(`Invalid sign-in settings: ${describe(built.error)}`);
}

const FLAG_OF: Readonly<Record<StudioAuthField, string>> = {
  admin: '--auth-admin',
  allowedDomains: '--auth-allowed-domains',
  allowedEmails: '--auth-allowed-emails',
  clientId: '--auth-client-id',
  issuer: '--auth-issuer',
  name: '--auth-name',
  teamDomain: '--auth-team-domain',
  aud: '--auth-aud',
};

function describe(problems: readonly StudioAuthProblem[]): string {
  return problems
    .map(
      (problem) =>
        `${FLAG_OF[problem.field].replace('--auth-', '')} is ${problem.code === 'invalid' ? 'not valid' : problem.code === 'customDomain' ? 'not a cloudflareaccess.com domain (add --auth-custom-domain to confirm)' : problem.code}`,
    )
    .join('; ');
}

// The file --------------------------------------------------------------------

export type SignInWrite =
  | { readonly kind: 'written' }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'kept'; readonly provider: string }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * Put the choice into studio/cloudflare/wrangler.jsonc. GitHub is the default and writes nothing.
 * An AUTH_PROVIDER that is already there is the owner's: it is replaced only when `confirmReplace` says yes.
 */
export async function writeSignIn(project: string, config: StudioAuthConfig, confirmReplace: (provider: string) => Promise<boolean>): Promise<SignInWrite> {
  if (config.kind === 'github') {
    return { kind: 'unchanged' };
  }
  const file = path.join(project, 'studio/cloudflare/wrangler.jsonc');
  const text = await readConfig(file);
  if (text === undefined) {
    return { kind: 'failed', message: 'studio/cloudflare/wrangler.jsonc was not found or is too large to edit' };
  }
  let edited = applyStudioAuth(text, config, 'refuse');
  if (!edited.ok && edited.error.kind === 'alreadySet') {
    const provider = edited.error.provider;
    if (!(await confirmReplace(provider))) {
      return { kind: 'kept', provider };
    }
    edited = applyStudioAuth(text, config, 'replace');
  }
  if (!edited.ok) {
    return { kind: 'failed', message: `wrangler.jsonc could not be edited (${edited.error.kind}); add the variables by hand` };
  }
  const temporary = `${file}.stacki-${process.pid}`;
  await writeFile(temporary, edited.value, { flag: 'wx' });
  await rename(temporary, file);
  return { kind: 'written' };
}

async function readConfig(file: string): Promise<string | undefined> {
  const stat = await lstat(file).catch(() => undefined);
  if (stat === undefined || !stat.isFile() || stat.size > STUDIO_CONFIG_BYTES_MAX) {
    return undefined;
  }
  const handle = await open(file, 'r');
  try {
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

/** Write the choice and say what is left to do. `prompter` is only used to ask before replacing an AUTH_PROVIDER. */
export async function configureSignIn(
  project: string,
  config: StudioAuthConfig,
  prompter: Prompter | undefined,
): Promise<{ readonly written: SignInWrite; readonly lines: readonly string[] }> {
  const written = await writeSignIn(project, config, async (provider) => {
    if (prompter === undefined) {
      return false;
    }
    const answer = await prompter.ask(`wrangler.jsonc already sets AUTH_PROVIDER to "${provider}". Replace it? [y/N] `);
    return /^(y|yes)$/i.test(answer);
  });
  const lines = [...signInSummary(config, written)];
  if (config.kind === 'passkey' && prompter !== undefined) {
    // Offered, printed once and never written anywhere: the owner pastes it at wrangler's own prompt.
    const answer = await prompter.ask('Print a random suggestion for AUTH_SETUP_CODE (not saved anywhere)? [y/N] ');
    if (/^(y|yes)$/i.test(answer)) {
      lines.push(`Suggested AUTH_SETUP_CODE (copy it now; it is not stored): ${suggestSetupCode(new Uint8Array(randomBytes(32)))}`);
    }
  }
  return { written, lines };
}

// The words ----------------------------------------------------------------

/** Everything the owner still has to do for this choice, as plain lines. */
export function signInSummary(config: StudioAuthConfig, outcome: SignInWrite): readonly string[] {
  const lines: string[] = [];
  if (outcome.kind === 'kept') {
    lines.push(`wrangler.jsonc already sets AUTH_PROVIDER to "${outcome.provider}", so it was left as it is. Change it by hand if you want ${config.kind}.`);
  } else if (outcome.kind === 'failed') {
    lines.push(`Could not write the sign-in variables: ${outcome.message}. Add them to cloudflare/wrangler.jsonc vars by hand.`);
  } else if (outcome.kind === 'written') {
    lines.push('Wrote the sign-in settings to studio/cloudflare/wrangler.jsonc (no secrets).');
  }
  lines.push(...studioAuthNextSteps(config));
  return lines;
}

export const SIGN_IN_FLAGS_HELP = `Sign-in (default: GitHub):
  --auth <${STUDIO_AUTH_KINDS.join('|')}>   How people sign in to Studio. Asked when omitted.
  --auth-client-id <id>            google, oidc: the OAuth client ID (never the secret)
  --auth-issuer <https-url>        oidc: the issuer URL
  --auth-name <text>               oidc: the sign-in button's name (default SSO)
  --auth-allowed-domains <list>    google, oidc: only these email domains (comma separated)
  --auth-allowed-emails <list>     google, oidc: only these emails (comma separated)
  --auth-team-domain <host>        access: your Zero Trust team domain (myteam.cloudflareaccess.com)
  --auth-aud <tag>                 access: the Access application's AUD tag
  --auth-custom-domain             access: accept a team domain outside cloudflareaccess.com
  --auth-admin <email|handle>      access, google, oidc: the first admin's email; passkey: a handle (default owner)
Client secrets are never asked for or stored. Add them with wrangler secret put (printed at the end).`;
