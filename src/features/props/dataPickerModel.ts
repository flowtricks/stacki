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
  // A project data file is headed by its path under src/, as the CMS panel lists it.
  const dataFile = dataFileOfSection(section);
  if (dataFile !== undefined) {
    return dataFile.startsWith('src/') ? dataFile.slice('src/'.length) : dataFile;
  }
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
    case PROJECT_DATA_SECTION:
      // The lists the project keeps outside the page, in its data modules (loopProjectData.ts).
      return 'Project data';
    case 'loop-page':
      return 'On this page';
    case 'loop-component':
      return component ?? 'On this page';
    default:
      return undefined;
  }
}

/** The Source menu's group of project data lists (loopProjectData.ts), whatever file each is in. */
export const PROJECT_DATA_SECTION = 'loop-project';

/** The section a project data file's exports are listed under: one per file. */
const DATA_FILE_SECTION = 'data-file:';

export function dataFileSection(file: string): string {
  assert(file.length > 0, 'dataFileSection: the file is named');
  return DATA_FILE_SECTION + file;
}

/** The project file a section lists the exports of, or undefined for any other section. */
export function dataFileOfSection(section: string | undefined): string | undefined {
  if (section === undefined || !section.startsWith(DATA_FILE_SECTION)) {
    return undefined;
  }
  const file = section.slice(DATA_FILE_SECTION.length);
  return file === '' ? undefined : file;
}

/**
 * One heading the picker draws where a group of rows starts: a group's own
 * (`group`, drawn as `section` is), or a quiet part of the group above it.
 */
export type SectionHead = { readonly kind: 'group'; readonly heading: string; readonly section: string } | { readonly kind: 'part'; readonly heading: string };

/**
 * The headings drawn where `section` starts, after `previous`. A component's
 * frontmatter is the component's own, as its props are: it is a part of the
 * component's group, under a quiet "Frontmatter", and opens that group itself
 * when the component has no props. A page's frontmatter keeps its own group.
 */
export function sectionHeads(section: string, previous: string | undefined, origin: DataOrigin | undefined): readonly SectionHead[] {
  const component = componentNameOf(origin?.file);
  if (section === 'frontmatter' && component !== undefined) {
    const part: SectionHead = { kind: 'part', heading: 'Frontmatter' };
    return previous === 'props' ? [part] : [{ kind: 'group', heading: component, section: 'props' }, part];
  }
  const heading = sectionHeading(section, origin);
  return heading === undefined ? [] : [{ kind: 'group', heading, section }];
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

// ---------------------------------------------------------------------------
// A binding the tree does not hold.
// ---------------------------------------------------------------------------

/** What a picker row knows about a node it reads a missing path's place from. */
export interface MissingAnchor {
  readonly key: string;
  readonly preview: string;
  readonly query?: { readonly collection: string; readonly name: string } | undefined;
  readonly nav?: EntryPage | undefined;
  readonly children: readonly { readonly key: string }[] | undefined;
}

/**
 * Why a bound path has no row, said as the kind beside it. `anchors` are the
 * path's ancestors the tree does hold, outermost first. Only a field under a
 * collection entry is "not in this entry": an optional field the entry left
 * unset, which is normal and not a broken binding. Elsewhere the label says
 * what is actually known: a value whose fields the app has listed and that
 * has no such one, a value whose fields it cannot see, or a name that is not
 * in scope here at all.
 */
export function missingLabel(anchors: readonly MissingAnchor[]): string {
  assert(anchors.length <= LIMITS.treeDepthMax, 'missingLabel: anchors stay inside the depth limit');
  const nearest = anchors[anchors.length - 1];
  if (nearest === undefined) {
    return 'not in scope';
  }
  if (anchors.some(isEntryLike)) {
    return 'not in this entry';
  }
  if (nearest.children === undefined || nearest.children.length === 0) {
    return 'fields not known';
  }
  assert(nearest.children.length > 0, 'missingLabel: a value with listed fields has some');
  return 'no such field';
}

// A collection entry, or a list or item made of them: a project collection
// (it carries the query that reads it), a sampled query result ("blog entries",
// "portfolio entry"), a loop item stepping through entries, or a sampled entry
// itself, which carries Astro's `collection` and `data` beside each other.
function isEntryLike(node: MissingAnchor): boolean {
  if (node.query !== undefined || node.nav !== undefined) {
    return true;
  }
  if (/\bentr(?:y|ies)$/.test(node.preview)) {
    return true;
  }
  const keys = new Set((node.children ?? []).map((child) => child.key));
  return keys.has('collection') && keys.has('data');
}
