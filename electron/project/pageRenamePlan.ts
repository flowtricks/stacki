import path from 'node:path';
import { assert } from '../../shared/core/assert';
import { ok, type Result } from '../../shared/core/result';
import { parsePageOrder } from '../../shared/properties/pageOrder';
import { renamedPagePath, type PageRename } from '../../shared/properties/pageRename';
import { pageRenameConflicts } from './pageRenameConflicts';
import { isRenameTextCandidate, pageRenameInventoryWork, readRenameText } from './pageRenameInventory';
import { createHash } from 'node:crypto';
import { runSliced, runSync, type SlicedWork } from '../lib/slicedWork';
import { renamePageImports, renamePageLinks } from './pageRenameLinks';

export interface RenameText {
  readonly file: string;
  readonly before: string;
  readonly after: string;
}
/** A file the plan read, held as its digest so a project of any size is witnessed without holding all its text. */
export interface RenameWitness {
  readonly file: string;
  readonly digest: string;
}
export interface PageRenamePlan {
  readonly root: string;
  readonly change: PageRename;
  readonly texts: readonly RenameText[];
  readonly witnesses: readonly RenameWitness[];
  readonly relocated: ReadonlyMap<string, string>;
}

/** SHA-256 of a text: what a witness holds in place of the text. */
export function renameDigest(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

/**
 * Plan a rename over a project of any size. Written once as a generator that
 * yields after each folder and file, and run two ways: `planPageRename` drains
 * it in one go, `planPageRenameSliced` returns to the event loop between
 * slices. Memory holds the changed files' text, not every file's.
 */
export function* planPageRenameWork(
  root: string,
  change: PageRename,
  projectAliases: readonly (readonly [string, readonly string[]])[] = [],
): SlicedWork<Result<PageRenamePlan>> {
  assert(path.isAbsolute(root), 'Rename root must be absolute');
  const inventory = yield* pageRenameInventoryWork(root);
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
  const candidates = inventory.files.filter(isRenameTextCandidate);
  const origins = renameOrigins(root, candidates);
  const aliases = projectAliases.map(([prefix, targets]) => [prefix.replace(/\/$/, ''), targets.map((target) => target.replace(/\/$/, ''))] as const);
  const texts: RenameText[] = [];
  const witnesses: RenameWitness[] = [];
  for (const candidate of candidates) {
    const read = readRenameText(root, candidate);
    if (read !== undefined) {
      const { file, source } = read;
      witnesses.push({ file, digest: renameDigest(source) });
      const linked = renamePageLinks(source, { change, origins, file });
      const imported = renamePageImports(linked, file, relocated, aliases);
      const after = file === '.stacki/pages.json' ? renameOrder(source, change) : imported;
      if (source !== after) {
        texts.push({ file, before: source, after });
      }
    }
    yield;
  }
  assert(texts.length <= witnesses.length, 'Every changed text was witnessed');
  return ok({ root, change, texts, relocated, witnesses });
}

export function planPageRename(
  root: string,
  change: PageRename,
  projectAliases: readonly (readonly [string, readonly string[]])[] = [],
): Result<PageRenamePlan> {
  return runSync(planPageRenameWork(root, change, projectAliases));
}

export function planPageRenameSliced(
  root: string,
  change: PageRename,
  projectAliases: readonly (readonly [string, readonly string[]])[] = [],
): Promise<Result<PageRenamePlan>> {
  return runSliced(planPageRenameWork(root, change, projectAliases));
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

// The site origins a rename must treat as internal: only the config files name them.
export function renameOrigins(root: string, files: readonly string[]): readonly string[] {
  const origins = new Set<string>();
  for (const file of files) {
    if (/^astro\.config\./.test(file) || file === '.stacki/publish.json' || file === '.stacki/publish-destinations.json') {
      const read = readRenameText(root, file);
      if (read === undefined) {
        continue;
      }
      const pattern = file.endsWith('.json') ? /"(?:url|publishedSite)"\s*:\s*"(https?:\/\/[^"\s]+)"/g : /\bsite\s*:\s*['"](https?:\/\/[^'"\s]+)['"]/g;
      for (const match of read.source.matchAll(pattern)) {
        if (match[1]) {
          origins.add(new URL(match[1]).origin);
        }
      }
    }
  }
  return [...origins];
}
