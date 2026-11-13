// What the style selectors panel shows: the report's entries filtered by
// verdict and search text, grouped by file in the report's order. Pure, so the
// panel's rendering holds no decisions of its own. Folders head their sheets
// when the project has more than one. A locked stylesheet's selectors are
// `kept`, so the Unused view never lists them: they are under Locked and All.
import { assert } from '../../../shared/core/assert';
import type { MessageRef } from '../../../shared/core/i18n/messageReference';
import type { SelectorEntry, SelectorReport, SelectorVerdictKind } from '../../../shared/properties/selectorUsage';
import type { StyleKeepList } from '../../../shared/properties/styleKeepList';

export type SelectorFilter = 'all' | 'unused' | 'unknown' | 'kept';
// Ordered by what needs a decision: what can go, what cannot be proven, what
// was locked, then everything.
export const SELECTOR_FILTERS: readonly SelectorFilter[] = ['unused', 'unknown', 'kept', 'all'];

export interface SelectorGroup {
  readonly rel: string;
  readonly entries: readonly SelectorEntry[];
}

export type SelectorCounts = Readonly<Record<SelectorFilter, number>>;

const NO_HELD_ROWS: ReadonlySet<string> = new Set();
const NO_HELD_REASONS: ReadonlyMap<string, string> = new Map();

// What the panel lists: selectors a clean-up could ever act on, once each.
// A selector with no class or id (`h1`, `:is([data-x])`) is never removed, so
// it is not listed; the same selector written in several rules of one file
// (once per breakpoint, say) is one row — its verdict is the same in each.
export function listedEntries(report: SelectorReport): readonly SelectorEntry[] {
  const seen = new Set<string>();
  const out: SelectorEntry[] = [];
  for (const entry of report.entries) {
    if (entry.verdict.kind === 'untracked') {
      continue;
    }
    const key = `${entry.rel}\u0000${entry.selector}\u0000${entry.verdict.kind}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(entry);
    }
  }
  assert(out.length <= report.entries.length, 'listedEntries: listing never adds entries');
  return out;
}

export function selectorCounts(report: SelectorReport): SelectorCounts {
  const listed = listedEntries(report);
  let unused = 0;
  let unknown = 0;
  let kept = 0;
  for (const entry of listed) {
    if (entry.verdict.kind === 'unused') {
      unused += 1;
    } else if (entry.verdict.kind === 'unknown') {
      unknown += 1;
    } else if (entry.verdict.kind === 'kept') {
      kept += 1;
    }
  }
  assert(unused + unknown + kept <= listed.length, 'selectorCounts: each entry counts once');
  return { all: listed.length, unused, unknown, kept };
}

// `held` names rows that keep their place though their verdict has left the
// filter: a row whose lock was just clicked stays while it animates out.
export function selectorGroups(
  report: SelectorReport,
  filter: SelectorFilter,
  search: string,
  held: ReadonlySet<string> = NO_HELD_ROWS,
): readonly SelectorGroup[] {
  const query = search.trim().toLowerCase();
  const groups = new Map<string, SelectorEntry[]>();
  for (const entry of listedEntries(report)) {
    if (matchesFilter(entry.verdict.kind, filter)) {
      // Listed by its verdict.
    } else if (held.has(entry.id)) {
      // Listed until its animation ends.
    } else {
      continue;
    }
    if (query !== '') {
      if (!entry.selector.toLowerCase().includes(query)) {
        continue;
      }
    }
    const list = groups.get(entry.rel) ?? [];
    list.push(entry);
    groups.set(entry.rel, list);
  }
  return [...groups].map(([rel, entries]) => ({ rel, entries }));
}

/** The stylesheets of one folder, under its heading; `folder` is undefined when the project has one folder. */
export interface FolderGroup {
  readonly folder: string | undefined;
  readonly sheets: readonly SelectorGroup[];
}

/** The folder a stylesheet sits in, as a locked folder path (`src/styles/`); `''` at the project root. */
export function folderOf(rel: string): string {
  assert(rel !== '', 'folderOf: the stylesheet is named');
  assert(!rel.endsWith('/'), 'folderOf: a stylesheet is a file');
  return rel.slice(0, rel.lastIndexOf('/') + 1);
}

// Folder headings appear only when the project's stylesheets sit in more than
// one folder; with one, a file lock says everything a folder lock would.
// Folders keep the order their first stylesheet has in the report.
export function folderGroups(report: SelectorReport, sheets: readonly SelectorGroup[]): readonly FolderGroup[] {
  const folders = new Set(listedEntries(report).map((entry) => folderOf(entry.rel)));
  if (folders.size <= 1) {
    return sheets.length === 0 ? [] : [{ folder: undefined, sheets }];
  }
  const grouped = new Map<string, SelectorGroup[]>();
  for (const sheet of sheets) {
    const folder = folderOf(sheet.rel);
    const list = grouped.get(folder) ?? [];
    list.push(sheet);
    grouped.set(folder, list);
  }
  const out = [...grouped].map(([folder, list]) => ({ folder, sheets: list }));
  assert(out.reduce((total, group) => total + group.sheets.length, 0) === sheets.length, 'folderGroups: every sheet is in one folder');
  return out;
}

/** "Can't tell" entries grouped by their reason, largest group first, so each reason is explained once. */
export interface ReasonGroup {
  readonly reason: string;
  /** The reason as a message reference, when the report carried one: the panel words it in the person's language. */
  readonly reasonRef?: MessageRef | undefined;
  readonly entries: readonly SelectorEntry[];
}

// A held row keeps the reason text it was listed under after its report is gone, so the references of reasons seen so far are
// remembered by that text. Bounded: the reasons are a handful of sentences per project, and the cache starts over when it fills.
const REASON_REFS_MAX = 256;
const reasonRefs = new Map<string, MessageRef>();

function rememberReasonRef(reason: string, reasonRef: MessageRef): void {
  if (reasonRefs.size >= REASON_REFS_MAX) {
    reasonRefs.clear();
  }
  reasonRefs.set(reason, reasonRef);
}

// `held` maps a row that has just left "Can't tell" to the reason it was
// listed under, so it stays in its group while it animates out.
export function unknownReasons(report: SelectorReport, search: string, held: ReadonlyMap<string, string> = NO_HELD_REASONS): readonly ReasonGroup[] {
  const query = search.trim().toLowerCase();
  const groups = new Map<string, SelectorEntry[]>();
  for (const entry of listedEntries(report)) {
    const { verdict } = entry;
    if (verdict.kind === 'unknown' && verdict.reasonRef !== undefined) {
      rememberReasonRef(verdict.reason, verdict.reasonRef);
    }
    const reason = verdict.kind === 'unknown' ? verdict.reason : held.get(entry.id);
    if (reason === undefined) {
      continue;
    }
    if (query !== '') {
      if (!entry.selector.toLowerCase().includes(query)) {
        continue;
      }
    }
    const group = groups.get(reason) ?? [];
    group.push(entry);
    groups.set(reason, group);
  }
  return [...groups]
    .map(([reason, entries]) => ({ reason, reasonRef: reasonRefs.get(reason), entries }))
    .sort((left, right) => right.entries.length - left.entries.length);
}

/** The filter a panel opens on: the clean-up when there is one, otherwise everything. */
export function initialFilter(report: SelectorReport): SelectorFilter {
  return report.entries.some((entry) => entry.verdict.kind === 'unused') ? 'unused' : 'all';
}

/** A piece of a selector as the panel draws it: `flagged` marks a name the verdict is about. */
export interface SelectorSegment {
  readonly text: string;
  readonly flagged: boolean;
}

// The names a verdict is about, found in the selector as written (`.name` or
// `#name`, with CSS escapes), so the panel can tint exactly the part that
// makes a rule removable. Names that cannot be found leave the text plain.
export function selectorSegments(selector: string, names: readonly string[]): readonly SelectorSegment[] {
  if (names.length === 0) {
    return [{ text: selector, flagged: false }];
  }
  const written = names.map((name) => name.replace(/[^A-Za-z0-9_-]/g, (char) => `\\${char}`).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`[.#](?:${written.join('|')})(?![A-Za-z0-9_-])`, 'g');
  const segments: SelectorSegment[] = [];
  let cursor = 0;
  for (const match of selector.matchAll(pattern)) {
    if (match.index > cursor) {
      segments.push({ text: selector.slice(cursor, match.index), flagged: false });
    }
    segments.push({ text: match[0], flagged: true });
    cursor = match.index + match[0].length;
  }
  if (cursor < selector.length) {
    segments.push({ text: selector.slice(cursor), flagged: false });
  }
  assert(segments.map((segment) => segment.text).join('') === selector, 'selectorSegments: the pieces spell the selector');
  return segments;
}

/** Rows drawn at a time; more load as the list scrolls to its end. */
export const LIST_PAGE_ROWS = 200;

/** The first `limit` rows across groups, the last group cut short, and how many rows there are in all. */
export function firstRows<G extends { readonly entries: readonly SelectorEntry[] }>(
  groups: readonly G[],
  limit: number,
): { readonly groups: readonly G[]; readonly total: number } {
  assert(Number.isSafeInteger(limit), 'firstRows: the limit is a whole number');
  assert(limit >= 0, 'firstRows: the limit is not negative');
  const out: G[] = [];
  let left = limit;
  let total = 0;
  for (const group of groups) {
    total += group.entries.length;
    if (left > 0) {
      out.push(group.entries.length <= left ? group : { ...group, entries: group.entries.slice(0, left) });
      left -= Math.min(left, group.entries.length);
    }
  }
  return { groups: out, total };
}

/** The entries a cleanup would remove, in report order. */
export function unusedEntries(report: SelectorReport): readonly SelectorEntry[] {
  return report.entries.filter((entry) => entry.verdict.kind === 'unused');
}

/** The keep-list patterns that name `name` exactly; wildcard patterns are edited in the file. */
export function exactPatterns(keepList: StyleKeepList, names: readonly string[]): readonly string[] {
  const wanted = new Set(names);
  return keepList.keep.filter((pattern) => wanted.has(pattern));
}

/** Whether a verdict is listed under a filter's tab. */
export function matchesFilter(kind: SelectorVerdictKind, filter: SelectorFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'unused':
      return kind === 'unused';
    case 'unknown':
      return kind === 'unknown';
    case 'kept':
      return kind === 'kept';
    default: {
      const exhaustive: never = filter;
      return exhaustive;
    }
  }
}
