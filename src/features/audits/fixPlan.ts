// The audit's auto-fix planner: which findings "Apply" fixes, and what it will do to each. The panel's
// "N fixes ready" count, its Apply button and the (i) list beside the count all read this one plan, so the list
// can never name a fix Apply will not make, or leave one out. Pure, so it is tested without drawing anything.
import { assert } from '../../../shared/core/assert';
import type { AuditCheckId, AuditFinding, AuditFix } from '../../../shared/page/auditFindings';
import type { MessageRef } from '../../../shared/properties/i18n/messageRef';

/** The fixes the (i) list names before it says "+ N more": a short list reads at a glance in a 260px panel. */
export const FIX_DESCRIPTIONS_MAX = 8;
/** The longest piece of a before or after text a one-line change keeps; the rest ends in an ellipsis. */
export const CHANGE_CHARS_MAX = 48;
/** The most findings a plan describes; a project past it still applies them all, the list names the first. */
const PLAN_FINDINGS_MAX = 5_000;

/** One pending fix, as the (i) list shows it. */
export interface FixDescription {
  readonly id: string;
  readonly check: AuditCheckId;
  /** Project-relative file the fix writes to. */
  readonly file: string;
  /** The element the fix changes, when the finding names one. */
  readonly element: AuditFinding['element'];
  /** The fix's button words, English and translatable: "Add alt". */
  readonly label: string;
  readonly labelRef: MessageRef | undefined;
  /** What changes, in one line each; an empty side is shown as nothing. */
  readonly change: { readonly before: string; readonly after: string };
  /** The finding, so a click goes where the audit's own row goes. */
  readonly finding: AuditFinding;
}

export interface FixPlan {
  /** Every finding Apply fixes, in the list's order: Apply writes exactly these. */
  readonly findings: readonly AuditFinding[];
  /** The first `FIX_DESCRIPTIONS_MAX` of them, described. */
  readonly descriptions: readonly FixDescription[];
  /** Fixes past the cap, named only by count. */
  readonly hiddenCount: number;
}

/** The plan for the findings the view says are fixable (each has a fix and none is ignored). */
export function planFixes(fixable: readonly AuditFinding[]): FixPlan {
  assert(
    fixable.every((finding) => finding.fix !== undefined),
    'planFixes: every planned finding has a fix',
  );
  const described: FixDescription[] = [];
  for (const finding of fixable.slice(0, Math.min(FIX_DESCRIPTIONS_MAX, PLAN_FINDINGS_MAX))) {
    const fix = finding.fix;
    if (fix !== undefined) {
      described.push(describeFix(finding, fix));
    }
  }
  assert(described.length <= FIX_DESCRIPTIONS_MAX, 'planFixes: the list is capped');
  assert(described.length === Math.min(fixable.length, FIX_DESCRIPTIONS_MAX), 'planFixes: every finding up to the cap is described');
  return { findings: fixable, descriptions: described, hiddenCount: fixable.length - described.length };
}

function describeFix(finding: AuditFinding, fix: AuditFix): FixDescription {
  return {
    id: finding.id,
    check: finding.check,
    file: finding.file,
    element: finding.element,
    label: fix.label,
    labelRef: fix.labelRef,
    change: changeLine(finding, fix),
    finding,
  };
}

/** A raw value reads `padding: 0.9375rem` → `var(--space-m)`; markup shows only the part that differs. */
export function changeLine(finding: Pick<AuditFinding, 'css'>, fix: Pick<AuditFix, 'label' | 'before' | 'after'>): FixDescription['change'] {
  if (finding.css !== undefined) {
    return { before: clip(`${finding.css.property}: ${finding.css.value}`), after: clip(fix.label.replace(/^Use /, '')) };
  }
  return differing(fix.before, fix.after);
}

const TOKEN_PATTERN = /(\s+|[="'<>/])/;

/** The tokens that differ between two snippets, once the shared start and end are dropped. */
export function differing(before: string, after: string): FixDescription['change'] {
  const left = before.split(TOKEN_PATTERN).filter((token) => token.length > 0);
  const right = after.split(TOKEN_PATTERN).filter((token) => token.length > 0);
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) {
    start += 1;
  }
  let end = 0;
  while (end < left.length - start && end < right.length - start && left[left.length - 1 - end] === right[right.length - 1 - end]) {
    end += 1;
  }
  const middle = (tokens: readonly string[]): string =>
    clip(
      tokens
        .slice(start, tokens.length - end)
        .join('')
        .trim(),
    );
  return { before: middle(left), after: middle(right) };
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= CHANGE_CHARS_MAX ? flat : `${flat.slice(0, CHANGE_CHARS_MAX - 1)}…`;
}
