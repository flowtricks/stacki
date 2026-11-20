// The "Move styles" choices of Create component: the classes of the extracted markup that have CSS,
// where that CSS is, and whether anything else uses them.
//
// Every class is offered unchecked: moving rules out of a stylesheet is the person's call. `reach` says who else
// uses a class, on the rest of the page or in another file, so they can see that moving its rules would take
// them from the other uses. Utilities are never offered: a framework's utilities
// have no rule in the project's CSS to move, the project's own sit in a stylesheet it locks
// (movableSheets), and the Style panel's rule (`u-`, defaultSelector.ts) knows Lumos's without any
// setting. Which rules style the markup is the paste rule (pasteStyles.ts): a selector counts when
// every class and id it names is on the markup.

import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';
import { assert } from '../../shared/core/assert';
import { leadingIndent, measuredIndent } from '../../shared/core/indent';
import { LIMITS } from '../../shared/core/limits';
import type { ClassUsageReply } from '../../shared/properties/classUsage';
import { NEW_STYLE_TAG_RULES_TOKEN, templateFrame } from '../../shared/properties/newStyleTag';
import type { EditorNode } from './pageView';
import { subjectOf } from './pasteDependencies';
import { carriedStyles, withoutCarried, type CarriedStyles, type PasteStyleSource, type PasteStyleSubject } from './pasteStyles';
import type { ClassReach, MoveStyleCandidate, StyleHome } from './moveStyleTypes';

export type { ClassReach, MoveStyleCandidate, StyleHome } from './moveStyleTypes';

/** The CSS of one home, as the paste rule reads it. */
export interface StyleHomeSource {
  readonly home: StyleHome;
  readonly styles: readonly PasteStyleSource[];
}

/**
 * The classes of `node` that have rules in `sources`, sorted by name, each with its homes and reach.
 * `outside` holds the classes on the page's other elements; `usage` is main's answer for the other files.
 * A utility (`isUtility`, the Style panel's own rule) is never offered: its rules style every element that
 * carries it, so they stay where they are. A framework's utilities with no rule in the project's CSS
 * (Tailwind generates them, a package ships them) have nothing to move and are never offered either.
 */
export function moveStyleCandidates(
  node: EditorNode,
  sources: readonly StyleHomeSource[],
  outside: ReadonlySet<string>,
  usage: ClassUsageReply,
  isUtility: (name: string) => boolean,
): readonly MoveStyleCandidate[] {
  const subject = subjectOf(node);
  const homes = new Map<string, StyleHome[]>();
  for (const source of sources) {
    for (const name of styledClasses(source.styles, subject)) {
      if (isUtility(name)) {
        continue;
      }
      const list = homes.get(name) ?? [];
      list.push(source.home);
      homes.set(name, list);
    }
  }
  const files = new Map(usage.classes.map((entry) => [entry.name, entry.files]));
  const candidates = [...homes.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([name, where]): MoveStyleCandidate => {
      const reach = reachOf(name, outside, files.get(name));
      return { name, homes: where, reach };
    });
  assert(
    candidates.every((candidate) => subject.classes.has(candidate.name)),
    'moveStyleCandidates: every candidate is a class of the markup',
  );
  assert(
    candidates.every((candidate) => candidate.homes.length > 0),
    'moveStyleCandidates: every candidate has CSS somewhere',
  );
  assert(
    candidates.every((candidate) => !isUtility(candidate.name)),
    'moveStyleCandidates: no utility is offered',
  );
  return candidates;
}

/**
 * The stylesheets whose rules may move. A stylesheet the project locks (.stacki/styles.json, set from the
 * Selectors panel) keeps its rules: a lock says "Stacki leaves this sheet alone", which is how a project
 * marks its utilities or a framework's files whatever their naming convention. The page's own `<style>`
 * tags are never locked. Both the choices and the move read only the sheets this returns.
 */
export function movableSheets<T extends { readonly rel: string }>(sheets: readonly T[], isLocked: (rel: string) => boolean): readonly T[] {
  const movable = sheets.filter((sheet) => !isLocked(sheet.rel));
  assert(movable.length <= sheets.length, 'movableSheets: a filter never adds a sheet');
  assert(
    movable.every((sheet) => !isLocked(sheet.rel)),
    'movableSheets: no locked stylesheet is left',
  );
  return movable;
}

/** One stylesheet the move may edit: its absolute path for the write, its project-relative path, and its text. */
export interface MovableSheet {
  readonly path: string;
  readonly rel: string;
  readonly css: string;
}

/** What moving the chosen classes' CSS writes: the rules for the component's new tag, and each source's new text. */
export interface StyleMovePlan {
  readonly carried: CarriedStyles;
  /** The page's `<style>` tags whose rules change, by node id, with the CSS the plan read and their new CSS. */
  readonly pageStyles: readonly { readonly id: string; readonly before: string; readonly inner: string }[];
  readonly sheets: readonly { readonly path: string; readonly rel: string; readonly before: string; readonly after: string }[];
}

/**
 * The move of the `chosen` classes' rules out of the page's `<style>` tags and `sheets` (the caller leaves out the
 * locked ones, movableSheets) into the new component. A rule moves when every class it names is chosen and every
 * id it names is on the markup (the paste rule), so `.card .u-text` stays when `.u-text` is not chosen. What is
 * carried and what is removed are judged by one rule (pasteStyles.ts), so no rule is lost or written twice.
 */
export function planStyleMove(
  node: EditorNode,
  chosen: ReadonlySet<string>,
  pageStyles: readonly EditorNode[],
  sheets: readonly MovableSheet[],
): StyleMovePlan {
  const subject: PasteStyleSubject = { classes: new Set(chosen), ids: subjectOf(node).ids };
  const pageSources = pageStyles.map((style) => ({ style, source: styleSourceOf(style) }));
  const sources = [
    ...pageSources.map((entry) => entry.source),
    ...sheets.map((sheet): PasteStyleSource => ({ css: sheet.css, scope: 'global', defineVars: undefined })),
  ];
  const carried = chosen.size === 0 ? { rules: [], selectors: [], leftBehind: [], defineVars: undefined } : carriedStyles(sources, subject, []);
  const changedPage = pageSources
    .map(({ style, source }) => ({ id: style.id, before: source.css, inner: chosen.size === 0 ? source.css : withoutCarried(source.css, subject) }))
    .filter((entry) => entry.inner !== entry.before);
  const changedSheets = sheets
    .map((sheet) => ({ path: sheet.path, rel: sheet.rel, before: sheet.css, after: chosen.size === 0 ? sheet.css : withoutCarried(sheet.css, subject) }))
    .filter((sheet) => sheet.after !== sheet.before);
  assert(carried.rules.length > 0 || changedPage.length + changedSheets.length === 0, 'planStyleMove: nothing is removed that is not carried');
  assert(chosen.size > 0 || carried.rules.length === 0, 'planStyleMove: nothing chosen, nothing carried');
  return { carried, pageStyles: changedPage, sheets: changedSheets };
}

/**
 * The moved rules as the component's new tag holds them, the layout the Style panel's Create `<style>` writes
 * (newStyleTagLayout.test.js): each line indented with tabs, at its level in the rule plus `depth` levels for the
 * template's wrapping at-rules (templateRulesDepth). A rule keeps its own nesting whatever its source indented with,
 * two spaces in a stylesheet or a tab inside a page's `<style>`; the tag's own unit replaces the tabs later
 * (styleBlockInner). Only the indentation changes: what a line says is kept byte for byte.
 */
export function tagIndentedRules(rules: readonly string[], depth: number): readonly string[] {
  assert(Number.isSafeInteger(depth), 'tagIndentedRules: the depth is an integer');
  assert(depth >= 0, 'tagIndentedRules: the depth is not negative');
  const indented = rules.map((rule) => {
    const lines = rule.split('\n');
    const { unitWidth } = measuredIndent(lines);
    const levels = lines.map((line) => indentLevels(leadingIndent(line), unitWidth));
    const written = lines.filter((line) => line.trim().length > 0);
    // The rule's own first level: a rule read from inside an indented `<style>` starts one level in.
    const base = Math.min(...levels.filter((_, index) => (lines[index] ?? '').trim().length > 0));
    assert(written.length === 0 || Number.isSafeInteger(base), 'tagIndentedRules: a rule with text has a first level');
    return lines
      .map((line, index) => {
        if (line.trim().length === 0) {
          return '';
        }
        const level = (levels[index] ?? 0) - base + depth;
        return `${'\t'.repeat(level)}${line.slice(leadingIndent(line).length)}`;
      })
      .join('\n');
  });
  assert(indented.length === rules.length, 'tagIndentedRules: one rule out for each rule in');
  return indented;
}

/**
 * The carried rules as the component's tag should hold them, with each `@layer` written once. The paste rule keeps the
 * layer a rule sat in around that rule alone, so rules that came from one `@layer components { … }` arrive each in a
 * copy of it, and the template's own `@layer components` wrapper would wrap them again. Here a rule whose layer is the
 * template's (`templateLayer`) is written bare, since the template supplies that layer; the others are grouped, one
 * `@layer name { … }` per run of rules from the same layer, in their original order. A rule in no layer, or inside an
 * `@media` that is itself outside any layer, is left as it was. Only the wrapper is removed or shared, never a line of
 * a rule's text beyond its indentation, and running it over its own output changes nothing.
 */
export function layeredRules(rules: readonly string[], templateLayer: string | undefined): readonly string[] {
  assert(rules.length <= LIMITS.scanEntriesMax, 'layeredRules: rules within limit');
  const parts = rules.map(layerOfRule);
  const out: string[] = [];
  // The open run of rules from one layer; in an object so the helper below can close it.
  const open: { run: { readonly layer: string; readonly inners: string[] } | undefined } = { run: undefined };
  const closeRun = (): void => {
    if (open.run !== undefined) {
      out.push(`@layer ${open.run.layer} {\n${indent(open.run.inners.join('\n\n'))}\n}`);
      open.run = undefined;
    }
  };
  for (const part of parts) {
    if (part.layer === undefined) {
      closeRun();
      out.push(part.text);
    } else if (part.layer === templateLayer) {
      closeRun();
      out.push(part.text);
    } else if (open.run !== undefined && open.run.layer === part.layer) {
      open.run.inners.push(part.text);
    } else {
      closeRun();
      open.run = { layer: part.layer, inners: [part.text] };
    }
  }
  closeRun();
  assert(
    out.every((text) => text.trim().length > 0),
    'layeredRules: no empty rule is written',
  );
  assert(rules.length === 0 || out.length > 0, 'layeredRules: rules in, rules out');
  return out;
}

// A rule that is one `@layer name { … }` block: the layer's name and what is inside, without the layer's indent.
// Anything else is no layer here, whole.
function layerOfRule(rule: string): { readonly layer: string | undefined; readonly text: string } {
  let root: postcss.Root;
  try {
    root = postcss.parse(rule);
  } catch {
    return { layer: undefined, text: rule };
  }
  const only = root.nodes.length === 1 ? root.nodes[0] : undefined;
  if (only === undefined || only.type !== 'atrule' || only.name.toLowerCase() !== 'layer' || only.nodes === undefined) {
    return { layer: undefined, text: rule };
  }
  const layer = only.params.replace(/\s+/g, ' ').trim();
  if (layer === '' || layer.includes(',')) {
    return { layer: undefined, text: rule };
  }
  const inside = rule
    .slice(rule.indexOf('{') + 1, rule.lastIndexOf('}'))
    .replace(/^\s*\n/, '')
    .replace(/\s+$/, '');
  if (inside.trim() === '') {
    return { layer: undefined, text: rule };
  }
  const text = inside
    .split('\n')
    .map((line) => (line.startsWith('  ') ? line.slice(2) : line))
    .join('\n');
  return { layer, text };
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => (line === '' ? line : `  ${line}`))
    .join('\n');
}

/** The `@layer` the project's new-tag template wraps rules in, or undefined when it has none. */
export function templateLayerOf(content: string): string | undefined {
  const frame = templateFrame(content);
  const wrapper = frame.ok ? frame.frame.wrappers[frame.frame.wrappers.length - 1] : undefined;
  return wrapper !== undefined && wrapper.name === 'layer' ? wrapper.params : undefined;
}

/** How many wrapping at-rules of a new tag's template the rules go inside: as deep as withinTemplate puts them. */
export function templateRulesDepth(content: string): number {
  if (content.trim().length === 0) {
    return 0;
  }
  // At a placeholder, the template's own line carries its indentation.
  if (content.includes(NEW_STYLE_TAG_RULES_TOKEN)) {
    return 0;
  }
  const frame = templateFrame(content);
  const depth = frame.ok ? frame.frame.wrappers.length : 0;
  assert(depth >= 0, 'templateRulesDepth: a depth is not negative');
  assert(depth <= 1, 'templateRulesDepth: without a placeholder, rules go inside one wrapper at most');
  return depth;
}

// A leading indent as levels: a tab is one level, and spaces count by the rule's own step.
function indentLevels(indent: string, unitWidth: number): number {
  assert(unitWidth > 0, 'indentLevels: a step is positive');
  const tabs = indent.split('\t').length - 1;
  const spaces = indent.length - tabs;
  return tabs + Math.floor(spaces / unitWidth);
}

/** The page's `<style>` tags outside `subtreeId`, in source order: a tag inside the markup travels with it. */
export function pageStyleNodes(nodes: readonly EditorNode[], subtreeId: string): readonly EditorNode[] {
  const out: EditorNode[] = [];
  const pending = [...nodes].reverse();
  let visited = 0;
  while (pending.length > 0) {
    visited += 1;
    assert(visited <= LIMITS.treeNodesMax, 'pageStyleNodes: page nodes within limit');
    const next = pending.pop();
    assert(next !== undefined, 'A non-empty list has a last node');
    if (next.id === subtreeId) {
      continue;
    }
    if (next.kind === 'raw' && next.name === 'style') {
      out.push(next);
    }
    pending.push(...[...(next.children ?? [])].reverse());
  }
  assert(
    out.every((style) => style.kind === 'raw'),
    'pageStyleNodes: only style tags',
  );
  return out;
}

// A `<style>` tag as the paste rule reads it.
function styleSourceOf(style: EditorNode): PasteStyleSource {
  assert(style.kind === 'raw', 'styleSourceOf: a style tag is a raw node');
  const defineVars = style.props?.['define:vars'];
  return {
    css: style.inner,
    scope: style.props?.['is:global'] === undefined ? 'scoped' : 'global',
    defineVars: defineVars?.type === 'expr' ? defineVars.value : undefined,
  };
}

/** The classes on the page's elements outside `subtreeId`: a class there is used elsewhere on the page. */
export function classesOutside(nodes: readonly EditorNode[], subtreeId: string): ReadonlySet<string> {
  const classes = new Set<string>();
  const pending = [...nodes];
  let visited = 0;
  let skipped = 0;
  while (pending.length > 0) {
    visited += 1;
    assert(visited <= LIMITS.treeNodesMax, 'classesOutside: page nodes within limit');
    const next = pending.pop();
    assert(next !== undefined, 'A non-empty list has a last node');
    if (next.id === subtreeId) {
      skipped += 1;
      continue;
    }
    for (const name of subjectOf({ ...next, children: [] }).classes) {
      classes.add(name);
    }
    pending.push(...(next.children ?? []));
  }
  assert(skipped <= 1, 'classesOutside: one node has the subtree id');
  return classes;
}

function reachOf(name: string, outside: ReadonlySet<string>, files: readonly string[] | undefined): ClassReach {
  if (outside.has(name)) {
    return { kind: 'page' };
  }
  // A class main was not asked about, or could not answer for, counts as used elsewhere: its CSS stays unless chosen.
  if (files === undefined) {
    return { kind: 'files', files: [] };
  }
  return files.length === 0 ? { kind: 'onlyHere' } : { kind: 'files', files };
}

// The classes named by the selectors of `styles` that style `subject`, by the paste rule.
function styledClasses(styles: readonly PasteStyleSource[], subject: PasteStyleSubject): ReadonlySet<string> {
  const names = new Set<string>();
  for (const selector of carriedStyles(styles, subject, []).selectors) {
    for (const name of selectorClasses(selector)) {
      names.add(name);
    }
  }
  return names;
}

function selectorClasses(selector: string): readonly string[] {
  const names: string[] = [];
  try {
    selectorParser((root) => {
      root.walkClasses((part) => {
        names.push(part.value);
      });
    }).processSync(selector);
  } catch {
    return []; // A selector carriedStyles kept has parsed once already; one that does not is not guessed at.
  }
  return names;
}
