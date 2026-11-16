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
