// Who is using the editor, as an app may know them (`person.get`, docs/apps.md
// "The person"). Desktop's main process and the Studio server both answer from
// here (studio/scripts/shared-source.json), so one person in one project has the
// same id in either editor whenever they are known by the same account.
//
// - The id is a SHA-256 prefix of the project and the person. The project is its
//   `origin` remote, normalized, so every clone of a repository agrees; a
//   project without one falls back to its folder's real path. The person is
//   their GitHub account when known, else their Git email, else a key the host
//   keeps for this computer. Hiding their details never changes the id.
// - The name and email are Git's `user.name` and `user.email` as the project
//   sees them: the identity already written into every commit they make.
// - What is hidden is decided by the caller, which knows the person's choice.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { assert } from '../../shared/core/assert';
import { APP_PERSON_LIMITS, parseAppPerson, type AppCommitAuthor, type AppPerson } from '../../shared/properties/appsRpc';
import { git } from '../lib/nodeTools';

const PERSON_LIMITS = {
  /** How long a Git question may take before the detail reads as unknown. */
  gitTimeoutMs: 5_000,
  /** Commits `people.list` reads its authors from: the recent history, where the people working on the site are. */
  authorCommitsMax: 1000,
} as const satisfies Record<string, number>;

/** The person's details as the host knows them, before the id is made. */
export interface AppPersonDetails {
  readonly name: string | undefined;
  readonly email: string | undefined;
  readonly github: string | undefined;
}

/** A person, with only the id when `hidden`. */
export function appPerson(projectKey: string, details: AppPersonDetails, fallbackPersonKey: string, options: { readonly hidden: boolean }): AppPerson {
  const id = appPersonId(projectKey, personKeyOf(details, fallbackPersonKey));
  const person: AppPerson = options.hidden
    ? { id, name: undefined, email: undefined, github: undefined }
    : { id, name: bounded(details.name), email: bounded(details.email), github: details.github };
  // The value crosses to an app: it must parse as the contract says.
  assert(parseAppPerson(person).id === id, 'A person reads back as made');
  return person;
}

/** The person's id in a project: stable, and the same from every app. */
export function appPersonId(projectKey: string, personKey: string): string {
  assert(projectKey.length > 0, 'A person id names its project');
  assert(personKey.length > 0, 'A person id names its person');
  const id = createHash('sha256').update(`stacki-app-person/v1\n${projectKey}\n${personKey}`).digest('hex').slice(0, APP_PERSON_LIMITS.idChars);
  assert(id.length === APP_PERSON_LIMITS.idChars, 'A person id has its full length');
  return id;
}

function personKeyOf(details: AppPersonDetails, fallback: string): string {
  if (details.github !== undefined) {
    return `github:${details.github.toLowerCase()}`;
  }
  if (details.email !== undefined) {
    return `email:${details.email.toLowerCase()}`;
  }
  return `device:${fallback}`;
}

/** The project as every clone names it: its `origin` remote without scheme, credentials or `.git`; else its real path. */
export async function appProjectKey(projectRoot: string): Promise<string> {
  const remote = await gitConfig(projectRoot, 'remote.origin.url');
  if (remote !== undefined) {
    return `remote:${normalizeRemote(remote)}`;
  }
  return `path:${fs.realpathSync(projectRoot)}`;
}

/** `git@github.com:Acme/Site.git` and `https://user@github.com/acme/site` both read `github.com/acme/site`. */
export function normalizeRemote(remote: string): string {
  const trimmed = remote.trim();
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(trimmed);
  const joined = scp === null ? trimmed.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]*@/, '') : `${scp[1] ?? ''}/${scp[2] ?? ''}`;
  return joined
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** Git's name and email for the project; undefined for each that is unset. */
export async function readGitPerson(projectRoot: string): Promise<{ readonly name: string | undefined; readonly email: string | undefined }> {
  const [name, email] = await Promise.all([gitConfig(projectRoot, 'user.name'), gitConfig(projectRoot, 'user.email')]);
  return { name, email };
}

async function gitConfig(projectRoot: string, key: string): Promise<string | undefined> {
  try {
    const value = (await git(projectRoot, ['config', '--get', key], { timeout: PERSON_LIMITS.gitTimeoutMs })).stdout.trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined; // Unset, or not a repository: the detail is unknown.
  }
}

/**
 * The authors of the project's recent commits, newest first, each once (by
 * email), as Git records them: `people.list` decides what of them an app hears
 * (shared/properties/appsRpc.ts appMembers). Not a repository, or Git failing,
 * reads as no authors.
 */
export async function readGitAuthors(projectRoot: string): Promise<readonly AppCommitAuthor[]> {
  let output = '';
  try {
    const args = ['log', `--max-count=${PERSON_LIMITS.authorCommitsMax}`, '--format=%an%x1f%ae'];
    output = (await git(projectRoot, args, { timeout: PERSON_LIMITS.gitTimeoutMs })).stdout;
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const authors: AppCommitAuthor[] = [];
  for (const line of output.split('\n').slice(0, PERSON_LIMITS.authorCommitsMax)) {
    const [name = '', email = ''] = line.split('\x1f');
    const key = email.trim().toLowerCase() || name.trim().toLowerCase();
    if (key === '' || seen.has(key)) {
      continue;
    }
    seen.add(key);
    authors.push({ name: name.trim() || undefined, email: email.trim() || undefined });
  }
  assert(authors.length <= PERSON_LIMITS.authorCommitsMax, 'Authors are bounded by the commits read');
  return authors;
}

function bounded(detail: string | undefined): string | undefined {
  if (detail === undefined) {
    return undefined;
  }
  return detail.slice(0, APP_PERSON_LIMITS.detailCharsMax);
}
