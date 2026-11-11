// The hand-off prompt: audit findings written up for the coding agent, so it
// can fix what needs a judgement Stacki will not make on its own — alt text
// that says what an image shows, a label's words, copy rewritten to length.
// The prompt states each finding, where it is (file, line, element path), why
// it matters (the WCAG criterion or the SEO reason), and the rules an edit in a
// Stacki project keeps. It never asks the agent to guess: content it cannot
// know is for it to ask about.
//
// The value it returns has the shape of an agent task (shared/properties/agentTask.ts);
// the page area cannot import that module, and does not need to.
import { assert } from '../core/assert';
import { AUDIT_CHECKS, type AuditFinding } from './auditFindings';

/** Findings one prompt carries; a larger selection is sent in parts. */
export const AUDIT_PROMPT_FINDINGS_MAX = 60;
/** Characters of the prompt, inside the agent task's own bound. */
const PROMPT_CHARS_MAX = 50_000;

/** The constraints every Stacki Astro project's edits keep, quoted in each prompt. */
export const STACKI_PROJECT_RULES: readonly string[] = [
  'Edit the .astro source, never generated output; keep every other byte of a file as it is.',
  'When an issue is inside a component or layout, fix it in that component’s file, so every use is fixed; say which pages that touches.',
  'Do not put Stacki markup in Astro files; do not rename or move components unless a finding asks for it.',
  'Keep existing classes and styles; never rewrite selectors or scoping in a <style> block.',
  'Lumos projects use rem, never px, for sizes.',
  'Do not invent content. Where alt text, a label or copy needs words you cannot infer from the page, ask before writing them.',
  'After editing, run `astro check` (or the project’s build) and make sure the page still renders.',
];

export interface AuditPromptTask {
  readonly title: string;
  readonly prompt: string;
  readonly context: {
    readonly files: readonly string[];
    readonly nodeRefs: readonly { readonly file: string; readonly path: readonly number[] }[];
    readonly findingIds: readonly string[];
  };
}

/** The agent task for `findings` in the project named `projectName`. */
export function auditPrompt(findings: readonly AuditFinding[], projectName: string): AuditPromptTask {
  assert(findings.length > 0, 'auditPrompt: a hand-off carries at least one finding');
  assert(findings.length <= AUDIT_PROMPT_FINDINGS_MAX, 'auditPrompt: a hand-off is bounded');
  const files = [...new Set(findings.map((finding) => finding.file))].sort();
  const sections = files.map((file) =>
    fileSection(
      file,
      findings.filter((finding) => finding.file === file),
    ),
  );
  const first = findings[0];
  assert(first !== undefined, 'auditPrompt: the first finding exists');
  const title = findings.length === 1 ? `Fix: ${AUDIT_CHECKS[first.check].title}` : `Fix ${findings.length} audit findings`;
  const prompt = [
    `Fix these accessibility and SEO findings from Stacki's Audits panel in the Astro project "${projectName}".`,
    '',
    ...sections,
    '## Constraints',
    ...STACKI_PROJECT_RULES.map((rule) => `- ${rule}`),
    '',
    'When you are done, list each finding and what you changed, or why you left it.',
  ].join('\n');
  const bounded = prompt.length > PROMPT_CHARS_MAX ? `${prompt.slice(0, PROMPT_CHARS_MAX - 40)}\n\n(The list was cut to fit.)` : prompt;
  assert(bounded.length <= PROMPT_CHARS_MAX, 'auditPrompt: the prompt is bounded');
  return {
    title,
    prompt: bounded,
    context: {
      files,
      nodeRefs: findings.flatMap((finding) => (finding.element === undefined ? [] : [{ file: finding.file, path: finding.element.path }])),
      findingIds: findings.map((finding) => finding.id),
    },
  };
}

function fileSection(file: string, findings: readonly AuditFinding[]): string {
  assert(findings.length > 0, 'fileSection: a section has findings');
  const kind = findings[0]?.fileKind ?? 'page';
  const note = kind === 'component' || kind === 'layout' ? ` (a ${kind}: a fix here changes every page that uses it)` : '';
  const lines = findings.map((finding, index) => findingLines(finding, index + 1));
  return [`## ${file}${note}`, '', ...lines, ''].join('\n');
}

function findingLines(finding: AuditFinding, number: number): string {
  const check = AUDIT_CHECKS[finding.check];
  const element = finding.element;
  const where =
    element === undefined
      ? 'the file as a whole'
      : `<${element.tag}>${element.line === undefined ? '' : ` on line ${element.line}`}, element path ${element.path.join('.')}`;
  return [
    `${number}. ${check.title} — ${finding.detail}`,
    `   Where: ${where}${finding.source === 'rendered' ? ' (seen in the rendered page)' : ''}`,
    ...(finding.excerpt === undefined ? [] : [`   Current text: "${finding.excerpt}"`]),
    ...(finding.routes === undefined ? [] : [`   Seen on: ${finding.routes.join(', ')}`]),
    `   Why: ${check.why}`,
    `   Reference: ${check.reference}`,
    `   Finding id: ${finding.id}`,
  ].join('\n');
}

/** `findings` in parts of at most AUDIT_PROMPT_FINDINGS_MAX, so a bulk hand-off never exceeds a prompt's bound. */
export function promptBatches(findings: readonly AuditFinding[]): readonly (readonly AuditFinding[])[] {
  const batches: AuditFinding[][] = [];
  for (let start = 0; start < findings.length; start += AUDIT_PROMPT_FINDINGS_MAX) {
    batches.push(findings.slice(start, start + AUDIT_PROMPT_FINDINGS_MAX));
  }
  assert(batches.flat().length === findings.length, 'promptBatches: every finding is in one part');
  return batches;
}
