// The type declarations a component's props come from. A component writes `testimonial: Testimonial` with
// `Testimonial` imported from `@lib/cms`, and the prop model can only draw a sample from a type it can read.
// This follows the component's imports (relative, or through the project's tsconfig `paths`) to the files
// that declare types, and returns their text as the `prelude` the model reads alongside the frontmatter.
// It reads source text only and never runs it; a file it cannot find or read is skipped, and the prop
// then falls back to a sample by its name.

import * as path from 'node:path';
import { assert } from '../../shared/core/assert';

export const PRELUDE_LIMITS = {
  /** Files followed, counting re-exports and the imports of those files. */
  filesMax: 24,
  /** How far an import of an import is followed. */
  depthMax: 3,
  aliasesMax: 64,
} as const;

/** How the project's files are read; a test supplies a fake, the dev server supplies the disk. */
export interface PreludeFiles {
  /** The text of a file, or undefined when there is none (or it cannot be read). Absolute path. */
  readonly read: (file: string) => string | undefined;
}

export interface PathAliases {
  /** `@lib/*` → `[./src/lib/*]`, relative to `baseDirectory`. */
  readonly patterns: ReadonlyMap<string, readonly string[]>;
  readonly baseDirectory: string;
}

const TYPE_FILE_SUFFIXES = ['', '.ts', '.d.ts', '.tsx', '.astro', '.css', '.scss', '.json', '/index.ts', '/index.d.ts', '/index.js'] as const;
const IMPORT_SPECIFIER = /(?:^|[\s;}])(?:import|export)\s+(?:type\s+)?(?:[\w*\s{},$]*?)\s*from\s*['"]([^'"\n]+)['"]/g;

/** The project's `compilerOptions.paths` and `baseUrl`, tolerant of comments and trailing commas; none when absent. */
export function readPathAliases(root: string, files: PreludeFiles): PathAliases | undefined {
  const text = files.read(path.join(root, 'tsconfig.json'));
  if (text === undefined) {
    return undefined;
  }
  const json = stripJSONComments(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || !('compilerOptions' in parsed)) {
    return undefined;
  }
  const options = parsed.compilerOptions;
  if (typeof options !== 'object' || options === null) {
    return undefined;
  }
  const baseUrl = 'baseUrl' in options && typeof options.baseUrl === 'string' ? options.baseUrl : '.';
  const paths = 'paths' in options && typeof options.paths === 'object' && options.paths !== null ? options.paths : undefined;
  if (paths === undefined) {
    return undefined;
  }
  const patterns = new Map<string, readonly string[]>();
  for (const [pattern, targets] of Object.entries(paths).slice(0, PRELUDE_LIMITS.aliasesMax)) {
    if (Array.isArray(targets)) {
      const list: readonly unknown[] = targets;
      patterns.set(
        pattern,
        list.filter((target): target is string => typeof target === 'string'),
      );
    }
  }
  return { patterns, baseDirectory: path.resolve(root, baseUrl) };
}

function stripJSONComments(text: string): string {
  // Strings are kept whole so a `//` inside one (a URL) is not a comment.
  return text.replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (match, quoted: string | undefined) => quoted ?? '').replace(/,(\s*[}\]])/g, '$1');
}

/** The absolute file a specifier names, when it is a type-bearing file the reader has. */
export function resolveTypeFile(specifier: string, fromFile: string, aliases: PathAliases | undefined, files: PreludeFiles): string | undefined {
  return resolveImportFile(specifier, fromFile, aliases, files, /\.(ts|tsx|mts)$/);
}

/**
 * The absolute file an import specifier names (relative, or through the tsconfig `paths`), when it exists and
 * its name passes `accept`. Packages are not followed: a dependency's source is not the project's.
 */
export function resolveImportFile(
  specifier: string,
  fromFile: string,
  aliases: PathAliases | undefined,
  files: PreludeFiles,
  accept: RegExp,
): string | undefined {
  const bases: string[] = [];
  if (specifier.startsWith('.')) {
    bases.push(path.resolve(path.dirname(fromFile), specifier));
  } else if (aliases !== undefined) {
    for (const [pattern, targets] of aliases.patterns) {
      const star = pattern.indexOf('*');
      const matched = star < 0 ? specifier === pattern : specifier.startsWith(pattern.slice(0, star)) && specifier.endsWith(pattern.slice(star + 1));
      if (!matched) {
        continue;
      }
      const middle = star < 0 ? '' : specifier.slice(star, specifier.length - (pattern.length - star - 1));
      for (const target of targets) {
        bases.push(path.resolve(aliases.baseDirectory, target.replace('*', middle)));
      }
    }
  }
  for (const base of bases) {
    const stem = base.replace(/\.(js|mjs)$/, '');
    for (const suffix of TYPE_FILE_SUFFIXES) {
      // Normalised so an `/index.ts` suffix takes the platform separator: on Windows the same file must not
      // be named two ways, or the seen set would read it twice and an exact-path reader would miss it.
      const candidate = path.normalize(stem + suffix);
      if (accept.test(candidate) && files.read(candidate) !== undefined) {
        return candidate;
      }
    }
  }
  return undefined;
}

/**
 * The text of every type-bearing file the component imports, directly or through re-exports, to a bound.
 * The caller hands it to the prop model as the prelude; the component's own declarations still win.
 */
export function previewTypePrelude(componentFile: string, source: string, aliases: PathAliases | undefined, files: PreludeFiles): string {
  assert(path.isAbsolute(componentFile), 'The prelude is read from an absolute component path');
  const frontmatter = /^---\s*\n([\s\S]*?)\n---/.exec(source)?.[1] ?? '';
  const seen = new Set<string>();
  const texts: string[] = [];
  const pending: { readonly file: string; readonly specifier: string; readonly depth: number }[] = [];
  for (const specifier of specifiersOf(frontmatter)) {
    pending.push({ file: componentFile, specifier, depth: 0 });
  }
  // A breadth-first walk with a stated file bound: each pass takes one entry and may add its file's imports.
  for (let step = 0; step < PRELUDE_LIMITS.filesMax * 8 && pending.length > 0 && seen.size < PRELUDE_LIMITS.filesMax; step += 1) {
    const entry = pending.shift();
    if (entry === undefined) {
      break;
    }
    const resolved = resolveTypeFile(entry.specifier, entry.file, aliases, files);
    if (resolved === undefined || seen.has(resolved)) {
      continue;
    }
    const text = files.read(resolved);
    if (text === undefined) {
      continue;
    }
    seen.add(resolved);
    texts.push(text);
    if (entry.depth + 1 < PRELUDE_LIMITS.depthMax) {
      for (const specifier of specifiersOf(text)) {
        pending.push({ file: resolved, specifier, depth: entry.depth + 1 });
      }
    }
  }
  assert(seen.size <= PRELUDE_LIMITS.filesMax, 'The prelude follows a bounded number of files');
  return texts.join('\n');
}

function specifiersOf(text: string): readonly string[] {
  const found: string[] = [];
  for (const match of text.matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[1];
    if (specifier !== undefined && found.length < PRELUDE_LIMITS.filesMax * 4) {
      found.push(specifier);
    }
  }
  return found;
}
