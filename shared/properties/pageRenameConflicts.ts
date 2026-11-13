import { list, pathText } from '../core/boundary';
import { assert } from '../core/assert';
import { err, ok, type Result } from '../core/result';
import { described } from './i18n/messageRef';
import { pageURLPath, renamedPagePath, type PageRename } from './pageRename';

export interface RenameInventory {
  readonly pages: readonly string[];
  readonly folders: readonly string[];
}

export function pageRenameConflicts(change: PageRename, inventory: RenameInventory): Result<void> {
  const { pages, folders } = inventory;
  assert(pages.length <= 10_000, 'Rename page inventory is bounded');
  assert(folders.length <= 10_000, 'Rename folder inventory is bounded');
  const source = change.kind === 'page' ? pages : folders;
  if (!source.includes(change.from)) {
    return err({
      code: 'missing',
      ...described('pages.rename.error.missing'),
    });
  }
  if (change.from === change.to) {
    return ok(undefined);
  }
  if (change.kind === 'folder' && change.to.startsWith(change.from + '/')) {
    return err({ code: 'path', ...described('pages.rename.error.insideItself') });
  }
  const untouched = [...pages.map(pageURLPath), ...folders.map((folder) => '/' + folder)];
  const occupied = new Set<string>();
  for (const [index, file] of [...pages, ...folders].entries()) {
    if (renamedPagePath(file, change) === file) {
      const route = untouched[index];
      if (route !== undefined) {
        occupied.add(collisionKey(route));
      }
    }
  }
  const targets =
    change.kind === 'page'
      ? [pageURLPath(change.to)]
      : ['/' + change.to, ...pages.filter((file) => file.startsWith(change.from + '/')).map((file) => pageURLPath(renamedPagePath(file, change)))];
  const collision = targets.find((route) => occupied.has(collisionKey(route)));
  return collision === undefined
    ? ok(undefined)
    : err({
        code: 'conflict',
        ...described('pages.rename.error.conflictUrl', { url: collision }),
      });
}

function collisionKey(route: string): string {
  // Case folding keeps renames portable; parameter names do not distinguish Astro routes.
  return route
    .toLowerCase()
    .replace(/\[\.\.\.[^\]]+\]/g, '[...]')
    .replace(/\[(?!\.\.\.)[^\]]+\]/g, '[]');
}

/** Folder inventories include empty directories, which also reserve rename destinations. */
export function parseRenameFolders(input: unknown): readonly string[] {
  if (!Array.isArray(input) || input.length > 10_000) {
    throw new Error('Invalid page folder inventory.');
  }
  return list(pathText)(input);
}
