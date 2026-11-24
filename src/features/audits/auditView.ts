// What the Audits panel shows, worked out from the report and the panel's own
// controls: the category filter and its counts, the search, whether ignored
// findings show, and the findings grouped by priority and then by rule. Pure,
// so the panel's behaviour is tested without drawing it. A custom audit joins a
// built-in category or one of the project's own (`category:Brand`), which the
// category dropdown lists after the built-in ones.
import { assert } from '../../../shared/core/assert';
import {
  AUDIT_CHECKS,
  AUDIT_PRIORITIES,
  findingPriority,
  findingsByRule,
  type AuditCategory,
  type AuditFinding,
  type AuditPriority,
  type AuditRuleGroup,
} from '../../../shared/page/auditFindings';
import { builtinCategoryOf } from '../../../shared/properties/customAudits';
import { planFixes, type FixPlan } from './fixPlan';

export const AUDIT_FILTERS = ['all', 'accessibility', 'seo', 'content', 'tokens', 'performance'] as const;
export type BuiltinAuditFilter = (typeof AUDIT_FILTERS)[number];
/** A category of the project's own, named by its custom audits: `category:Brand`. */
export type CustomCategoryFilter = `category:${string}`;
export type AuditFilter = BuiltinAuditFilter | CustomCategoryFilter;

/** Custom categories one panel lists at most: the custom audit list is bounded, and so is this. */
export const CUSTOM_CATEGORIES_MAX = 50;

/** The filter for a project's own category name. */
export function customCategoryFilter(name: string): CustomCategoryFilter {
  assert(name.length > 0, 'customCategoryFilter: a category has a name');
  return `category:${name}`;
}

/** The filter a stored or typed value names, or undefined when it names none. */
export function parseAuditFilter(raw: string | undefined): AuditFilter | undefined {
  const builtin = AUDIT_FILTERS.find((filter) => filter === raw);
  if (builtin !== undefined) {
    return builtin;
  }
  return raw !== undefined && raw.startsWith('category:') && raw.length > 'category:'.length ? customCategoryFilter(raw.slice('category:'.length)) : undefined;
}

export interface AuditViewInput {
  readonly findings: readonly AuditFinding[];
  /** Ids the project ignores. */
  readonly ignored: ReadonlySet<string>;
  readonly filter: AuditFilter;
  readonly search: string;
  readonly showIgnored: boolean;
  /** The project's own category names its enabled custom audits use, so a category is listed before it has findings. */
  readonly customCategories?: readonly string[];
}

export interface AuditView {
  /** Open (not ignored) findings in each built-in category, before the filter and search; `all` counts custom categories too. */
  readonly counts: Readonly<Record<BuiltinAuditFilter, number>>;
  /** The project's own categories, in name order, with their open findings. */
  readonly customCategories: readonly { readonly filter: CustomCategoryFilter; readonly name: string; readonly count: number }[];
  /** Open findings by priority, for the summary line. */
  readonly priorities: Readonly<Record<AuditPriority, number>>;
  /** What the list shows: each priority's rules, in order; empty priorities left out. */
  readonly groups: readonly { readonly priority: AuditPriority; readonly rules: readonly AuditRuleGroup[]; readonly count: number }[];
  /** The shown findings with a deterministic fix. */
  readonly fixable: readonly AuditFinding[];
  /** What Apply does to `fixable`: the same findings, described; the panel's list and its Apply both read it. */
  readonly fixPlan: FixPlan;
  readonly shown: readonly AuditFinding[];
  readonly ignoredCount: number;
}

/** A finding's category: its check's, or for a custom audit the built-in one it joined or `category:<name>` of its own. */
export function findingCategory(finding: AuditFinding): AuditCategory | CustomCategoryFilter {
  if (finding.custom === undefined) {
    return AUDIT_CHECKS[finding.check].category;
  }
  return builtinCategoryOf(finding.custom.category) ?? customCategoryFilter(finding.custom.category);
}

function matches(finding: AuditFinding, words: readonly string[]): boolean {
  const title = finding.custom?.name ?? AUDIT_CHECKS[finding.check].title;
  const haystack = `${title} ${finding.file} ${finding.detail} ${finding.element?.tag ?? ''}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

// The project's own categories: those its findings carry and those its enabled audits name, each once, in name order.
function customCategoriesOf(
  open: readonly AuditFinding[],
  named: readonly string[],
): readonly { readonly filter: CustomCategoryFilter; readonly name: string; readonly count: number }[] {
  const counts = new Map<string, number>();
  for (const name of named) {
    if (builtinCategoryOf(name) === undefined) {
      counts.set(name, 0);
    }
  }
  for (const finding of open) {
    const category = findingCategory(finding);
    if (category.startsWith('category:')) {
      const name = category.slice('category:'.length);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  const list = [...counts]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, CUSTOM_CATEGORIES_MAX)
    .map(([name, count]) => ({ filter: customCategoryFilter(name), name, count }));
  assert(list.length <= CUSTOM_CATEGORIES_MAX, 'customCategoriesOf: bounded');
  return list;
}

export function auditView(input: AuditViewInput): AuditView {
  const open = input.findings.filter((finding) => !input.ignored.has(finding.id));
  const count = (wanted: AuditCategory): number => open.filter((finding) => findingCategory(finding) === wanted).length;
  const customCategories = customCategoriesOf(open, input.customCategories ?? []);
  const inCustom = customCategories.reduce((total, entry) => total + entry.count, 0);
  const counts = {
    all: open.length,
    accessibility: count('accessibility'),
    seo: count('seo'),
    content: count('content'),
    tokens: count('tokens'),
    performance: count('performance'),
  };
  assert(
    counts.accessibility + counts.seo + counts.content + counts.tokens + counts.performance + inCustom === counts.all,
    'auditView: every finding is in one category',
  );
  const priorities = { high: 0, medium: 0, low: 0 };
  for (const finding of open) {
    priorities[findingPriority(finding)] += 1;
  }
  const words = input.search
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const pool = input.showIgnored ? input.findings : open;
  const shown = pool.filter((finding) => (input.filter === 'all' || findingCategory(finding) === input.filter) && matches(finding, words));
  const groups = AUDIT_PRIORITIES.map((priority) => {
    const inPriority = shown.filter((finding) => findingPriority(finding) === priority);
    return { priority, rules: findingsByRule(inPriority), count: inPriority.length };
  }).filter((group) => group.count > 0);
  const fixable = shown.filter((finding) => finding.fix !== undefined && !input.ignored.has(finding.id));
  return {
    counts,
    customCategories,
    priorities,
    groups,
    fixable,
    fixPlan: planFixes(fixable),
    shown,
    ignoredCount: input.findings.length - open.length,
  };
}
