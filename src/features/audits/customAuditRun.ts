// The project's custom audits in an audit run: each enabled audit's patterns compiled through the guard, then run by the shared
// matcher over the files the run read. Findings are ordinary findings of check `custom` that name their audit, so they list,
// count, ignore and hand off like any other; a declaration in a `<style>` block or a stylesheet carries its place, so its row
// opens the code window at the line, and a markup match names the element it is inside, so its row selects it.
//
// An audit whose patterns the guard refuses (a hand-edited file) runs nothing and is reported in `problems`; one that reached
// its caps or its time budget is reported in `stopped`. Neither stops the rest of the audit.
import { assert } from '../../../shared/core/assert';
import { auditFinding, type AuditCustomRef, type AuditFileKind, type AuditFinding } from '../../../shared/page/auditFindings';
import { CUSTOM_MATCH_LIMITS, markupText, scanCustom, type CustomMatch, type CustomMatcher } from '../../../shared/page/auditCustom';
import { lineOf, lineStarts, nodeChildren } from '../../../shared/page/auditMarkup';
import type { PageNode } from '../../../shared/page/pageNode';
import { compileCustomAudit, type CustomAudit, type CustomAuditProblem } from '../../../shared/properties/customAudits';

/** A file the run read, as custom audits see it. */
export type CustomAuditSource =
  | {
      readonly kind: 'astro';
      readonly file: string;
      readonly fileKind: Exclude<AuditFileKind, 'site'>;
      readonly source: string;
      readonly nodes: readonly PageNode[];
    }
  | { readonly kind: 'stylesheet'; readonly file: string; readonly text: string }
  | { readonly kind: 'rendered'; readonly file: string; readonly route: string; readonly html: string };

export interface CustomAuditOutcome {
  readonly findings: readonly AuditFinding[];
  /** Audits that did not run, and why. */
  readonly problems: readonly { readonly id: string; readonly name: string; readonly problem: CustomAuditProblem }[];
  /** Audits that stopped early at a cap or the time budget: their findings are a part of what is there. */
  readonly stopped: readonly { readonly id: string; readonly name: string }[];
}

/** Elements one file's walk visits looking for `<style>` blocks and the element a markup match is in. */
const NODES_PER_FILE_MAX = 20_000;

export function runCustomAudits(audits: readonly CustomAudit[], sources: readonly CustomAuditSource[], now: () => number): CustomAuditOutcome {
  const findings: AuditFinding[] = [];
  const problems: { id: string; name: string; problem: CustomAuditProblem }[] = [];
  const stopped: { id: string; name: string }[] = [];
  for (const audit of audits) {
    if (!audit.enabled) {
      continue;
    }
    const compiled = compileCustomAudit(audit);
    if (!compiled.ok) {
      problems.push({ id: audit.id, name: audit.name, problem: compiled.error });
      continue;
    }
    const run = auditRun(audit, compiled.value, sources, now);
    findings.push(...run.findings);
    if (run.stopped) {
      stopped.push({ id: audit.id, name: audit.name });
    }
  }
  assert(problems.length + stopped.length <= audits.length * 2, 'runCustomAudits: at most one problem and one stop per audit');
  return { findings, problems, stopped };
}

// One audit over every source: the run's caps and deadline are this audit's own, so a slow audit never starves the others.
function auditRun(
  audit: CustomAudit,
  matcher: CustomMatcher,
  sources: readonly CustomAuditSource[],
  now: () => number,
): { readonly findings: readonly AuditFinding[]; readonly stopped: boolean } {
  const ref: AuditCustomRef = { id: audit.id, name: audit.name, icon: audit.icon, category: audit.category, message: audit.message };
  const deadlineMs = now() + CUSTOM_MATCH_LIMITS.runMsMax;
  const findings: AuditFinding[] = [];
  let stopped = false;
  for (const source of sources) {
    const left = CUSTOM_MATCH_LIMITS.matchesPerRunMax - findings.length;
    if (left <= 0 || now() > deadlineMs) {
      stopped = true;
      break;
    }
    const budget = { matchesMax: Math.min(left, CUSTOM_MATCH_LIMITS.matchesPerFileMax), deadlineMs };
    const found = sourceFindings(source, matcher, { ref, priority: audit.severity, budget }, now);
    findings.push(...found.findings);
    stopped = stopped || found.stopped;
  }
  assert(findings.length <= CUSTOM_MATCH_LIMITS.matchesPerRunMax, 'auditRun: an audit’s findings are capped');
  return { findings, stopped };
}

interface FindingContext {
  readonly ref: AuditCustomRef;
  readonly priority: CustomAudit['severity'];
  readonly budget: { readonly matchesMax: number; readonly deadlineMs: number };
}

function sourceFindings(
  source: CustomAuditSource,
  matcher: CustomMatcher,
  context: FindingContext,
  now: () => number,
): { readonly findings: readonly AuditFinding[]; readonly stopped: boolean } {
  switch (source.kind) {
    case 'stylesheet': {
      if (matcher.scope !== 'declaration' && matcher.scope !== 'css') {
        return { findings: [], stopped: false };
      }
      const scan = scanCustom(source.text, matcher, context.budget, now);
      const findings = scan.matches.map((match) =>
        customFinding(context, { file: source.file, fileKind: 'site', element: undefined }, match, {
          place: { tag: 'stylesheet', offset: match.offset },
          line: match.line,
        }),
      );
      return { findings, stopped: scan.stopped !== 'complete' };
    }
    case 'astro':
      return astroFindings(source, matcher, context, now);
    case 'rendered': {
      if (matcher.scope !== 'rendered') {
        return { findings: [], stopped: false };
      }
      const scan = scanCustom(source.html, matcher, context.budget, now);
      const findings = scan.matches.map((match) =>
        customFinding(context, { file: source.file, fileKind: 'page', element: undefined }, { ...match, text: `${source.route}: ${match.text}` }, undefined),
      );
      return { findings, stopped: scan.stopped !== 'complete' };
    }
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}

// An .astro file: its `<style>` blocks for declaration and css audits (each match placed in its block, for the code window),
// its template for markup audits (each match placed on the innermost element around it, for go-to).
function astroFindings(
  source: Extract<CustomAuditSource, { readonly kind: 'astro' }>,
  matcher: CustomMatcher,
  context: FindingContext,
  now: () => number,
): { readonly findings: readonly AuditFinding[]; readonly stopped: boolean } {
  const lines = lineStarts(source.source);
  const where = { file: source.file, fileKind: source.fileKind };
  if (matcher.scope === 'markup') {
    const scan = scanCustom(markupText(source.source), matcher, context.budget, now);
    const findings = scan.matches.map((match) => {
      const element = elementAt(source.nodes, match.offset);
      return customFinding(context, { ...where, element: element === undefined ? undefined : { ...element, line: match.line } }, match, undefined);
    });
    return { findings, stopped: scan.stopped !== 'complete' };
  }
  if (matcher.scope === 'rendered') {
    return { findings: [], stopped: false };
  }
  const findings: AuditFinding[] = [];
  let stopped = false;
  for (const block of styleBlocks(source.nodes)) {
    const left = context.budget.matchesMax - findings.length;
    if (left <= 0) {
      stopped = true;
      break;
    }
    const scan = scanCustom(block.inner, matcher, { ...context.budget, matchesMax: left }, now);
    const innerStart = block.start === undefined ? -1 : source.source.indexOf(block.inner, block.start);
    for (const match of scan.matches) {
      const line = innerStart === -1 ? undefined : lineOf(lines, innerStart + match.offset);
      findings.push(
        customFinding(context, { ...where, element: { path: block.path, tag: 'style', line } }, match, {
          place: { tag: 'style-block', path: block.path, offset: match.offset },
          line,
        }),
      );
    }
    stopped = stopped || scan.stopped !== 'complete';
  }
  return { findings, stopped };
}

function customFinding(
  context: FindingContext,
  where: Pick<AuditFinding, 'file' | 'fileKind' | 'element'>,
  match: CustomMatch,
  code: { readonly place: NonNullable<NonNullable<AuditFinding['css']>['place']>; readonly line: number | undefined } | undefined,
): AuditFinding {
  const declaration = match.declaration;
  // A declaration row reads `text-align: left` under its selector, as a raw value's does; a text match reads as what matched.
  const css =
    code === undefined
      ? undefined
      : {
          selector: declaration?.selector ?? '',
          property: declaration?.property ?? '',
          value: declaration?.value ?? match.text,
          token: declaration?.value ?? match.text,
          line: code.line,
          group: 'custom',
          place: code.place,
        };
  return auditFinding({
    check: 'custom',
    custom: context.ref,
    ...where,
    detail: declaration === undefined ? match.text : `${declaration.selector} { ${declaration.property}: ${declaration.value} }`,
    source: where.fileKind === 'page' && where.element === undefined && code === undefined ? 'rendered' : 'static',
    fix: undefined,
    priority: context.priority,
    ...(css === undefined ? {} : { css }),
  });
}

/** Every `<style>` block in a tree with its path and, when the parse kept offsets, where it starts. Bounded by NODES_PER_FILE_MAX. */
function styleBlocks(nodes: readonly PageNode[]): readonly { readonly path: readonly number[]; readonly inner: string; readonly start: number | undefined }[] {
  const blocks: { path: readonly number[]; inner: string; start: number | undefined }[] = [];
  const pending: { node: PageNode; path: readonly number[] }[] = nodes.map((node, index) => ({ node, path: [index] })).reverse();
  for (let visited = 0; pending.length > 0 && visited < NODES_PER_FILE_MAX; visited++) {
    const next = pending.pop();
    assert(next !== undefined, 'styleBlocks: the stack holds a node');
    const { node, path } = next;
    if (node.kind === 'raw' && node.name.toLowerCase() === 'style') {
      blocks.push({ path, inner: node.inner, start: node.start });
    }
    pending.push(
      ...nodeChildren(node)
        .map((child, index) => ({ node: child, path: [...path, index] }))
        .reverse(),
    );
  }
  return blocks;
}

/** The innermost element or component whose source range holds `offset`, when the parse kept offsets. */
function elementAt(nodes: readonly PageNode[], offset: number): { readonly path: readonly number[]; readonly tag: string } | undefined {
  assert(offset >= 0, 'elementAt: an offset');
  let found: { path: readonly number[]; tag: string } | undefined;
  let level: readonly { node: PageNode; path: readonly number[] }[] = nodes.map((node, index) => ({ node, path: [index] }));
  // Each pass goes one level deeper into the node that holds the offset; a tree is bounded, and so is this walk.
  for (let depth = 0; level.length > 0 && depth < NODES_PER_FILE_MAX; depth++) {
    const holder = level.find(({ node }) => node.start !== undefined && node.end !== undefined && node.start <= offset && offset < node.end);
    if (holder === undefined) {
      break;
    }
    if (holder.node.kind === 'element' || holder.node.kind === 'component') {
      found = { path: holder.path, tag: holder.node.name };
    }
    level = nodeChildren(holder.node).map((node, index) => ({ node, path: [...holder.path, index] }));
  }
  return found;
}
