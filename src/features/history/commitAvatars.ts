// Author pictures for the history panel's commit rows. A GitHub noreply address names
// its picture directly, so those show at once; every other commit is asked of main (or
// the Studio server) in the background, once per commit, and a row without an answer
// keeps its initials. Nothing here waits on the answer before rendering.
import { useEffect, useRef, useState } from 'react';
import { assert } from '../../../shared/core/assert';
import { COMMIT_AVATAR_LIMITS, githubNoreplyAvatar, parseCommitAvatarResult, type CommitAvatarCommit } from '../../../shared/ipc/commitAvatars';

const FULL_HASH = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
import { parseIpcPayload } from '../../../shared/ipc/ipcPayloads';
import { historyTransport } from '../../ipc/editorEnvironment';
import { gitBranchColor } from '../../lib/gitBranchColors';
import { HISTORY_COMMITS_MAX } from './historyGraph';

/** The palette the graph uses, so an author's colour sits with the branch colours. */
const AUTHOR_COLORS_COUNT = 6;

/** Up to two letters: the first and last words of the name, else the email's start. */
export function authorInitials(name: string, email: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => /\p{L}|\p{N}/u.test(word));
  const first = words[0];
  const last = words.length > 1 ? words[words.length - 1] : undefined;
  let initials: string;
  if (first === undefined) {
    initials = [...(email.split('@')[0] ?? '').replace(/[^\p{L}\p{N}]/gu, '')].slice(0, 2).join('');
  } else {
    initials = [firstLetter(first), last === undefined ? '' : firstLetter(last)].join('');
  }
  const value = initials.toLocaleUpperCase();
  return value.length === 0 ? '?' : value;
}

/** A stable palette index for a person: FNV-1a over the lowercased email (or name). */
export function authorColorIndex(email: string, name: string): number {
  const key = (email.trim() || name.trim()).toLowerCase();
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index++) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const color = hash % AUTHOR_COLORS_COUNT;
  assert(Number.isSafeInteger(color), 'Author colour: integer index');
  assert(color < AUTHOR_COLORS_COUNT, 'Author colour: index inside the palette');
  return color;
}

export function authorColor(email: string, name: string): string {
  return gitBranchColor(authorColorIndex(email, name));
}

/** Avatar URLs by commit hash for the commits shown; grows as answers arrive. */
export function useCommitAvatars(projectPath: string, commits: readonly CommitAvatarCommit[]): ReadonlyMap<string, string> {
  const [avatars, setAvatars] = useState<ReadonlyMap<string, string>>(() => new Map());
  // Commits already asked about for this project, so a refresh never asks twice.
  const asked = useRef<{ readonly projectPath: string; readonly hashes: Set<string> }>({ projectPath, hashes: new Set() });
  useEffect(() => {
    if (asked.current.projectPath !== projectPath) {
      asked.current = { projectPath, hashes: new Set() };
      setAvatars(new Map());
    }
    const hashes = asked.current.hashes;
    const local = new Map<string, string>();
    const remote: CommitAvatarCommit[] = [];
    for (const commit of commits) {
      if (hashes.has(commit.hash)) {
        continue;
      }
      if (hashes.size >= HISTORY_COMMITS_MAX * 2) {
        break;
      }
      hashes.add(commit.hash);
      const url = githubNoreplyAvatar(commit.email);
      if (url === undefined) {
        // Only what the boundary accepts is asked about; anything else keeps its initials.
        if (FULL_HASH.test(commit.hash)) {
          if (commit.email.length <= COMMIT_AVATAR_LIMITS.emailLengthMax) {
            remote.push({ hash: commit.hash, email: commit.email });
          }
        }
      } else {
        local.set(commit.hash, url);
      }
    }
    if (local.size > 0) {
      setAvatars((previous) => new Map([...previous, ...local]));
    }
    let closed = false;
    void (async () => {
      for (let start = 0; start < remote.length; start += COMMIT_AVATAR_LIMITS.commitsMax) {
        const found = await readCommitAvatars(projectPath, remote.slice(start, start + COMMIT_AVATAR_LIMITS.commitsMax));
        if (closed) {
          return;
        }
        if (found.length > 0) {
          setAvatars((previous) => new Map([...previous, ...found.map((avatar) => [avatar.hash, avatar.url] as const)]));
        }
      }
    })();
    return () => {
      closed = true;
    };
  }, [projectPath, commits]);
  return avatars;
}

export async function readCommitAvatars(projectPath: string, commits: readonly CommitAvatarCommit[]) {
  assert(commits.length <= COMMIT_AVATAR_LIMITS.commitsMax, 'Commit avatars: request exceeds its bound');
  if (commits.length === 0) {
    return [];
  }
  const payload = parseIpcPayload('git:avatars', { projectPath, commits });
  try {
    return parseCommitAvatarResult(await historyTransport.avatars(payload));
  } catch {
    // Pictures are decoration: an unavailable or malformed answer leaves the initials.
    return [];
  }
}

function firstLetter(word: string): string {
  return [...word].find((character) => /\p{L}|\p{N}/u.test(character)) ?? '';
}
