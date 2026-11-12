// What the project ignores, as the Audits panel reads it: the reason each finding
// is silenced (its own entry, else its page's), and the "Ignored" list that groups
// every entry by file with the page entry first. Pure, so the flows are tested
// without drawing the panel. An entry whose finding or page is gone is still listed
// (`live: false`): a stale ignore must stay removable.
import { assert } from '../core/assert';
import type { AuditFile } from './auditIgnores';

/** What the ignore list needs of a finding (an AuditFinding qualifies; shared/properties may not import shared/page). */
export interface IgnorableFinding {
  readonly id: string;
  readonly file: string;
  readonly detail: string;
}

/** Why each ignored finding is ignored: its own reason wins over its page's. */
export function ignoreReasons(findings: readonly IgnorableFinding[], file: Pick<AuditFile, 'ignored' | 'ignoredPages'>): ReadonlyMap<string, string> {
  const own = new Map(file.ignored.map((entry) => [entry.id, entry.reason]));
  const pages = new Map(file.ignoredPages.map((entry) => [entry.file, entry.reason]));
  const reasons = new Map<string, string>();
  for (const finding of findings) {
    const reason = own.get(finding.id) ?? pages.get(finding.file);
    if (reason !== undefined) {
      reasons.set(finding.id, reason);
    }
  }
  assert(reasons.size <= findings.length, 'ignoreReasons: a subset of the findings');
  return reasons;
}

export interface IgnoredFindingRow {
  readonly id: string;
  readonly reason: string;
  /** What the entry was about, from the live finding or, when it is gone, from its id. */
  readonly label: string;
  /** False when the audit no longer reports the finding. */
  readonly live: boolean;
}

export interface IgnoredGroup {
  readonly file: string;
  /** The whole-page entry, when the file is ignored whole. */
  readonly page: { readonly reason: string; readonly count: number } | undefined;
  readonly findings: readonly IgnoredFindingRow[];
}

/** The file an id names: ids read `check|file|path|detail`. */
export function fileOfIgnoreId(id: string): string {
  return id.split('|')[1] ?? '';
}

/** Every ignore entry grouped by file, files in name order. */
export function ignoredGroups(findings: readonly IgnorableFinding[], file: Pick<AuditFile, 'ignored' | 'ignoredPages'>): readonly IgnoredGroup[] {
  const live = new Map(findings.map((finding) => [finding.id, finding]));
  const groups = new Map<string, { page: IgnoredGroup['page']; findings: IgnoredFindingRow[] }>();
  const group = (name: string): { page: IgnoredGroup['page']; findings: IgnoredFindingRow[] } => {
    const held = groups.get(name) ?? { page: undefined, findings: [] };
    groups.set(name, held);
    return held;
  };
  for (const page of file.ignoredPages) {
    group(page.file).page = { reason: page.reason, count: findings.filter((finding) => finding.file === page.file).length };
  }
  for (const entry of file.ignored) {
    const finding = live.get(entry.id);
    const label = finding === undefined ? entry.id.split('|').slice(3).join('|') || entry.id : finding.detail;
    group(finding?.file ?? fileOfIgnoreId(entry.id)).findings.push({ id: entry.id, reason: entry.reason, label, live: finding !== undefined });
  }
  const sorted = [...groups]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([name, held]) => ({ file: name, page: held.page, findings: held.findings }));
  assert(sorted.reduce((total, held) => total + held.findings.length, 0) === file.ignored.length, 'ignoredGroups: every finding entry in one group');
  return sorted;
}

/** How many entries the Ignored list holds: pages and findings. */
export function ignoredEntryCount(file: Pick<AuditFile, 'ignored' | 'ignoredPages'>): number {
  return file.ignored.length + file.ignoredPages.length;
}
