// What the style selectors panel shows: the report's entries filtered by
// verdict and search text, grouped by file in the report's order. Pure, so the
// panel's rendering holds no decisions of its own.
import { assert } from '../../../shared/core/assert';
import type { SelectorEntry, SelectorReport, SelectorVerdictKind } from '../../../shared/properties/selectorUsage';
import type { StyleKeepList } from '../../../shared/properties/styleKeepList';

export type SelectorFilter = 'all' | 'unused' | 'unknown' | 'kept';
export const SELECTOR_FILTERS: readonly SelectorFilter[] = ['all', 'unused', 'unknown', 'kept'];

export interface SelectorGroup {
  readonly rel: string;
  readonly entries: readonly SelectorEntry[];
}

export type SelectorCounts = Readonly<Record<SelectorFilter, number>>;

export function selectorCounts(report: SelectorReport): SelectorCounts {
  let unused = 0;
  let unknown = 0;
  let kept = 0;
  for (const entry of report.entries) {
    if (entry.verdict.kind === 'unused') {
      unused += 1;
    } else if (entry.verdict.kind === 'unknown') {
      unknown += 1;
    } else if (entry.verdict.kind === 'kept') {
      kept += 1;
    }
  }
  assert(unused + unknown + kept <= report.entries.length, 'selectorCounts: each entry counts once');
  return { all: report.entries.length, unused, unknown, kept };
}

export function selectorGroups(report: SelectorReport, filter: SelectorFilter, search: string): readonly SelectorGroup[] {
  const query = search.trim().toLowerCase();
  const groups = new Map<string, SelectorEntry[]>();
  for (const entry of report.entries) {
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
