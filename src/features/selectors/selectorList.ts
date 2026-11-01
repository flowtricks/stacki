// What the style selectors panel shows: the report's entries filtered by
// verdict and search text, grouped by file in the report's order. Pure, so the
// panel's rendering holds no decisions of its own.
import { assert } from '../../../shared/core/assert';
import type { SelectorEntry, SelectorReport, SelectorVerdictKind } from '../../../shared/properties/selectorUsage';
import type { StyleKeepList } from '../../../shared/properties/styleKeepList';

export type SelectorFilter = 'all' | 'unused' | 'unknown' | 'kept';
// Ordered by what needs a decision: what can go, what cannot be proven, what was kept.
export const SELECTOR_FILTERS: readonly SelectorFilter[] = ['unused', 'unknown', 'kept', 'all'];

export interface SelectorGroup {
  readonly rel: string;
  readonly entries: readonly SelectorEntry[];
}

export type SelectorCounts = Readonly<Record<SelectorFilter, number>>;

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

export function selectorGroups(report: SelectorReport, filter: SelectorFilter, search: string): readonly SelectorGroup[] {
  const query = search.trim().toLowerCase();
  const groups = new Map<string, SelectorEntry[]>();
  for (const entry of listedEntries(report)) {
    if (!matchesFilter(entry.verdict.kind, filter)) {
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

/** "Can't tell" entries grouped by their reason, largest group first, so each reason is explained once. */
export interface ReasonGroup {
  readonly reason: string;
  readonly entries: readonly SelectorEntry[];
}

export function unknownReasons(report: SelectorReport, search: string): readonly ReasonGroup[] {
  const query = search.trim().toLowerCase();
  const groups = new Map<string, SelectorEntry[]>();
  for (const entry of listedEntries(report)) {
    const { verdict } = entry;
    if (verdict.kind !== 'unknown') {
      continue;
    }
    if (query !== '') {
      if (!entry.selector.toLowerCase().includes(query)) {
        continue;
      }
    }
    const group = groups.get(verdict.reason) ?? [];
    group.push(entry);
    groups.set(verdict.reason, group);
  }
  return [...groups].map(([reason, entries]) => ({ reason, entries })).sort((left, right) => right.entries.length - left.entries.length);
}

/** The filter a panel opens on: the clean-up when there is one, otherwise everything. */
export function initialFilter(report: SelectorReport): SelectorFilter {
  return report.entries.some((entry) => entry.verdict.kind === 'unused') ? 'unused' : 'all';
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

function matchesFilter(kind: SelectorVerdictKind, filter: SelectorFilter): boolean {
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
