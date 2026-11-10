// The project's `.stacki/styles.json`: class and id names, and whole
// stylesheets or folders of them, that the unused-selector cleanup must never
// remove. It is a tracked project setting, shared by Desktop, Studio and the
// `check-project` command, so every tool answers "may this go?" the same way.
import { assert } from '../core/assert';
import { list, record, text } from '../core/boundary';

export const STYLE_KEEP_LIMITS = {
  /** Patterns in one keep list. A design system's state classes fit in dozens. */
  patternsMax: 1_000,
  /** Characters in one pattern: a class name with room for a wildcard. */
  patternCharsMax: 128,
  /** Locked stylesheets and folders. A project locks a handful of libraries. */
  lockedStylesheetsMax: 500,
  /** Characters in one locked path, project-relative. */
  lockedPathCharsMax: 512,
  /** Folder levels in one locked path; deeper paths are not project stylesheets. */
  lockedPathSegmentsMax: 32,
} as const satisfies Record<string, number>;

export interface StyleKeepList {
  readonly version: 1;
  /** Class or id names, `*` matching any run of characters (`is-*`). */
  readonly keep: readonly string[];
  /**
   * Project-relative stylesheets (`src/styles/patterns.css`) and folders
   * (`src/styles/`, ending in `/`) whose selectors the cleanup never removes.
   * A folder covers every file under it, including files added later.
   */
  readonly lockedStylesheets: readonly string[];
}

export const EMPTY_KEEP_LIST: StyleKeepList = { version: 1, keep: [], lockedStylesheets: [] };

// A pattern is a selector name as it appears unescaped in markup. Whitespace,
// quotes and commas would let one entry silently mean several names.
const PATTERN = /^[^\s"'`,{}<>]+$/;

export function parseStyleKeepList(input: unknown): StyleKeepList {
  const value = record(input);
  if (value['version'] !== 1) {
    throw new Error('Unsupported styles settings version');
  }
  const keep = value['keep'] === undefined ? [] : list(keepPattern)(value['keep']);
  if (keep.length > STYLE_KEEP_LIMITS.patternsMax) {
    throw new Error(`Keep list exceeds ${STYLE_KEEP_LIMITS.patternsMax} patterns`);
  }
  // Absent in files written before stylesheets could be locked: nothing is locked.
  const lockedStylesheets = value['lockedStylesheets'] === undefined ? [] : list(lockedPath)(value['lockedStylesheets']);
  if (lockedStylesheets.length > STYLE_KEEP_LIMITS.lockedStylesheetsMax) {
    throw new Error(`Locked stylesheets exceed ${STYLE_KEEP_LIMITS.lockedStylesheetsMax} paths`);
  }
  // An earlier version also stored `trustedScripts`; scripts no longer affect
  // the check, so a file that still has the key reads the same and loses it on
  // its next save.
  return { version: 1, keep, lockedStylesheets };
}

/** The keep list as JSON text, in the stable shape a diff reviews easily. */
export function serializeStyleKeepList(keepList: StyleKeepList): string {
  const keep = [...new Set(keepList.keep)].sort();
  const lockedStylesheets = [...new Set(keepList.lockedStylesheets)].sort();
  // The key is written only when something is locked, so a project that never
  // locks a stylesheet keeps the file shape it always had.
  const shape = lockedStylesheets.length === 0 ? { version: 1, keep } : { version: 1, keep, lockedStylesheets };
  const source = JSON.stringify(shape, undefined, 2) + '\n';
  // Pair assertion: what is written must read back as the same list.
  const written: unknown = JSON.parse(source);
  const reread = parseStyleKeepList(written);
  assert(reread.keep.length === keep.length, 'serializeStyleKeepList: keep patterns round-trip');
  assert(reread.lockedStylesheets.length === lockedStylesheets.length, 'serializeStyleKeepList: locked stylesheets round-trip');
  return source;
}

/** Whether a locked path names a folder (every stylesheet under it) rather than one file. */
export function isLockedFolder(lockedPath: string): boolean {
  return lockedPath.endsWith('/');
}

/**
 * The lock that covers a project-relative stylesheet: its own file entry, else
 * the nearest locked folder above it. Undefined when the cleanup may touch it.
 */
export function stylesheetLock(keepList: StyleKeepList, rel: string): string | undefined {
  assert(rel !== '', 'stylesheetLock: the stylesheet is named');
  assert(!rel.endsWith('/'), 'stylesheetLock: a stylesheet is a file, not a folder');
  return pathLock(keepList, rel);
}

/** The lock that covers a folder (`src/styles/`): its own entry, else the nearest locked folder above it. */
export function folderLock(keepList: StyleKeepList, folder: string): string | undefined {
  assert(isLockedFolder(folder), 'folderLock: a folder path ends in /');
  return pathLock(keepList, folder);
}

/** A matcher from stylesheet path to whether the cleanup must leave it alone. */
export function stylesheetLockMatcher(keepList: StyleKeepList): (rel: string) => boolean {
  if (keepList.lockedStylesheets.length === 0) {
    return () => false;
  }
  const files = new Set(keepList.lockedStylesheets.filter((entry) => !isLockedFolder(entry)));
  const folders = keepList.lockedStylesheets.filter(isLockedFolder);
  assert(files.size + folders.length <= STYLE_KEEP_LIMITS.lockedStylesheetsMax, 'stylesheetLockMatcher: the parser bounds locked paths');
  return (rel) => {
    if (files.has(rel)) {
      return true;
    }
    return folders.some((folder) => rel.startsWith(folder));
  };
}

// The longest entry wins, so a file's own lock is reported before a folder's,
// and an inner folder before an outer one.
function pathLock(keepList: StyleKeepList, target: string): string | undefined {
  let best: string | undefined;
  for (const entry of keepList.lockedStylesheets) {
    const covers = entry === target || (isLockedFolder(entry) && target.startsWith(entry));
    if (covers) {
      if (best === undefined || entry.length > best.length) {
        best = entry;
      }
    }
  }
  return best;
}

/** A matcher for the keep list's patterns; exact names are a set lookup. */
export function keepMatcher(keepList: StyleKeepList): (name: string) => boolean {
  const exact = new Set<string>();
  const wildcards: RegExp[] = [];
  for (const pattern of keepList.keep) {
    if (pattern.includes('*')) {
      const body = pattern
        .split('*')
        .map((part) => part.replace(/[\\^$.+?()[\]{}|/]/g, '\\$&'))
        .join('.*');
      wildcards.push(new RegExp(`^${body}$`));
    } else {
      exact.add(pattern);
    }
  }
  assert(exact.size + wildcards.length <= STYLE_KEEP_LIMITS.patternsMax, 'keepMatcher: the parser bounds patterns');
  return (name) => {
    if (exact.has(name)) {
      return true;
    }
    return wildcards.some((wildcard) => wildcard.test(name));
  };
}

function keepPattern(input: unknown): string {
  const value = text(input);
  if (value.length === 0 || value.length > STYLE_KEEP_LIMITS.patternCharsMax) {
    throw new Error(`Keep patterns must be 1 to ${STYLE_KEEP_LIMITS.patternCharsMax} characters`);
  }
  if (!PATTERN.test(value)) {
    throw new Error(`Keep pattern "${value}" contains whitespace, quotes or commas`);
  }
  if (value.replaceAll('*', '').length === 0) {
    throw new Error('A keep pattern must name more than a wildcard');
  }
  return value;
}

// A locked path is written the way the selector report names files:
// project-relative, `/`-separated, with no `.` or `..` step that could reach
// outside the project or make two spellings of one path.
function lockedPath(input: unknown): string {
  const value = text(input);
  if (value.length === 0 || value.length > STYLE_KEEP_LIMITS.lockedPathCharsMax) {
    throw new Error(`Locked stylesheet paths must be 1 to ${STYLE_KEEP_LIMITS.lockedPathCharsMax} characters`);
  }
  if (value.startsWith('/') || value.includes('\\') || /^[A-Za-z]:/.test(value)) {
    throw new Error(`Locked stylesheet path "${value}" must be relative to the project, with / between folders`);
  }
  const segments = (isLockedFolder(value) ? value.slice(0, -1) : value).split('/');
  if (segments.length > STYLE_KEEP_LIMITS.lockedPathSegmentsMax) {
    throw new Error(`Locked stylesheet path "${value}" is nested more than ${STYLE_KEEP_LIMITS.lockedPathSegmentsMax} folders deep`);
  }
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error(`Locked stylesheet path "${value}" has an empty, . or .. step`);
    }
  }
  return value;
}
