// How a typed component name becomes the real file name and import identifier: one normalizer for the Rename dialog, the Create
// component dialog, new folder names and the CLI (`stacki components rename "Accordion Cards"`), so they cannot disagree.
//
// A person types words. "Accordion Cards", "accordion-cards", "accordion_cards" and "accordionCards" all mean the same component, so
// spaces, hyphens, underscores and dots are separators and the words are joined in the project's own style:
//   pascal   AccordionCards.astro   (the default; the identifier is the file name)
//   kebab    accordion-cards.astro  (when most of the project's files are dashed; the import identifier stays PascalCase)
// Accents are dropped to their base letter (héro is Hero). A character that is no letter, digit or separator (a slash, a quote, an
// emoji, a letter with no Latin base) cannot be mapped to a valid name: the normalizer reports it so the caller can name it, and the
// word break it leaves is only a best guess for callers that choose to be lenient.
import { assert } from '../core/assert';
import { err, ok, type Result } from '../core/result';
import { COMPONENT_ACCESS_LIMITS } from './componentAccess';

export type NamingStyle = 'pascal' | 'kebab';

export interface NormalizedName {
  /** The file name without `.astro`: `AccordionCards` or `accordion-cards`. Empty when nothing usable was typed. */
  readonly fileName: string;
  /** The import identifier and tag: always PascalCase (`AccordionCards`), whatever the file's style. */
  readonly identifier: string;
  /** Characters that cannot be part of a name, each once, in the order typed. */
  readonly rejected: readonly string[];
}

/** Names Astro or Stacki already gives a meaning to; a component cannot take one. */
export const RESERVED_COMPONENT_NAMES: ReadonlySet<string> = new Set(['Fragment', 'Astro', 'Component', 'Props', 'Slot']);

export const NAMING_LIMITS = {
  /** Characters of typed input read; the rest is ignored, so a pasted wall of text costs nothing. */
  inputCharsMax: 256,
} as const satisfies Record<string, number>;

export function normalizeComponentName(input: string, style: NamingStyle): NormalizedName {
  const typed = input.slice(0, NAMING_LIMITS.inputCharsMax).normalize('NFD').replace(/[̀-ͯ]/g, '');
  const rejected: string[] = [];
  const words: string[] = [];
  let word = '';
  for (const character of typed) {
    if (/[A-Za-z0-9]/.test(character)) {
      word += character;
      continue;
    }
    if (!/[\s\-_.]/.test(character) && !rejected.includes(character)) {
      rejected.push(character);
    }
    if (word !== '') {
      words.push(word);
      word = '';
    }
  }
  if (word !== '') {
    words.push(word);
  }
  const identifier = words.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
  const fileName = style === 'pascal' ? identifier : kebabWords(words).join('-');
  assert(fileName.length <= NAMING_LIMITS.inputCharsMax * 2, 'A normalized name is bounded by its input');
  return { fileName, identifier, rejected };
}

// "buttonArrow" is two words to a kebab file name; "ID3" stays one.
function kebabWords(words: readonly string[]): readonly string[] {
  return words.flatMap((part) => part.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' ')).map((part) => part.toLowerCase());
}

/** The import identifier of a component file name: PascalCase names are their own; `accordion-cards` is `AccordionCards`. */
export function identifierOfFileName(fileName: string): string {
  return fileName
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/** Whether a file name (no extension) can be a component: PascalCase, or dashed lowercase, with a valid unreserved identifier. */
export function isComponentFileName(fileName: string): boolean {
  const pascal = /^[A-Z][A-Za-z0-9]*$/.test(fileName);
  const kebab = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(fileName);
  return (pascal || kebab) && !RESERVED_COMPONENT_NAMES.has(identifierOfFileName(fileName));
}

/** The style most of a project's component files are written in: dashed when they outnumber PascalCase ones, else PascalCase. */
export function detectNamingStyle(fileNames: readonly string[]): NamingStyle {
  let dashed = 0;
  let pascal = 0;
  for (const name of fileNames) {
    if (name.includes('-')) {
      dashed += 1;
    } else if (/^[A-Z]/.test(name)) {
      pascal += 1;
    }
  }
  return dashed > pascal ? 'kebab' : 'pascal';
}

/** The style of the folders under the components root: PascalCase when most start with a capital, otherwise lowercase and dashed. */
export function detectFolderStyle(folderNames: readonly string[]): NamingStyle {
  const capitals = folderNames.filter((name) => /^[A-Z]/.test(name)).length;
  return capitals > folderNames.length - capitals ? 'pascal' : 'kebab';
}

/** A typed folder path, each level normalized in `style`. Empty levels are dropped. */
export function normalizeFolderPath(input: string, style: NamingStyle): { readonly path: string; readonly rejected: readonly string[] } {
  const rejected: string[] = [];
  const levels: string[] = [];
  for (const level of input.split('/')) {
    const normalized = normalizeComponentName(level, style);
    for (const character of normalized.rejected) {
      if (!rejected.includes(character)) {
        rejected.push(character);
      }
    }
    if (normalized.fileName !== '') {
      levels.push(normalized.fileName);
    }
  }
  return { path: levels.join('/'), rejected };
}

// A folder under the components root, as the Create and Rename dialogs take it and main checks it again before it writes.
// What is typed is normalized level by level (above), after the refusals a person must be told about: a path that climbs out
// (`..`), one that starts at the disk (`/x`, `C:\x`, `~/x`), an empty level (`a//b`), or a character no name can hold. Backslashes
// count as slashes and a trailing slash is dropped, so `Global\Layout\` is `Global/Layout`. A level that differs from an existing
// folder only in case takes the existing spelling: on a Mac `forms` and `Forms` are one folder, and two spellings would split a
// group in the Components panel.

/** Why a typed folder cannot be used; the dialogs word it (renameAvailability.ts). */
export type FolderPathProblem =
  | { readonly kind: 'empty' }
  | { readonly kind: 'absolute' }
  | { readonly kind: 'parent' }
  | { readonly kind: 'empty-level' }
  | { readonly kind: 'character'; readonly character: string }
  | { readonly kind: 'too-long' }
  | { readonly kind: 'too-deep' };

/** Characters no file system level may hold (Windows' reserved set and control characters), checked on every folder main writes. */
const FOLDER_ILLEGAL = /[<>:"|?*\u0000-\u001f]/;

/** A typed folder below the components root: `ok` with its normalized path (`/`-separated, no leading or trailing slash), or why not. */
export function parseTypedFolderPath(input: string, style: NamingStyle, existing: readonly string[] = []): Result<string, FolderPathProblem> {
  const typed = input.slice(0, NAMING_LIMITS.inputCharsMax).trim().replaceAll('\\', '/');
  if (typed === '') {
    return err({ kind: 'empty' });
  }
  if (typed.startsWith('/') || typed.startsWith('~') || /^[A-Za-z]:/.test(typed)) {
    return err({ kind: 'absolute' });
  }
  const levels = typed.replace(/\/+$/, '').split('/');
  const normalized: string[] = [];
  for (const level of levels) {
    const trimmed = level.trim();
    if (trimmed === '') {
      return err({ kind: 'empty-level' });
    }
    if (trimmed === '.' || trimmed === '..') {
      return err({ kind: 'parent' });
    }
    const name = normalizeComponentName(trimmed, style);
    const stray = name.rejected[0];
    if (stray !== undefined) {
      return err({ kind: 'character', character: stray });
    }
    if (name.fileName === '') {
      return err({ kind: 'empty-level' });
    }
    normalized.push(name.fileName);
  }
  const folded = foldFolderCase(normalized, existing);
  const problem = componentFolderProblem(folded);
  if (problem !== undefined) {
    return err(problem);
  }
  assert(!folded.startsWith('/'), 'A typed folder is relative to the components root');
  assert(!folded.split('/').includes('..'), 'A typed folder never climbs out of the components root');
  return ok(folded);
}

/**
 * Whether a folder below the components root can be written to as it stands, for a folder chosen from the list (whatever its
 * spelling on disk) and for main's own check. `''` is the root itself. Undefined when it can.
 */
export function componentFolderProblem(folder: string): FolderPathProblem | undefined {
  if (folder === '') {
    return undefined;
  }
  if (folder.length > COMPONENT_ACCESS_LIMITS.pathCharsMax) {
    return { kind: 'too-long' };
  }
  if (folder.startsWith('/') || /^[A-Za-z]:/.test(folder) || folder.includes('\\')) {
    return { kind: 'absolute' };
  }
  const levels = folder.split('/');
  if (levels.length > COMPONENT_ACCESS_LIMITS.pathDepthMax) {
    return { kind: 'too-deep' };
  }
  for (const level of levels) {
    if (level === '') {
      return { kind: 'empty-level' };
    }
    if (level === '.' || level === '..') {
      return { kind: 'parent' };
    }
    const illegal = FOLDER_ILLEGAL.exec(level);
    if (illegal !== null) {
      return { kind: 'character', character: illegal[0] };
    }
  }
  return undefined;
}

/** The boundary parser for a folder crossing into main: a string `componentFolderProblem` accepts, else a throw. */
export function parseComponentSubfolder(input: unknown): string {
  if (typeof input !== 'string') {
    throw new Error('A component folder is a string');
  }
  const problem = componentFolderProblem(input);
  if (problem !== undefined) {
    throw new Error(`"${input.slice(0, NAMING_LIMITS.inputCharsMax)}" is not a folder under the components folder (${problem.kind})`);
  }
  return input;
}

// Level by level, the spelling of an existing folder that differs only in case. Below a level with no match nothing can match
// either (a new folder has nothing in it yet), so those levels keep the spelling typed.
function foldFolderCase(levels: readonly string[], existing: readonly string[]): string {
  assert(levels.length > 0, 'foldFolderCase: a path has a level');
  const known = new Map(existing.map((folder) => [folder.toLowerCase(), folder] as const));
  const folded: string[] = [];
  for (const level of levels) {
    const candidate = [...folded, level].join('/');
    const match = known.get(candidate.toLowerCase());
    if (match === undefined) {
      folded.push(level);
      continue;
    }
    const spelled = match.slice(match.lastIndexOf('/') + 1);
    folded.push(spelled);
  }
  assert(folded.length === levels.length, 'foldFolderCase: folding keeps every level');
  return folded.join('/');
}
