// What Settings → Roles shows, kept per project in memory so the tab paints its real cards in the first frame
// and refreshes behind them (stale-while-revalidate, docs/ui-loading.md).
//
// Why: the tab used to wait for two reads before drawing anything, the roles file and the signed-in GitHub
// login. The login comes from `gh auth status`, which asks GitHub and takes about a second whenever main's
// one-minute cache has lapsed, so nearly every open showed "Loading roles…" for that long. Now the role loader
// (useProjectRoles.ts) fills the file half on project open and on every file change, the project-open prefetch
// fills the login half, and the tab only revalidates.
//
// The two halves are separate because they answer at very different speeds: the cards never wait on the login.
// A login that is not known yet is `unknown`, never "signed out", so the signed-out notice cannot flash.
// Framework-free; React callers use `useRolesSnapshot`.
import { useSyncExternalStore } from 'react';
import { assert } from '../../../shared/core/assert';
import { readRolesIdentity, readStoredRoles, type StoredRoles } from './rolesBridge';

export const ROLES_CACHE_LIMITS = {
  /** Projects remembered at once, most recent kept; the app has one open per window. */
  projectsMax: 8,
  /** Listeners are mounted readers; a leak past this is a bug, not growth. */
  listenersMax: 100,
} as const satisfies Record<string, number>;

export type RolesFileState = { readonly kind: 'unknown' } | { readonly kind: 'known'; readonly stored: StoredRoles };
export type RolesIdentityState = { readonly kind: 'unknown' } | { readonly kind: 'known'; readonly login: string | undefined };

/** One project's last-known roles file and login. Replaced, never mutated, so it is a stable React snapshot. */
export interface RolesSnapshot {
  readonly file: RolesFileState;
  readonly identity: RolesIdentityState;
}

export const EMPTY_ROLES_SNAPSHOT: RolesSnapshot = { file: { kind: 'unknown' }, identity: { kind: 'unknown' } };

export interface RolesReaders {
  readonly readRoles: (projectPath: string) => Promise<StoredRoles>;
  readonly readIdentity: (projectPath: string) => Promise<string | undefined>;
}

export interface RolesCache {
  readonly snapshot: (projectPath: string) => RolesSnapshot;
  /** Records a file the caller already holds (a save's own text), without a read. */
  readonly rememberStoredRoles: (projectPath: string, stored: StoredRoles) => void;
  /** Reads the file again. The newest read started wins: an older one that answers late is dropped. A failed read keeps what is known and rejects. */
  readonly refreshStoredRoles: (projectPath: string) => Promise<StoredRoles>;
  /** Reads the login again; callers asking while a read is under way share it. A failed read is known as signed out, as it always was. */
  readonly refreshRolesIdentity: (projectPath: string) => Promise<string | undefined>;
  /** Fills whatever half is still unknown, ahead of the first open. */
  readonly prewarm: (projectPath: string) => Promise<void>;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createRolesCache(readers: RolesReaders): RolesCache {
  // Insertion order is recency: a write moves the project to the end, and the first key is the oldest.
  const entries = new Map<string, RolesSnapshot>();
  const fileReads = new Map<string, number>();
  const identityReads = new Map<string, Promise<string | undefined>>();
  const listeners = new Set<() => void>();
  let readSequence = 0;

  const snapshot = (projectPath: string): RolesSnapshot => entries.get(projectPath) ?? EMPTY_ROLES_SNAPSHOT;
  const publish = (projectPath: string, next: RolesSnapshot): void => {
    assert(projectPath.length > 0, 'Roles are cached for an open project');
    entries.delete(projectPath);
    entries.set(projectPath, next);
    if (entries.size > ROLES_CACHE_LIMITS.projectsMax) {
      const oldest = entries.keys().next().value;
      assert(oldest !== undefined, 'A full roles cache has an oldest project');
      entries.delete(oldest);
    }
    assert(entries.size <= ROLES_CACHE_LIMITS.projectsMax, 'The roles cache stays within its project bound');
    for (const listener of [...listeners]) {
      listener();
    }
  };
  const rememberStoredRoles = (projectPath: string, stored: StoredRoles): void => {
    // What the caller holds is newer than any read already under way, which is dropped when it answers.
    fileReads.delete(projectPath);
    const previous = snapshot(projectPath);
    if (previous.file.kind === 'known' && sameStoredRoles(previous.file.stored, stored)) {
      return;
    }
    publish(projectPath, { ...previous, file: { kind: 'known', stored } });
  };
  const rememberIdentity = (projectPath: string, login: string | undefined): void => {
    const previous = snapshot(projectPath);
    if (previous.identity.kind === 'known' && previous.identity.login === login) {
      return;
    }
    publish(projectPath, { ...previous, identity: { kind: 'known', login } });
  };
  const refreshStoredRoles = async (projectPath: string): Promise<StoredRoles> => {
    assert(projectPath.length > 0, 'Roles are read for an open project');
    readSequence += 1;
    const mine = readSequence;
    fileReads.set(projectPath, mine);
    const stored = await readers.readRoles(projectPath);
    if (fileReads.get(projectPath) === mine) {
      fileReads.delete(projectPath);
      rememberStoredRoles(projectPath, stored);
    }
    return stored;
  };
  const refreshRolesIdentity = (projectPath: string): Promise<string | undefined> => {
    assert(projectPath.length > 0, 'A login is read for an open project');
    const running = identityReads.get(projectPath);
    if (running !== undefined) {
      return running;
    }
    const read = readers
      .readIdentity(projectPath)
      .catch(() => undefined)
      .then((login) => {
        identityReads.delete(projectPath);
        rememberIdentity(projectPath, login);
        return login;
      });
    identityReads.set(projectPath, read);
    assert(identityReads.size <= ROLES_CACHE_LIMITS.projectsMax, 'Login reads in flight are bounded by the open projects');
    return read;
  };
  const prewarm = async (projectPath: string): Promise<void> => {
    const known = snapshot(projectPath);
    const reads: Promise<unknown>[] = [];
    if (known.file.kind === 'unknown') {
      // A failed read leaves the half unknown: the tab reads again when it opens and reports the failure itself.
      reads.push(refreshStoredRoles(projectPath).catch(() => undefined));
    }
    if (known.identity.kind === 'unknown') {
      reads.push(refreshRolesIdentity(projectPath));
    }
    await Promise.all(reads);
  };
  const subscribe = (listener: () => void): (() => void) => {
    assert(listeners.size < ROLES_CACHE_LIMITS.listenersMax, 'Roles cache listeners are bounded');
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  return { snapshot, rememberStoredRoles, refreshStoredRoles, refreshRolesIdentity, prewarm, subscribe };
}

/** Two reads of the file agree when they hold the same text (an absent file has none). */
export function sameStoredRoles(left: StoredRoles, right: StoredRoles): boolean {
  if (left.kind === 'absent') {
    return right.kind === 'absent';
  }
  if (right.kind === 'absent') {
    return false;
  }
  return left.kind === right.kind && left.source === right.source;
}

/** The text a save must witness for this read, undefined when there is no file. */
export function storedRolesSource(stored: StoredRoles): string | undefined {
  return stored.kind === 'absent' ? undefined : stored.source;
}

/** The app's one cache, read through the real bridge. */
export const rolesCache = createRolesCache({ readRoles: readStoredRoles, readIdentity: readRolesIdentity });

/** Fills the Roles tab's cache on project open (desktopPanelReads in AppShell.tsx). */
export function prewarmProjectRoles(projectPath: string): Promise<void> {
  return rolesCache.prewarm(projectPath);
}

export function useRolesSnapshot(projectPath: string): RolesSnapshot {
  const read = () => rolesCache.snapshot(projectPath);
  return useSyncExternalStore(rolesCache.subscribe, read, read);
}
