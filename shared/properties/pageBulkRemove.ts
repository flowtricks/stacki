// Deleting several pages and folders at once, from the Pages panel's Select mode: the request, the summary the confirm
// shows, and the reply, as they cross the IPC boundary (electron/handlers/pageBulkRemovePlan.ts plans them,
// electron/project/pageRelocationWrite.ts writes them as one step with one undo token). Pure: the panel uses the same
// bounds, so a selection main would refuse never leaves the renderer.
import { count, list, record, text } from '../core/boundary';
import { parsePageSettingsSummary, type PageSettingsSummary } from './pageSettings';
import { renamePath } from './pageRename';

export const PAGE_BULK_REMOVE_LIMITS = {
  /** Pages one step deletes. Each is read and probed for links once, so this bounds the plan's work. */
  pagesMax: 500,
  /** Folders one step deletes. */
  foldersMax: 100,
} as const satisfies Record<string, number>;

const PAGE_EXTENSION = /\.(astro|mdx?)$/i;

/** Pages and folders to delete, named relative to src/pages, never by absolute path, so a request cannot leave it. */
export interface PageBulkRemoveRequest {
  readonly pages: readonly string[];
  readonly folders: readonly string[];
}

export function parsePageBulkRemoveRequest(input: unknown): PageBulkRemoveRequest {
  const value = record(input);
  const pages = distinct('pages', list(renamePath)(value['pages']), PAGE_BULK_REMOVE_LIMITS.pagesMax);
  const folders = distinct('folders', list(renamePath)(value['folders']), PAGE_BULK_REMOVE_LIMITS.foldersMax);
  for (const page of pages) {
    if (!PAGE_EXTENSION.test(page)) {
      throw new Error('Page removal: expected a page file');
    }
  }
  if (pages.length + folders.length === 0) {
    throw new Error('Page removal: nothing selected');
  }
  return { pages, folders };
}

function distinct(label: string, values: readonly string[], limit: number): readonly string[] {
  if (values.length > limit) {
    throw new Error(`Page removal: too many ${label}`);
  }
  if (new Set(values).size !== values.length) {
    throw new Error(`Page removal: duplicate ${label}`);
  }
  return values;
}

/** What the confirm says: how many files go (a folder's pages included), what else is touched, which links break. */
export interface PageBulkRemoveSummary {
  /** Pages deleted, those inside selected folders included. */
  readonly pages: number;
  /** Folders deleted. */
  readonly folders: number;
  /** Of the pages, how many are the site's 404 or 500 page. */
  readonly errorPages: number;
  /** Links that would break, listed for review (moves is always empty). */
  readonly impact: PageSettingsSummary;
}

export function parsePageBulkRemoveSummary(input: unknown): PageBulkRemoveSummary {
  const value = record(input);
  const pages = count(value['pages']);
  const folders = count(value['folders']);
  const errorPages = count(value['errorPages']);
  if (pages > PAGE_BULK_REMOVE_LIMITS.pagesMax) {
    throw new Error('Page removal: summary names too many pages');
  }
  if (folders > PAGE_BULK_REMOVE_LIMITS.foldersMax) {
    throw new Error('Page removal: summary names too many folders');
  }
  if (errorPages > pages) {
    throw new Error('Page removal: more error pages than pages');
  }
  const impact = parsePageSettingsSummary(value['impact']);
  if (impact.moves.length > 0) {
    throw new Error('Page removal: a deletion moves nothing');
  }
  return { pages, folders, errorPages, impact };
}

export interface PageBulkRemoveApplied {
  readonly summary: PageBulkRemoveSummary;
  /** Handed back to `page:revertSettings` by Undo and Redo: the same history as every Page settings step. */
  readonly undo: string;
}

export function parsePageBulkRemoveApplied(input: unknown): PageBulkRemoveApplied {
  const value = record(input);
  const undo = text(value['undo']);
  if (undo.length === 0 || undo.length > 64) {
    throw new Error('Page removal: invalid undo token');
  }
  return { summary: parsePageBulkRemoveSummary(value['summary']), undo };
}
