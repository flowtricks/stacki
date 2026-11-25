import { assert } from '../../../shared/core/assert';

// The folders the insert grid filters by: the immediate subfolders of the components directory, as
// the Components panel lists them (paletteModel.ts groups by the same scan `folder`). A component in
// a nested folder counts toward its top-level folder. Components in the components directory itself
// share one pill named after that directory, "components". Astro's own components (Image, Picture)
// are in no project folder, so they have no pill: they show with none selected, and in a search.
//
// Keys are template-literal strings, so a folder can never be mistaken for the root whatever it is
// called, and a key stores as plain text.

export type InsertFolderKey = 'root' | `folder:${string}`;

/** A folder name longer than this is not a folder the scan produced; parsing refuses it. */
export const insertFolderNameCharsMax = 256;

/** Pills one grid shows. A project with more top-level component folders than this is not one a row of pills serves. */
export const insertFoldersMax = 200;

/** The pill a component belongs to, from its scan folder (`sections/hero` counts toward `sections`). */
export function insertFolderOf(folder: string): InsertFolderKey {
  const top =
    folder
      .replaceAll('\\', '/')
      .split('/')
      .find((segment) => segment !== '') ?? '';
  if (top === '') {
    return 'root';
  }
  assert(top.length <= insertFolderNameCharsMax, 'insertFolders: a folder name is bounded');
  return `folder:${top}`;
}

export function insertFolderLabel(key: InsertFolderKey): string {
  if (key === 'root') {
    return 'components';
  }
  const name = key.slice('folder:'.length);
  assert(name.length > 0, 'insertFolders: a folder key names a folder');
  return name;
}

/** Every pill the given cards fill, in the Components panel's order: the root first, then folders A to Z. */
export function insertFolderKeys(folders: Iterable<InsertFolderKey>): readonly InsertFolderKey[] {
  const unique = new Set(folders);
  const named = [...unique].filter((key) => key !== 'root').sort((left, right) => left.localeCompare(right));
  const keys: InsertFolderKey[] = [...(unique.has('root') ? ['root' as const] : []), ...named];
  assert(keys.length === unique.size, 'insertFolders: every folder is listed once');
  return keys.slice(0, insertFoldersMax);
}

/** A stored or received key, or undefined: what storage holds is parsed like any input. */
export function parseInsertFolderKey(raw: unknown): InsertFolderKey | undefined {
  if (raw === 'root') {
    return raw;
  }
  if (typeof raw !== 'string' || !raw.startsWith('folder:')) {
    return undefined;
  }
  const name = raw.slice('folder:'.length);
  if (name.length === 0) {
    return undefined;
  }
  if (name.length > insertFolderNameCharsMax) {
    return undefined;
  }
  if (name.includes('/')) {
    return undefined;
  }
  return `folder:${name}`;
}
