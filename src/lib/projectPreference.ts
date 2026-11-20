/*
 * A person's remembered choice, kept per project in this app's local storage: the Assets panel's view
 * and sort, the Style selectors panel's tab. They are a way of looking at the project, not part of the
 * site, so they never go in a tracked `.stacki/` file.
 *
 * One storage key holds one short list of [project, value] pairs, newest first. Opening many projects
 * forgets the least recently changed first; that bounds the list, never a project's content. Storage is
 * shared with every earlier build, so what it holds is parsed like any input (a value the panel's own
 * parser refuses is treated as absent), and missing, full or blocked storage never stops a panel from drawing.
 */
import { assert } from '../../shared/core/assert';

/** One project's identity is a path or a workspace id; anything longer is not one. */
const PROJECT_KEY_CHARS_MAX = 4096;

/** What differs between preferences: where they live, how many projects are kept, and what a value looks like. */
export interface ProjectPreferenceSpec<Value> {
  readonly storageKey: string;
  /** Projects whose choice is remembered; the least recently changed is forgotten first. */
  readonly projectsMax: number;
  /** The value, or `undefined` when the stored one is not a valid choice. */
  readonly parseValue: (stored: unknown) => Value | undefined;
}

export type StoredProjectPreferences<Value> = ReadonlyArray<readonly [string, Value]>;

export type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** The stored list, or an empty one: unreadable, malformed or oversized entries are dropped, never trusted. */
export function parseStoredPreferences<Value>(
  raw: unknown,
  spec: Pick<ProjectPreferenceSpec<Value>, 'parseValue' | 'projectsMax'>,
): StoredProjectPreferences<Value> {
  assert(spec.projectsMax > 0, 'A preference remembers at least one project');
  if (typeof raw !== 'string') {
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
  // Read as unknowns: `Array.isArray` narrows to `any[]`, which would let an entry through unchecked.
  const stored: readonly unknown[] = parsed;
  const entries: Array<readonly [string, Value]> = [];
  for (const entry of stored.slice(0, spec.projectsMax)) {
    const pair = parsePair(entry, spec.parseValue);
    if (pair !== undefined && !entries.some(([project]) => project === pair[0])) {
      entries.push(pair);
    }
  }
  assert(entries.length <= spec.projectsMax, 'The stored list stays within its project count');
  return entries;
}

function parsePair<Value>(entry: unknown, parseValue: (stored: unknown) => Value | undefined): readonly [string, Value] | undefined {
  if (!Array.isArray(entry)) {
    return undefined;
  }
  const pair: readonly unknown[] = entry;
  if (pair.length !== 2) {
    return undefined;
  }
  const project = pair[0];
  if (typeof project !== 'string' || project.length === 0 || project.length > PROJECT_KEY_CHARS_MAX) {
    return undefined;
  }
  const value = parseValue(pair[1]);
  return value === undefined ? undefined : [project, value];
}

/** The project's remembered value, or `undefined` when none is stored. */
export function loadProjectPreference<Value>(spec: ProjectPreferenceSpec<Value>, project: string, storage?: PreferenceStorage): Value | undefined {
  try {
    // Inside the try: where storage is missing altogether, even naming it throws.
    return parseStoredPreferences((storage ?? localStorage).getItem(spec.storageKey), spec).find(([stored]) => stored === project)?.[1];
  } catch {
    return undefined;
  }
}

/** Remembers the project's value, first in the list. */
export function saveProjectPreference<Value>(spec: ProjectPreferenceSpec<Value>, project: string, value: Value, storage?: PreferenceStorage): void {
  assert(project.length > 0, 'A remembered choice belongs to a project');
  try {
    const target = storage ?? localStorage;
    const others = parseStoredPreferences(target.getItem(spec.storageKey), spec).filter(([stored]) => stored !== project);
    const first: readonly [string, Value] = [project, value];
    const next: StoredProjectPreferences<Value> = [first, ...others].slice(0, spec.projectsMax);
    target.setItem(spec.storageKey, JSON.stringify(next));
  } catch {
    /* noop: an unsaved choice lasts until the panel closes */
  }
}
