// Where Astro looks for a project's pages: `<srcDir>/pages`, with `srcDir`
// read from the project's astro.config as text. The config is never run: it
// is ESM, often TypeScript, and written for Astro to load, so only a literal
// string counts; anything computed reads as Astro's default, `./src`.
import { assert } from '../core/assert';
import { parseProjectFolder } from './projectFolders';

/** The config files Astro loads, in the order it tries them (electron/preview/devServerChecks.ts). */
export const ASTRO_CONFIG_FILES = ['astro.config.mjs', 'astro.config.js', 'astro.config.mts', 'astro.config.ts', 'astro.config.cjs'] as const;

export const ASTRO_SOURCE_DIRECTORY_DEFAULT = 'src';

/** The project-relative `srcDir` a config's text sets as a literal, or undefined when it sets none we can read. */
export function sourceDirectoryFromConfig(text: string): string | undefined {
  // Whole-line and block comments go first, so a commented-out setting does not count.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const match = /(^|[\s,{])srcDir\s*:\s*(['"`])([^'"`$\n]{1,200})\2/.exec(code);
  const literal = match?.[3];
  if (literal === undefined) {
    return undefined;
  }
  const relative = literal.trim().replace(/^\.\//, '').replace(/\/+$/, '');
  try {
    return parseProjectFolder(relative);
  } catch {
    // An absolute path, `..`, a URL or anything else that is not a folder in the project.
    return undefined;
  }
}

/** The pages folder for Astro's `srcDir` (undefined: Astro's default). */
export function pagesFolderOf(sourceDirectory: string | undefined): string {
  const folder = `${sourceDirectory ?? ASTRO_SOURCE_DIRECTORY_DEFAULT}/pages`;
  assert(!folder.startsWith('/'), 'pagesFolderOf: the folder is project-relative');
  return folder;
}
