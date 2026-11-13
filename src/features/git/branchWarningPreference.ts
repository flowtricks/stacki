/*
 * The branches the person said "don't warn me again" for, per project.
 *
 * Why app storage and not `.stacki/`: `.stacki/` files are tracked project metadata shared with teammates and
 * with Studio, and "I know this branch is fine" is one person's habit, not a fact about the site. It lives where
 * `commitTypePreference.ts` keeps its per-project choice: the app's own storage in the user's data folder.
 * Entries are keyed by the project's path and the branch, so a branch of the same name in another project still asks.
 *
 * Best-effort, as the other stored preferences are: storage that throws or holds something malformed means
 * "ask", which is the safe answer. Bounded: past `BRANCH_WARNING_ENTRIES_MAX` the oldest answer is forgotten,
 * and a forgotten answer only means the warning comes back once.
 */
import { BOUNDARY_LIMITS } from '../../../shared/core/boundary';
import { assert } from '../../../shared/core/assert';

const STORAGE_KEY = 'stacki.git.branchWarnings';

export const BRANCH_WARNING_ENTRIES_MAX = 256;
/** A git branch name is at most 255 bytes in practice; the entry holds a path and a name, so this bounds one entry. */
export const BRANCH_NAME_CHARS_MAX = 255;
const ENTRY_CHARS_MAX = BOUNDARY_LIMITS.pathLengthMax + BRANCH_NAME_CHARS_MAX + 1;
const STORED_CHARS_MAX = BRANCH_WARNING_ENTRIES_MAX * (ENTRY_CHARS_MAX + 4);

/** The separator cannot appear in a branch name (git refuses a newline), so two projects never share an entry. */
const SEPARATOR = '\n';

export function branchWarningEntry(projectPath: string, branch: string): string {
  assert(projectPath.length > 0, 'Branch warning: a project has a path');
  assert(branch.length > 0, 'Branch warning: a branch has a name');
  assert(!branch.includes(SEPARATOR), 'Branch warning: a branch name has no line break');
  return `${projectPath}${SEPARATOR}${branch}`;
}

/** Storage holds what an earlier build wrote, so it is parsed like any input: malformed entries are dropped. */
export function parseStoredBranchWarnings(raw: unknown): readonly string[] {
  if (typeof raw !== 'string' || raw.length > STORED_CHARS_MAX) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const kept: string[] = [];
  for (const entry of parsed.slice(-BRANCH_WARNING_ENTRIES_MAX)) {
    if (typeof entry === 'string' && entry.length > 0 && entry.length <= ENTRY_CHARS_MAX && entry.includes(SEPARATOR)) {
      kept.push(entry);
    }
  }
  assert(kept.length <= BRANCH_WARNING_ENTRIES_MAX, 'Branch warning: the list is bounded');
  return kept;
}

/** The list with this entry added (most recent last), capped. Adding what is there only moves it to the end. */
export function withBranchWarningSilenced(entries: readonly string[], entry: string): readonly string[] {
  const next = [...entries.filter((existing) => existing !== entry), entry].slice(-BRANCH_WARNING_ENTRIES_MAX);
  assert(next.length <= BRANCH_WARNING_ENTRIES_MAX, 'Branch warning: the list stays bounded');
  assert(next.includes(entry), 'Branch warning: the silenced branch is in the list');
  return next;
}

export function isBranchWarningSilenced(projectPath: string, branch: string): boolean {
  try {
    return parseStoredBranchWarnings(localStorage.getItem(STORAGE_KEY)).includes(branchWarningEntry(projectPath, branch));
  } catch {
    return false;
  }
}

export function silenceBranchWarning(projectPath: string, branch: string): void {
  try {
    const entries = withBranchWarningSilenced(parseStoredBranchWarnings(localStorage.getItem(STORAGE_KEY)), branchWarningEntry(projectPath, branch));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    /* noop: an unsaved answer only means the warning comes back next time */
  }
}
