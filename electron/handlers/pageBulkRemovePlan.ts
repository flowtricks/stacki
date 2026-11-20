// Planning the deletion of several pages and folders as ONE Page settings step, without writing: the Pages panel's
// Select mode. It follows the single deletion's rules (pageSettingsPlan.ts `planRemove`): the homepage is refused,
// every page must be UTF-8 text so Undo can put its bytes back exactly, and the links that would break are listed.
// What differs is the cost: the project is read once for all pages (each file is probed once per page, not each page
// walking the project again). A folder goes with its pages; one that holds anything but pages is refused whole, because
// Undo restores only what the plan has read. The step is the same RelocationStep, so it is written all or nothing and
// taken back through `page:revertSettings`.
import path from 'node:path';
import { assert } from '../../shared/core/assert';
import { err, ok, type Result } from '../../shared/core/result';
import { described } from '../../shared/properties/i18n/messageRef';
import { pageURLPath } from '../../shared/properties/pageRename';
import { PAGE_BULK_REMOVE_LIMITS, type PageBulkRemoveRequest, type PageBulkRemoveSummary } from '../../shared/properties/pageBulkRemove';
import { isHomePage, PAGE_SETTINGS_LIMITS, type PageSettingsReview } from '../../shared/properties/pageSettings';
import { runSliced, type SlicedWork } from '../lib/slicedWork';
import { isRenameTextCandidate, pageRenameInventoryWork, readRenameText } from '../project/pageRenameInventory';
import { renameOrigins } from '../project/pageRenamePlan';
import { renamePageLinks } from '../project/pageRenameLinks';
import type { FileChange, RelocationStep } from '../project/pageRelocationWrite';
import { changedLines, isConfigFile, routeMentions, summaryOf } from './pageSettingsPlan';

export interface BulkRemovePlan {
  readonly step: RelocationStep;
  readonly summary: PageBulkRemoveSummary;
}

/** Files Finder or Explorer leave in a folder: not the project's, so they never keep a folder from going. */
export const JUNK_FILES: ReadonlySet<string> = new Set(['.DS_Store', 'Thumbs.db']);

const ERROR_PAGE = /^(404|500)\.(astro|mdx?)$/i;

export function planBulkRemoveSliced(root: string, request: PageBulkRemoveRequest): Promise<Result<BulkRemovePlan>> {
  return runSliced(planBulkRemoveWork(root, request));
}

export function* planBulkRemoveWork(root: string, request: PageBulkRemoveRequest): SlicedWork<Result<BulkRemovePlan>> {
  assert(path.isAbsolute(root), 'A bulk deletion plan reads an absolute project root');
  assert(request.pages.length + request.folders.length > 0, 'A bulk deletion names something to delete');
  const inventory = yield* pageRenameInventoryWork(root);
  const resolved = resolveTargets(request, inventory);
  if (!resolved.ok) {
    return resolved;
  }
  const { pages, folders } = resolved.value;
  const texts = new Map<string, string>();
  for (const page of pages) {
    const file = 'src/pages/' + page;
    const read = readRenameText(root, file);
    if (read === undefined) {
      return err({ code: 'encoding', ...described('pages.settings.error.notText', { file }) });
    }
    texts.set(page, read.source);
    yield;
  }
  const leaving = new Set(pages.map((page) => 'src/pages/' + page));
  const impact = yield* brokenLinks(root, pages, inventory.files, leaving);
  const files: readonly FileChange[] = pages.map((page): FileChange => {
    const before = texts.get(page);
    assert(before !== undefined, 'Every page of the plan was read');
    return { kind: 'delete', from: 'src/pages/' + page, before };
  });
  const removed = folders.map((folder) => 'src/pages/' + folder);
  const summary: PageBulkRemoveSummary = {
    pages: pages.length,
    folders: folders.length,
    errorPages: pages.filter((page) => ERROR_PAGE.test(page)).length,
    impact: summaryOf({ texts: [], files, links: impact.links, reviews: impact.reviews }),
  };
  assert(summary.impact.moves.length === 0, 'A deletion moves no file');
  return ok({ step: { root, texts: [], files, folders: { made: [], removed } }, summary });
}

interface Targets {
  /** Every page that goes, relative to src/pages: the named ones and those inside the named folders. */
  readonly pages: readonly string[];
  /** Every folder that goes, relative to src/pages, deepest first: the named ones and their subfolders. */
  readonly folders: readonly string[];
}

function resolveTargets(
  request: PageBulkRemoveRequest,
  inventory: { readonly pages: readonly string[]; readonly folders: readonly string[]; readonly files: readonly string[] },
): Result<Targets> {
  const pages = new Set<string>();
  for (const page of request.pages) {
    if (!inventory.pages.includes(page)) {
      return err({ code: 'missing', ...described('pages.rename.error.missing') });
    }
    if (isHomePage(page)) {
      return err({ code: 'refused', ...described('pages.settings.delete.homeRefused') });
    }
    pages.add(page);
  }
  const folders = new Set<string>();
  for (const folder of request.folders) {
    if (!inventory.folders.includes(folder)) {
      return err({ code: 'missing', ...described('pages.rename.error.missing') });
    }
    const prefix = folder + '/';
    folders.add(folder);
    for (const other of inventory.folders) {
      if (other.startsWith(prefix)) {
        folders.add(other);
      }
    }
    for (const page of inventory.pages) {
      if (page.startsWith(prefix)) {
        pages.add(page);
      }
    }
    const stray = inventory.files.find((file) => file.startsWith('src/pages/' + prefix) && !pages.has(file.slice('src/pages/'.length)) && !isJunk(file));
    if (stray !== undefined) {
      return err({ code: 'refused', ...described('pages.select.error.otherFiles', { folder, file: stray }) });
    }
  }
  if (pages.size > PAGE_BULK_REMOVE_LIMITS.pagesMax || folders.size > PAGE_BULK_REMOVE_LIMITS.foldersMax) {
    return err({
      code: 'refused',
      ...described('pages.select.error.tooMany', { pages: PAGE_BULK_REMOVE_LIMITS.pagesMax, folders: PAGE_BULK_REMOVE_LIMITS.foldersMax }),
    });
  }
  assert(folders.size <= inventory.folders.length, 'Only folders of the project are removed');
  // Deepest first: a folder is only empty once its subfolders are gone.
  const deepestFirst = [...folders].sort((left, right) => right.split('/').length - left.split('/').length || left.localeCompare(right));
  return ok({ pages: [...pages].sort(), folders: deepestFirst });
}

function isJunk(file: string): boolean {
  return JUNK_FILES.has(file.slice(file.lastIndexOf('/') + 1));
}

// Every place a rename of one of these pages would have changed: a link that would point nowhere. Each file is read
// once; a file that is itself deleted is left out, since its links go with it.
function* brokenLinks(
  root: string,
  pages: readonly string[],
  files: readonly string[],
  leaving: ReadonlySet<string>,
): SlicedWork<{ readonly links: number; readonly reviews: readonly PageSettingsReview[] }> {
  const origins = renameOrigins(root, files.filter(isConfigFile));
  const probes = pages.map((page) => {
    const extension = /\.(astro|mdx?)$/i.exec(page)?.[0] ?? '.astro';
    const folder = page.includes('/') ? page.slice(0, page.lastIndexOf('/') + 1) : '';
    const sentinel = folder + 'stacki-removed-page' + extension;
    return { page, sentinel, route: pageURLPath(sentinel) };
  });
  const reviews: PageSettingsReview[] = [];
  const listed = new Set<string>();
  let links = 0;
  for (const file of files.filter(isRenameTextCandidate)) {
    if (leaving.has(file) || isConfigFile(file) || file.startsWith('.stacki/')) {
      yield;
      continue;
    }
    const text = readRenameText(root, file);
    if (text !== undefined) {
      for (const probe of probes) {
        const probed = renamePageLinks(text.source, { change: { kind: 'page', from: probe.page, to: probe.sentinel }, origins, file });
        if (probed !== text.source) {
          links += routeMentions(probed, probe.route);
          for (const review of changedLines(file, text.source, probed)) {
            // One line linking two deleted pages is one place to look at, listed once.
            const key = file + ':' + review.line;
            if (!listed.has(key) && reviews.length < PAGE_SETTINGS_LIMITS.reviewsMax * 2) {
              listed.add(key);
              reviews.push(review);
            }
          }
        }
      }
    }
    yield;
  }
  return { links, reviews };
}
