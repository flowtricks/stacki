// Commit author pictures for the history panel. The renderer asks for the commits it
// shows; main (or the Studio server) answers with a GitHub avatar URL for each commit it
// could match, and leaves the rest out so the panel draws initials instead. Only GitHub's
// own avatar hosts may appear in an answer: an image URL is a request the renderer makes,
// so a reply naming any other host would send the viewer's address somewhere unreviewed.
import { assert } from '../core/assert';
import { list, pathText, record, text } from '../core/boundary';

export const COMMIT_AVATAR_LIMITS = {
  /** One request covers at most this many commits; the panel asks a page (30) at a time. */
  commitsMax: 100,
  emailLengthMax: 320, // RFC 5321's path limit.
  urlLengthMax: 512,
  /** The pixel size asked of GitHub: 2.5 times the 16px avatar, for high-density screens. */
  sizePixels: 40,
} as const;

/** The image hosts a reply may name, and the only ones the panel loads pictures from. */
export const COMMIT_AVATAR_HOSTS = ['avatars.githubusercontent.com', 'github.com'] as const;

export interface CommitAvatarCommit {
  readonly hash: string;
  readonly email: string;
}

export interface CommitAvatarRequest {
  readonly projectPath: string;
  readonly commits: readonly CommitAvatarCommit[];
}

export interface CommitAvatar {
  readonly hash: string;
  readonly url: string;
}

export type CommitAvatarResult = readonly CommitAvatar[];

export function parseCommitAvatarRequest(input: unknown): CommitAvatarRequest {
  const value = record(input);
  const projectPath = pathText(value['projectPath']);
  assert(projectPath.length > 0, 'Commit avatars: project path is required');
  const commits = list(parseCommitAvatarCommit)(value['commits']);
  if (commits.length > COMMIT_AVATAR_LIMITS.commitsMax) {
    throw new Error('Commit avatars: too many commits');
  }
  return { projectPath, commits };
}

export function parseCommitAvatarResult(input: unknown): CommitAvatarResult {
  const avatars = list(parseCommitAvatar)(input);
  if (avatars.length > COMMIT_AVATAR_LIMITS.commitsMax) {
    throw new Error('Commit avatars: reply exceeds limit');
  }
  const hashes = new Set(avatars.map((avatar) => avatar.hash));
  if (hashes.size !== avatars.length) {
    throw new Error('Commit avatars: duplicate commit');
  }
  return avatars;
}

export function parseCommitHash(input: unknown): string {
  const value = text(input);
  // Full SHA-1 or SHA-256 only: the hash is spliced into a GitHub query, so nothing
  // but hexadecimal digits may reach it.
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) {
    throw new Error('Commit avatars: expected full commit hash');
  }
  return value;
}

/** An `https:` picture on one of GitHub's avatar hosts, with no credentials. */
export function parseAvatarURL(input: unknown): string {
  const value = text(input);
  if (value.length > COMMIT_AVATAR_LIMITS.urlLengthMax) {
    throw new Error('Commit avatars: URL exceeds limit');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Commit avatars: invalid URL');
  }
  if (url.protocol !== 'https:') {
    throw new Error('Commit avatars: URL must use https');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('Commit avatars: URL carries credentials');
  }
  if (url.port !== '') {
    throw new Error('Commit avatars: URL names a port');
  }
  if (!COMMIT_AVATAR_HOSTS.some((host) => host === url.hostname)) {
    throw new Error('Commit avatars: URL is not on a GitHub avatar host');
  }
  return url.href;
}

/**
 * The picture a GitHub noreply address names, with no request: GitHub writes
 * `12345+login@users.noreply.github.com` (newer accounts, by numeric id) or
 * `login@users.noreply.github.com` (older ones). Any other address gives undefined.
 */
export function githubNoreplyAvatar(email: string): string | undefined {
  if (email.length > COMMIT_AVATAR_LIMITS.emailLengthMax) {
    return undefined;
  }
  const match = /^(?:(\d{1,12})\+)?([^@\s]+)@users\.noreply\.github\.com$/i.exec(email.trim());
  if (match === null) {
    return undefined;
  }
  const id = match[1];
  if (id !== undefined) {
    // The id form also covers bots (`49699333+dependabot[bot]@…`), whose login is not a URL path.
    const url = `https://avatars.githubusercontent.com/u/${id}?s=${COMMIT_AVATAR_LIMITS.sizePixels}`;
    assert(parseAvatarURL(url) === url, 'Commit avatars: noreply id URL is canonical');
    return url;
  }
  const login = match[2];
  assert(login !== undefined, 'Commit avatars: the noreply pattern captures a login');
  // GitHub logins: alphanumerics and single inner hyphens, at most 39 characters.
  if (!/^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(login)) {
    return undefined;
  }
  const url = `https://github.com/${login}.png?size=${COMMIT_AVATAR_LIMITS.sizePixels}`;
  assert(parseAvatarURL(url) === url, 'Commit avatars: noreply login URL is canonical');
  return url;
}

/**
 * The picture of a GitHub login, with no request: GitHub serves `<login>.png`.
 * Undefined for anything that is not a login. Used by the Apps panel for an
 * app's author (shared/properties/apps.ts `authorGitHub`, or its repository owner).
 */
export function githubLoginAvatar(login: string): string | undefined {
  if (!/^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(login)) {
    return undefined;
  }
  const url = `https://github.com/${login}.png?size=${COMMIT_AVATAR_LIMITS.sizePixels}`;
  assert(parseAvatarURL(url) === url, 'Commit avatars: login URL is canonical');
  return url;
}

function parseCommitAvatarCommit(input: unknown): CommitAvatarCommit {
  const value = record(input);
  const email = text(value['email']);
  if (email.length > COMMIT_AVATAR_LIMITS.emailLengthMax) {
    throw new Error('Commit avatars: email exceeds limit');
  }
  return { hash: parseCommitHash(value['hash']), email };
}

function parseCommitAvatar(input: unknown): CommitAvatar {
  const value = record(input);
  return { hash: parseCommitHash(value['hash']), url: parseAvatarURL(value['url']) };
}
