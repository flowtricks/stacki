// The audit's state, outside React so the rail's badge and the panel read one
// value: the chosen scope, the last report, whether a run is going, and the
// project's ignore file. The runner (useAuditRunner.ts) is its one writer; it
// keeps running while the panel is closed, so the badge counts what is open.
import { ignoreReasons } from '../../../shared/properties/auditIgnoreList';
import { useSyncExternalStore } from 'react';
import { assert } from '../../../shared/core/assert';
import type { AuditFinding } from '../../../shared/page/auditFindings';
import { EMPTY_AUDIT_IGNORES } from '../../../shared/properties/auditIgnores';
import type { Described } from '../../../shared/properties/i18n/messageRef';
import type { AuditProgress, AuditReport } from './auditRunner';
import { parseAuditScope, type AuditScope } from './auditScope';
import type { StoredIgnores } from './auditsBridge';

export interface AuditState {
  readonly scope: AuditScope;
  readonly report: AuditReport | undefined;
  readonly running: boolean;
  readonly ignores: StoredIgnores;
  /** Why the last run or the ignore file failed, for the panel's note. */
  readonly problem: string | undefined;
  /** Bumped to ask for a run now (Re-audit). */
  readonly request: number;
  /** Measured page performance: on demand, kept until the project changes. */
  readonly performance: PerformanceState;
  /** How far the running audit is, for the panel's progress line; undefined when none runs. */
  readonly progress: AuditProgress | undefined;
  /** The project the scope preference belongs to. */
  readonly projectPath: string | undefined;
}

/** One page's measured score and headline numbers. */
export interface MeasuredPage {
  readonly route: string;
  readonly file: string;
  readonly score: number;
  readonly metrics: {
    readonly lcpMs: number | undefined;
    readonly cls: number;
    readonly tbtMs: number;
    readonly transferBytes: number;
    readonly requests: number;
  };
}

export interface PerformanceState {
  readonly running: boolean;
  /** Each measured page's score and headline numbers; dev-server numbers, so approximations. */
  readonly results: readonly MeasuredPage[];
  readonly findings: readonly AuditFinding[];
  /** Why the last measurement failed, in words (the renderer translates the reference). */
  readonly problem: Described | undefined;
  /** When the last measurement finished, and which audit run it belongs to (a new run means files changed). */
  readonly measuredAt?: number;
  readonly stamp?: number;
  /** When the running measurement started, for its step text. */
  readonly startedAt?: number;
}

const SCOPE_KEY = 'stacki.audits.scope';

/** The scope a project's panel last used: the whole site unless the person chose this page. */
export function storedScope(projectPath: string | undefined): AuditScope {
  if (projectPath === undefined) {
    return 'site';
  }
  try {
    return parseAuditScope(localStorage.getItem(`${SCOPE_KEY}:${projectPath}`) ?? 'site');
  } catch {
    return 'site'; // Storage blocked: every project starts on the whole site.
  }
}

const INITIAL: AuditState = {
  scope: 'site',
  report: undefined,
  running: false,
  ignores: { source: undefined, value: EMPTY_AUDIT_IGNORES },
  problem: undefined,
  request: 0,
  performance: { running: false, results: [], findings: [], problem: undefined },
  progress: undefined,
  projectPath: undefined,
};
let state: AuditState = INITIAL;
const listeners = new Set<() => void>();

export function auditState(): AuditState {
  return state;
}

/** Replaces the state with `update(state)` and tells every reader. */
export function updateAuditState(update: (current: AuditState) => AuditState): void {
  const next = update(state);
  if (next === state) {
    return;
  }
  if (next.scope !== state.scope && next.projectPath !== undefined && next.projectPath === state.projectPath) {
    try {
      localStorage.setItem(`${SCOPE_KEY}:${next.projectPath}`, next.scope);
    } catch {
      // A preference that cannot be stored is kept for this session only.
    }
  }
  state = next;
  for (const listener of [...listeners]) {
    listener();
  }
}

/** A new project starts with no report, its own scope, and its own ignore file still to read. */
export function resetAuditState(projectPath: string): void {
  assert(projectPath.length > 0, 'resetAuditState: a project has a path');
  updateAuditState(() => ({ ...INITIAL, projectPath, scope: storedScope(projectPath) }));
}

export function subscribeAuditState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAuditState(): AuditState {
  return useSyncExternalStore(subscribeAuditState, auditState, auditState);
}

/** The report's findings without the ignored ones. */
export function openFindings(
  current: Pick<AuditState, 'report' | 'ignores'> & { readonly performance?: Pick<PerformanceState, 'findings'> },
): readonly AuditFinding[] {
  const findings = allFindings(current);
  const ignored = ignoreReasons(findings, current.ignores.value);
  const open = findings.filter((finding) => !ignored.has(finding.id));
  assert(open.length <= findings.length, 'openFindings: a subset');
  return open;
}

/** The ignored findings the report still holds, each with its reason. */
export function ignoredFindings(
  current: Pick<AuditState, 'report' | 'ignores'> & { readonly performance?: Pick<PerformanceState, 'findings'> },
): readonly { readonly finding: AuditFinding; readonly reason: string }[] {
  const findings = allFindings(current);
  const reasons = ignoreReasons(findings, current.ignores.value);
  return findings.flatMap((finding) => {
    const reason = reasons.get(finding.id);
    return reason === undefined ? [] : [{ finding, reason }];
  });
}

/** The audit's findings and the measured performance findings, as one list. */
export function allFindings(current: Pick<AuditState, 'report'> & { readonly performance?: Pick<PerformanceState, 'findings'> }): readonly AuditFinding[] {
  return [...(current.report?.findings ?? []), ...(current.performance?.findings ?? [])];
}
