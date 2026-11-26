// What the project ignores, as the Audits panel reads it: each silenced finding and
// the note behind it, when there is one (its own entry's, else its page's), and the "Ignored" list that groups
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
  /** Set on a repeat of an identical match (shared/page/auditFindings.ts numberedRepeats). */
  readonly repeatOf?: string;
  /** Ids it was listed under before it moved (shared/page/auditFindings.ts AuditFinding.formerIds). */
  readonly formerIds?: readonly string[];
}

/** A finding the project ignores, and the note someone left, when they left one. */
export interface IgnoredFinding {
  readonly reason: string | undefined;
}

/** Every ignored finding by id, with its reason: its own entry's wins over its page's. A finding not in the map is not ignored. */
export function ignoreReasons(findings: readonly IgnorableFinding[], file: Pick<AuditFile, 'ignored' | 'ignoredPages'>): ReadonlyMap<string, IgnoredFinding> {
  const own = new Map(file.ignored.map((entry) => [entry.id, entry]));
  const pages = new Map(file.ignoredPages.map((entry) => [entry.file, entry]));
  const reasons = new Map<string, IgnoredFinding>();
  for (const finding of findings) {
    // An ignore of the first of identical matches covers them all, as it did while they shared one id.
    // So does an ignore saved while the finding was listed somewhere else (formerIds), whole files included.
    const former = finding.formerIds ?? [];
    const ids = [finding.id, ...(finding.repeatOf === undefined ? [] : [finding.repeatOf]), ...former];
    const entry = ids.map((id) => own.get(id)).find((found) => found !== undefined);
    const page = [finding.file, ...former.map(fileOfIgnoreId)].map((name) => pages.get(name)).find((found) => found !== undefined);
    if (entry !== undefined || page !== undefined) {
      reasons.set(finding.id, { reason: entry?.reason ?? page?.reason });
    }
  }
  assert(reasons.size <= findings.length, 'ignoreReasons: a subset of the findings');
  return reasons;
}

export interface IgnoredFindingRow {
  readonly id: string;
  readonly reason: string | undefined;
  /** What the entry was about, from the live finding or, when it is gone, from its id. */
  readonly label: string;
  /** False when the audit no longer reports the finding. */
  readonly live: boolean;
}

export interface IgnoredGroup {
  readonly file: string;
  /** The whole-page entry, when the file is ignored whole. */
  readonly page: { readonly reason: string | undefined; readonly count: number } | undefined;
  readonly findings: readonly IgnoredFindingRow[];
}

/** The file an id names: ids read `check|file|path|detail`. */
export function fileOfIgnoreId(id: string): string {
  return id.split('|')[1] ?? '';
}

/** Every ignore entry grouped by file, files in name order. */
export function ignoredGroups(findings: readonly IgnorableFinding[], file: Pick<AuditFile, 'ignored' | 'ignoredPages'>): readonly IgnoredGroup[] {
  const live = new Map(findings.flatMap((finding) => [...(finding.formerIds ?? []), finding.id].map((id) => [id, finding] as const)));
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
    // An entry stays under the file its id names, where the person ignored it.
    group(finding?.id === entry.id ? finding.file : fileOfIgnoreId(entry.id)).findings.push({
      id: entry.id,
      reason: entry.reason,
      label,
      live: finding !== undefined,
    });
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
