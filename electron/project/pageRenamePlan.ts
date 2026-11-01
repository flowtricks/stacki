import path from 'node:path';
import { assert } from '../../shared/core/assert';
import { ok, type Result } from '../../shared/core/result';
import { parsePageOrder } from '../../shared/properties/pageOrder';
import { renamedPagePath, type PageRename } from '../../shared/properties/pageRename';
import { pageRenameConflicts } from './pageRenameConflicts';
import { pageRenameInventory, type RenameFile } from './pageRenameInventory';
import { renamePageImports, renamePageLinks } from './pageRenameLinks';

export interface RenameText {
  readonly file: string;
  readonly before: string;
  readonly after: string;
}
export interface PageRenamePlan {
  readonly root: string;
  readonly change: PageRename;
  readonly texts: readonly RenameText[];
  readonly witnesses: readonly RenameFile[];
  readonly relocated: ReadonlyMap<string, string>;
}

export function planPageRename(
  root: string,
  change: PageRename,
  projectAliases: readonly (readonly [string, readonly string[]])[] = [],
): Result<PageRenamePlan> {
  assert(path.isAbsolute(root), 'Rename root must be absolute');
  if (projectAliases.length > 100 || projectAliases.some(([, targets]) => targets.length > 100)) {
    throw new Error('Too many import aliases to rename safely.');
  }
  const inventory = pageRenameInventory(root);
  const conflict = pageRenameConflicts(change, inventory);
  if (!conflict.ok) {
    return conflict;
  }
  const relocated = new Map<string, string>();
  for (const file of inventory.files) {
    if (file.startsWith('src/pages/')) {
      const next = 'src/pages/' + renamedPagePath(file.slice(10), change);
      if (next !== file) {
        relocated.set(file, next);
      }
    }
  }
  const origins = renameOrigins(inventory.texts);
  const aliases = projectAliases.map(([prefix, targets]) => [prefix.replace(/\/$/, ''), targets.map((target) => target.replace(/\/$/, ''))] as const);
  const texts = inventory.texts.flatMap(({ file, source }) => {
    const linked = renamePageLinks(source, { change, origins, file });
    const imported = renamePageImports(linked, file, relocated, aliases);
    const after = file === '.stacki/pages.json' ? renameOrder(source, change) : imported;
    return source === after ? [] : [{ file, before: source, after }];
  });
  assert(texts.length <= 10_000, 'Rename changes stay inside the scanned inventory');
  return ok({ root, change, texts, relocated, witnesses: inventory.texts });
}

function renameOrder(source: string, change: PageRename): string {
  const input: unknown = JSON.parse(source);
  const order = parsePageOrder(input);
  const entries = order.entries.map((key) => {
    const folder = key.endsWith('/');
    return renamedPagePath(folder ? key.slice(0, -1) : key, change) + (folder ? '/' : '');
  });
  // Revalidation catches stale metadata that would otherwise merge two identities.
  return JSON.stringify(parsePageOrder({ ...order, entries }), undefined, 2) + '\n';
}
function renameOrigins(files: readonly RenameFile[]): readonly string[] {
  const origins = new Set<string>();
  for (const { file, source } of files) {
    if (/^astro\.config\./.test(file) || file === '.stacki/publish.json') {
      const pattern = file.endsWith('.json') ? /"(?:url|publishedSite)"\s*:\s*"(https?:\/\/[^"\s]+)"/g : /\bsite\s*:\s*['"](https?:\/\/[^'"\s]+)['"]/g;
      for (const match of source.matchAll(pattern)) {
        if (match[1]) {
          origins.add(new URL(match[1]).origin);
        }
        if (origins.size > 32) {
          throw new Error('Too many configured site origins to rename safely.');
        }
      }
    }
  }
  return [...origins];
}
