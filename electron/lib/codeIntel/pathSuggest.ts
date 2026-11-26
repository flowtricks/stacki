// File path suggestions: what an import names (relative, through a tsconfig alias, or a dependency), what a stylesheet's
// `url()` or `@import` reaches, and what an `src` or `href` can load from `public/`. One folder is listed at a time.
import type { CodeCompletion, CodeCompletions } from '../../../shared/ipc/codeIntel';
import { extensionOf, folderOf, joined, within } from './paths';
import type { ProjectIndex } from './projectIndex';
import { completions, suggestion } from './suggestion';

/** A tsconfig `paths` entry that ends in `*`: `@/*` → the folder its first target names. */
export interface PathAlias {
  readonly prefix: string;
  readonly folder: string;
  /** What the target writes after its `*`. */
  readonly suffix: string;
}

export type PathUse =
  /** An `import`'s specifier. */
  | 'import'
  /** `url()` and `@import` in a stylesheet, resolved by the build from the file. */
  | 'style-url'
  /** `src` and `href` in markup: only what the site serves as written, from `public/`. */
  | 'served';

export interface PathPlace {
  readonly file: string;
  /** The nearest folder above the file with a package.json: where `public/` and dependencies are. */
  readonly packageFolder: string;
  readonly aliases: readonly PathAlias[];
  readonly dependencies: readonly string[];
}

/** The extensions TypeScript and the bundler find without being named. */
const IMPLIED_EXTENSIONS: ReadonlySet<string> = new Set(['.ts', '.tsx', '.js', '.jsx']);
const SERVED_ATTRIBUTES: ReadonlySet<string> = new Set(['src', 'href', 'poster', 'srcset', 'data-src', 'action', 'content']);

export function servesPaths(attribute: string): boolean {
  return SERVED_ATTRIBUTES.has(attribute.toLowerCase());
}

/** Suggestions for the path `typed` so far, which ends at `position`; undefined when it is not a path to complete. */
export function pathCompletions(
  index: ProjectIndex,
  place: PathPlace,
  written: { readonly typed: string; readonly position: number; readonly use: PathUse },
): CodeCompletions | undefined {
  const { typed, position, use } = written;
  if (/^[a-z][\w+.-]*:|^\/\/|^#|\$\{|\{/i.test(typed) && !place.aliases.some((alias) => typed.startsWith(alias.prefix))) {
    return undefined;
  }
  const slash = typed.lastIndexOf('/');
  const segment = typed.slice(slash + 1);
  const whole = { from: position - typed.length, to: position, typed, exclusive: false };
  const last = { from: position - segment.length, to: position, typed: segment, exclusive: false };
  if (use === 'served') {
    if (typed !== '' && !typed.startsWith('/')) {
      return undefined;
    }
    const folder = joined(`${place.packageFolder}/public`, `.${typed.slice(0, slash + 1) || '/'}`);
    return typed === '' ? completions(whole, entries(index, folder, { place, use }, '/')) : completions(last, entries(index, folder, { place, use }, ''));
  }
  if (slash === -1) {
    const found: CodeCompletion[] = [];
    if (typed === '.' || typed === '..') {
      return completions(whole, [suggestion('./', 'folder'), suggestion('../', 'folder')]);
    }
    for (const alias of place.aliases) {
      found.push(suggestion(alias.prefix, 'folder', { boost: 3, detail: displayFolder(index.root, alias.folder) }));
    }
    if (use === 'style-url') {
      found.push(...entries(index, folderOf(place.file), { place, use }, './'));
    } else {
      found.push(suggestion('./', 'folder', { boost: 2 }), suggestion('../', 'folder', { boost: 1 }));
      found.push(...place.dependencies.map((name) => suggestion(name, 'module')));
    }
    return completions(whole, found);
  }
  const folder = folderFor(place, typed.slice(0, slash + 1), use);
  if (folder === undefined || !within(index.root, folder)) {
    return undefined;
  }
  return completions(last, entries(index, folder, { place, use }, ''));
}

function folderFor(place: PathPlace, written: string, use: PathUse): string | undefined {
  if (written.startsWith('./') || written.startsWith('../')) {
    return joined(folderOf(place.file), written);
  }
  const alias = place.aliases.filter((entry) => written.startsWith(entry.prefix)).sort((left, right) => right.prefix.length - left.prefix.length)[0];
  if (alias !== undefined) {
    return joined(alias.folder, `./${written.slice(alias.prefix.length)}`);
  }
  if (written.startsWith('/')) {
    // A stylesheet's root path is the served site's; an import's is the package's.
    return joined(use === 'style-url' ? `${place.packageFolder}/public` : place.packageFolder, `.${written}`);
  }
  return use === 'style-url' ? joined(folderOf(place.file), written) : undefined;
}

function entries(index: ProjectIndex, folder: string, context: { readonly place: PathPlace; readonly use: PathUse }, prefix: string): CodeCompletion[] {
  const found: CodeCompletion[] = [];
  for (const entry of index.files().children.get(folder) ?? []) {
    const absolute = `${folder}/${entry.name}`;
    if (absolute === context.place.file) {
      continue;
    }
    if (entry.folder) {
      found.push(suggestion(`${prefix}${entry.name}/`, 'folder', { boost: 1 }));
    } else {
      const bare = context.use === 'import' && IMPLIED_EXTENSIONS.has(extensionOf(entry.name)) && !entry.name.endsWith('.d.ts');
      const name = bare ? entry.name.slice(0, -extensionOf(entry.name).length) : entry.name;
      found.push(suggestion(`${prefix}${name}`, 'file', { detail: bare ? entry.name : undefined }));
    }
  }
  return found;
}

function displayFolder(root: string, folder: string): string {
  return folder === root ? './' : folder.startsWith(`${root}/`) ? folder.slice(root.length + 1) : folder;
}
