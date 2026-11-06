// The data picker's decisions that are not about drawing: which entry of a
// list is being read, where stepping goes, and what each group of rows is
// called. Pure, so the tests can pin them without a renderer.
//
// Entry pages. A list of records — a project collection, a sampled
// `getCollection` value — opens onto ONE entry at a time behind the same
// ‹ n/total › arrows a loop item has, rather than a column of `0`, `1`, `2`.
// The entry shown is the entry picked from: its rows are `stats[2].data.Header`,
// and choosing one binds `stats[2].data.Header`. That differs from a loop
// item's arrows on purpose. A loop item's fields are item-relative
// (`service.title`), so its arrows only change which values are previewed and
// can never change the binding; a list's entries are addressed by position, so
// a preview-only pager would show one stat's values while binding another's.
// Stepping here is choosing which entry to bind, and every row says which in
// its own path.

import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { pathSteps } from '../../editor/dataSample';

export interface EntryPage {
  readonly index: number;
  readonly count: number;
}

/** The entry each list shows, by the list's path. A list not in here shows its first. */
export type EntryPages = Readonly<Record<string, number>>;

interface PagedNode {
  readonly path: string;
  readonly entryCount?: number | undefined;
  readonly children: readonly { readonly path: string }[] | undefined;
}

/**
 * Which entry of `node` is shown, and of how many — or undefined when the
 * node is not a list of entries worth paging: one entry, or none, is simply
 * shown, with nothing to step to.
 */
export function entryPageOf(node: PagedNode, pages: EntryPages): EntryPage | undefined {
  const count = node.entryCount;
  if (count === undefined || node.children === undefined) {
    return undefined;
  }
  assert(Number.isSafeInteger(count), 'entryPageOf: entry count is an integer');
  if (count < 2) {
    return undefined;
  }
  const asked = pages[node.path] ?? 0;
  // A remembered place past the end — the list shrank under it — reads as the last entry.
  const index = Math.min(Math.max(asked, 0), count - 1);
  assert(index < count, 'entryPageOf: the shown entry is inside the list');
  return { index, count };
}

/**
 * Where one step from `page` lands. Wraps at both ends, as a loop item's
 * arrows do (App.tsx onStepItem), so the two pagers in one picker agree.
 */
export function steppedEntryIndex(page: EntryPage, step: -1 | 1): number {
  assert(page.count >= 2, 'steppedEntryIndex: a single entry has nowhere to step');
  assert(page.index >= 0, 'steppedEntryIndex: the index is not negative');
  assert(page.index < page.count, 'steppedEntryIndex: the index is inside the list');
  const next = (((page.index + step) % page.count) + page.count) % page.count;
  assert(next >= 0, 'steppedEntryIndex: the step lands at or after the first entry');
  assert(next < page.count, 'steppedEntryIndex: the step lands at or before the last entry');
  return next;
}

/** The path of the entry at `index` of the list at `listPath`: `stats[2]`. */
export function entryPath(listPath: string, index: number): string {
  assert(Number.isSafeInteger(index), 'entryPath: index is an integer');
  assert(index >= 0, 'entryPath: index is not negative');
  return `${listPath}[${index}]`;
}

/**
 * The rows a paged list shows beneath it: the chosen entry, when it has been
 * read, and any row kept only to show the current binding (a path the data
 * does not have). `unread` is true when the chosen entry still has to be asked
 * for.
 */
export function shownEntryRows<Row extends { readonly path: string; readonly missing?: boolean | undefined }>(
  listPath: string,
  children: readonly Row[],
  page: EntryPage,
): { readonly rows: readonly Row[]; readonly unread: boolean } {
  assert(children.length <= LIMITS.treeNodesMax, 'shownEntryRows: node limit exceeded');
  const chosen = entryPath(listPath, page.index);
  const entry = children.find((child) => child.path === chosen);
  const rows = children.filter((child) => child === entry || child.missing === true);
  assert(rows.length <= children.length, 'shownEntryRows: rows are drawn from the children');
  return { rows, unread: entry === undefined };
}

/**
 * The entries a binding names, as pages: `stats[2].data.Header` opens `stats`
 * on its third entry, so the picker opens ON what the chip points at. Every
 * `[n]` step counts — a list inside an entry has its own place.
 */
export function pagesOfPath(path: string | undefined): EntryPages {
  const text = path ?? '';
  assert(text.length <= LIMITS.attrCharsMax, 'pagesOfPath: binding path limit exceeded');
  const steps = pathSteps(text) ?? [];
  const pages: Record<string, number> = {};
  let listEnd = 0;
  for (const step of steps) {
    if (typeof step.key === 'number' && listEnd > 0) {
      pages[text.slice(0, listEnd)] = step.key;
    }
    listEnd = step.end;
  }
  assert(Object.keys(pages).length <= steps.length, 'pagesOfPath: at most one page per step');
  return pages;
}

// ---------------------------------------------------------------------------
// Where each group of rows comes from.
// ---------------------------------------------------------------------------

/**
 * The file a picker binds in, and — when that file is a component shown on a
 * page — the page. Paths are project paths; only their file names are shown.
 */
export interface DataOrigin {
  readonly file: string | undefined;
  readonly page: string | undefined;
}

/**
 * What a group of rows is called, by where its data lives. The file is named,
 * because a component and the page it is shown on are two scopes and only one
 * of them is the one being bound: `Button.astro frontmatter` is the
 * component's own, and a project collection reads the same everywhere.
 */
export function sectionHeading(section: string, origin: DataOrigin | undefined): string | undefined {
  const file = fileNameOf(origin?.file);
  const component = componentNameOf(origin?.file);
  switch (section) {
    case 'loop':
      return 'Loop item';
    case 'props':
      // A component's props are the component's own, so its name says it all;
      // a page is not one, and says which file's props these are.
      return component ?? (file === undefined ? 'Props' : `${file} props`);
    case 'frontmatter':
      return file === undefined ? 'Frontmatter' : `${file} frontmatter`;
    case 'collections':
      // Astro's own name for them, so it matches the docs and the config file.
      return 'Content Collections';
    case 'loop-sanity':
      return 'Sanity';
    case 'loop-page':
      return 'On this page';
    case 'loop-component':
      return component ?? 'On this page';
    default:
      return undefined;
  }
}

/** Whether a group of rows is a component's own: its heading is drawn as components are. */
export function isComponentSection(section: string | undefined, origin: DataOrigin | undefined): boolean {
  if (section !== 'props' && section !== 'loop-component') {
    return false;
  }
  return componentNameOf(origin?.file) !== undefined;
}

/**
 * The prop whose settings a picker row opens, or undefined for a row that has
 * none. Only a component's own group qualifies, because the Source menu heads
 * the file's frontmatter lists there too, and a loop item can share a prop's
 * name: `keyOf` then says which of those rows really is a prop. A field inside
 * a prop has a longer path, so it is never one.
 */
export function settingsKeyOf(
  node: { readonly path: string; readonly section?: string | undefined },
  keyOf: ((path: string) => string | undefined) | undefined,
): string | undefined {
  if (keyOf === undefined) {
    return undefined;
  }
  if (node.section !== 'props' && node.section !== 'loop-component') {
    return undefined;
  }
  return keyOf(node.path);
}

/**
 * The component a file is, as the app names one (`PricingCard`), or undefined
 * for a page or no file at all: nothing passes a page props, so what it holds
 * is the page's rather than a component's.
 */
export function componentNameOf(file: string | undefined): string | undefined {
  const name = fileNameOf(file);
  if (file === undefined || name === undefined || /(^|[\\/])src[\\/]pages[\\/]/.test(file)) {
    return undefined;
  }
  return name.replace(/\.astro$/, '');
}

function fileNameOf(path: string | undefined): string | undefined {
  if (path === undefined || path === '') {
    return undefined;
  }
  const name = path.split(/[\\/]/).pop() ?? '';
  return name === '' ? undefined : name;
}
