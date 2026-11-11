// What the Audits panel shows, worked out from the report and the panel's own
// controls: the category filter and its counts, the search, whether ignored
// findings show, and the findings grouped by priority and then by rule. Pure,
// so the panel's behaviour is tested without drawing it.
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

export const AUDIT_FILTERS = ['all', 'accessibility', 'seo', 'content', 'tokens', 'performance'] as const;
export type AuditFilter = (typeof AUDIT_FILTERS)[number];

export interface AuditViewInput {
  readonly findings: readonly AuditFinding[];
  /** Ids the project ignores. */
  readonly ignored: ReadonlySet<string>;
  readonly filter: AuditFilter;
  readonly search: string;
  readonly showIgnored: boolean;
}

export interface AuditView {
  /** Open (not ignored) findings in each category, before the filter and search. */
  readonly counts: Readonly<Record<AuditFilter, number>>;
  /** Open findings by priority, for the summary line. */
  readonly priorities: Readonly<Record<AuditPriority, number>>;
  /** What the list shows: each priority's rules, in order; empty priorities left out. */
  readonly groups: readonly { readonly priority: AuditPriority; readonly rules: readonly AuditRuleGroup[]; readonly count: number }[];
  /** The shown findings with a deterministic fix. */
  readonly fixable: readonly AuditFinding[];
  readonly shown: readonly AuditFinding[];
  readonly ignoredCount: number;
}

function category(finding: AuditFinding): AuditCategory {
  return AUDIT_CHECKS[finding.check].category;
}

function matches(finding: AuditFinding, words: readonly string[]): boolean {
  const haystack = `${AUDIT_CHECKS[finding.check].title} ${finding.file} ${finding.detail} ${finding.element?.tag ?? ''}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

export function auditView(input: AuditViewInput): AuditView {
  const open = input.findings.filter((finding) => !input.ignored.has(finding.id));
  const count = (wanted: AuditCategory): number => open.filter((finding) => category(finding) === wanted).length;
  const counts = {
    all: open.length,
    accessibility: count('accessibility'),
    seo: count('seo'),
    content: count('content'),
    tokens: count('tokens'),
    performance: count('performance'),
  };
  assert(counts.accessibility + counts.seo + counts.content + counts.tokens + counts.performance === counts.all, 'auditView: every finding is in one category');
  const priorities = { high: 0, medium: 0, low: 0 };
  for (const finding of open) {
    priorities[findingPriority(finding)] += 1;
  }
  const words = input.search
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const pool = input.showIgnored ? input.findings : open;
  const shown = pool.filter((finding) => (input.filter === 'all' || category(finding) === input.filter) && matches(finding, words));
  const groups = AUDIT_PRIORITIES.map((priority) => {
    const inPriority = shown.filter((finding) => findingPriority(finding) === priority);
    return { priority, rules: findingsByRule(inPriority), count: inPriority.length };
  }).filter((group) => group.count > 0);
  return {
    counts,
    priorities,
    groups,
    fixable: shown.filter((finding) => finding.fix !== undefined && !input.ignored.has(finding.id)),
    shown,
    ignoredCount: input.findings.length - open.length,
  };
}
