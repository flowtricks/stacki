/*
 * The commit type each project last used, remembered for this person.
 *
 * A way of writing commits is a habit per site, not per app: one project may
 * follow Conventional Commits while another never does, so the choice is kept
 * per project. Only the type is kept; a scope or a breaking mark describes one
 * commit, so carrying it into the next would put words in the person's mouth.
 * Nothing here ever picks a type on its own: an absent or unreadable entry is
 * "no type", and "no type" is stored by removing the entry.
 *
 * Best-effort, as `src/features/style/model/toolPreferences.ts` is: storage
 * that throws or holds something malformed falls back to no preference.
 */
import { BOUNDARY_LIMITS } from '../../../shared/core/boundary';
import { assert } from '../../../shared/core/assert';
import { parseCommitTypeName, type CommitTypeName } from './commitType';

const COMMIT_TYPES_KEY = 'stacki.git.commitTypes';

// The projects remembered at once. The oldest choice is forgotten first; a
// forgotten project only falls back to "no type", which is the default anyway.
export const COMMIT_TYPE_PROJECTS_MAX = 64;
// Every entry is a bounded path and a short type name, so this bounds the whole map.
const COMMIT_TYPES_CHARS_MAX = COMMIT_TYPE_PROJECTS_MAX * (BOUNDARY_LIMITS.pathLengthMax + 32);

/** The stored project → type map; malformed entries are dropped, not trusted. */
export type CommitTypeChoices = ReadonlyMap<string, CommitTypeName>;

/**
 * The key a project's choice is kept under. Studio sends every project's git
 * requests through the same path ('studio'), so the name is part of the key to
 * keep two Studio projects apart; on Desktop the path alone already would.
 */
export function commitTypeProjectKey(project: { readonly path: string; readonly name: string }): string {
  assert(project.path.length > 0, 'Commit type preference: a project has a path');
  return `${project.path}\n${project.name}`;
}

/** Storage holds what any earlier build wrote, so it is parsed like any input. */
export function parseStoredCommitTypes(raw: unknown): CommitTypeChoices {
  const choices = new Map<string, CommitTypeName>();
  if (typeof raw !== 'string') {
    return choices;
  }
  if (raw.length > COMMIT_TYPES_CHARS_MAX) {
    return choices;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return choices;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return choices;
  }
  for (const [project, value] of Object.entries(parsed).slice(-COMMIT_TYPE_PROJECTS_MAX)) {
    const type = parseCommitTypeName(value);
    if (type !== undefined && project.length > 0 && project.length <= BOUNDARY_LIMITS.pathLengthMax * 2) {
      choices.set(project, type);
    }
  }
  assert(choices.size <= COMMIT_TYPE_PROJECTS_MAX, 'Commit type preference: the map is bounded');
  return choices;
}

/** The choices with this project's set (or cleared), most recent last, capped. */
export function withCommitType(choices: CommitTypeChoices, project: string, type: CommitTypeName | undefined): CommitTypeChoices {
  const next = new Map(choices);
  next.delete(project);
  if (type !== undefined) {
    next.set(project, type);
  }
  const kept = new Map([...next].slice(-COMMIT_TYPE_PROJECTS_MAX));
  assert(kept.size <= COMMIT_TYPE_PROJECTS_MAX, 'Commit type preference: the map stays bounded');
  assert(kept.get(project) === type, 'Commit type preference: the project holds the chosen type');
  return kept;
}

export function loadCommitType(project: string): CommitTypeName | undefined {
  try {
    return parseStoredCommitTypes(localStorage.getItem(COMMIT_TYPES_KEY)).get(project);
  } catch {
    return undefined;
  }
}

export function saveCommitType(project: string, type: CommitTypeName | undefined): void {
  try {
    const choices = withCommitType(parseStoredCommitTypes(localStorage.getItem(COMMIT_TYPES_KEY)), project, type);
    localStorage.setItem(COMMIT_TYPES_KEY, JSON.stringify(Object.fromEntries(choices)));
  } catch {
    /* noop: an unsaved preference only means the next session starts with no type */
  }
}
