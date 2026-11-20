// The style rules a pasted piece of markup takes with it to another file.
//
// A component's `<style>` styles that component's own elements. Copy `.stat_wrap` out of it
// and into a page, and the copy arrives bare: the page has no rule for `.stat_wrap`, its
// `::before`, or `.stat_contain` inside it. This file picks the rules that style the copy
// and returns them as new CSS for the target file, to be written into a NEW style tag shaped
// by the project's `newStyleTag` setting. No rule the person already wrote is edited, moved
// or reworded (memory: never rewrite user CSS); a rule the target already holds, word for
// word, is not written twice.
//
// Which rules come along is a rule about names, not a cascade: a selector comes along when
// every class and id it names is on an element of the copy, and it names at least one. A
// selector of bare tags (`h2`, `p + p`) is left behind: in a scoped tag it meant "this
// component's h2", and written into the page it would restyle every h2 there. It is listed,
// so the summary can say what stayed. Each member of a selector list is judged alone, and
// only the members that style the copy are written, so `.stat_wrap, .footer` does not bring
// `.footer` along.
//
// At-rules around a rule (`@media`, `@layer`, `@supports`, `@container`) come with it, and
// `@keyframes` an animation of a carried rule names come too. A `define:vars` on the source
// tag goes onto the new tag when a carried rule reads one of its variables.

import postcss, { type AtRule, type ChildNode, type Rule } from 'postcss';
import selectorParser from 'postcss-selector-parser';
import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';

/** One `<style>` of the file the markup was copied from. */
export interface PasteStyleSource {
  /** The tag's CSS, as written. */
  readonly css: string;
  readonly scope: 'global' | 'scoped';
  /** The `define:vars` expression on the tag, when it has one: `{ accent, size }`. */
  readonly defineVars: string | undefined;
}

/** What the copied markup is made of, as far as selectors can see it. */
export interface PasteStyleSubject {
  readonly classes: ReadonlySet<string>;
  readonly ids: ReadonlySet<string>;
}

export interface CarriedStyles {
  /** New CSS for the target, one top-level block per entry, in source order. */
  readonly rules: readonly string[];
  /** The selectors that came along, for the summary. */
  readonly selectors: readonly string[];
  /** Selectors that would style the copy but were left behind, because they name only tags. */
  readonly leftBehind: readonly string[];
  /** `define:vars` for the new tag, when a carried rule reads one of its variables. */
  readonly defineVars: string | undefined;
}

export const PASTE_STYLE_LIMITS = {
  /** Rules read per source tag; a stylesheet is far smaller in practice. */
  rulesPerSourceMax: 20_000,
  /** At-rules a carried rule may sit inside. */
  chainDepthMax: 16,
} as const satisfies Record<string, number>;

const WRAPPING_AT_RULES: ReadonlySet<string> = new Set(['media', 'layer', 'supports', 'container', 'scope']);

/** The rules of `sources` that style `subject`, minus those `target` already holds. */
export function carriedStyles(sources: readonly PasteStyleSource[], subject: PasteStyleSubject, target: readonly string[]): CarriedStyles {
  const held = new Set(target.flatMap((css) => blocksOf(css).map(normalized)));
  const rules: string[] = [];
  const selectors: string[] = [];
  const leftBehind: string[] = [];
  const animations = new Set<string>();
  const variables = new Set<string>();
  let defineVars: string | undefined = undefined;
  for (const source of sources) {
    const root = parsed(source.css);
    if (root === undefined) {
      continue; // CSS that does not parse is the person's to fix; nothing is guessed from it.
    }
    const before = rules.length;
    let visited = 0;
    root.walkRules((rule) => {
      visited += 1;
      assert(visited <= PASTE_STYLE_LIMITS.rulesPerSourceMax, 'carriedStyles: rules per source within limit');
      if (insideKeyframes(rule)) {
        return;
      }
      const judged = judgedSelectors(rule.selector, subject);
      leftBehind.push(...judged.tagOnly);
      if (judged.kept.length === 0) {
        return;
      }
      const block = wrappedIn(rule, `${judged.kept.join(', ')} {${declarationsOf(rule)}}`);
      if (held.has(normalized(block))) {
        return;
      }
      held.add(normalized(block));
      rules.push(block);
      selectors.push(...judged.kept);
      rule.walkDecls((declaration) => {
        collectAnimationNames(declaration.prop, declaration.value, animations);
        collectVariables(declaration.value, variables);
      });
    });
    rules.push(...keyframesFor(root, animations, held));
    if (rules.length > before && source.defineVars !== undefined && readsDefinedVariable(source.defineVars, variables)) {
      defineVars = source.defineVars;
    }
  }
  assert(selectors.length >= rules.length - animations.size, 'Every carried style rule names a selector');
  return { rules, selectors: [...new Set(selectors)], leftBehind: [...new Set(leftBehind)], defineVars };
}

/**
 * `css` without what `carriedStyles` would carry from it for `subject`: the move's other half (Create component's
 * "Move styles"), judged by the same rule so the two can never disagree. A selector list loses only its members
 * that style the subject (`.card, .footer` keeps `.footer`); a rule left with none goes, and so does a wrapping
 * at-rule left empty. Keyframes stay: another rule may still name them. CSS that does not parse is returned as it
 * was, as carriedStyles carries nothing from it.
 */
export function withoutCarried(css: string, subject: PasteStyleSubject): string {
  const root = parsed(css);
  if (root === undefined) {
    return css;
  }
  // Collected first and changed after the walk, so the walk never visits a tree it is cutting.
  const changes: { readonly rule: Rule; readonly rest: readonly string[] }[] = [];
  root.walkRules((rule) => {
    assert(changes.length < PASTE_STYLE_LIMITS.rulesPerSourceMax, 'withoutCarried: rules per source within limit');
    if (insideKeyframes(rule)) {
      return;
    }
    const kept = new Set(judgedSelectors(rule.selector, subject).kept);
    if (kept.size > 0) {
      changes.push({ rule, rest: rule.selectors.filter((selector) => !kept.has(selector.trim())) });
    }
  });
  if (changes.length === 0) {
    return css;
  }
  for (const { rule, rest } of changes) {
    if (rest.length > 0) {
      rule.selectors = [...rest];
    } else {
      removeWithEmptyWrappers(rule);
    }
  }
  const out = root.toString();
  assert(out !== css, 'withoutCarried: a carried rule changes the text');
  return out;
}

// Removes `rule`, then each wrapping at-rule it leaves with nothing but comments, climbing at most chainDepthMax.
function removeWithEmptyWrappers(rule: Rule): void {
  let parent: unknown = rule.parent;
  removeKeepingGap(rule);
  for (let depth = 0; depth < PASTE_STYLE_LIMITS.chainDepthMax; depth++) {
    if (!isAtRule(parent) || !WRAPPING_AT_RULES.has(parent.name.toLowerCase())) {
      return;
    }
    if (parent.nodes?.some((node) => node.type !== 'comment') === true) {
      return;
    }
    const next: unknown = parent.parent;
    removeKeepingGap(parent);
    parent = next;
  }
}

// Removes a node without leaving its gap behind: the node after the first of its container takes the first's spacing,
// so a blank line that separated them does not become a leading blank line, and the rest stay as they were.
function removeKeepingGap(node: ChildNode): void {
  const container = node.parent;
  const first = container?.first === node;
  const following = node.next();
  const before = node.raws.before;
  node.remove();
  if (first && following !== undefined && before !== undefined) {
    following.raws.before = before;
  }
}

/** The classes and ids of a copied subtree's static attributes and `class:list` strings. */
export function styleSubjectOf(classValues: readonly string[], idValues: readonly string[]): PasteStyleSubject {
  const classes = new Set<string>();
  for (const value of classValues) {
    for (const token of value.split(/\s+/)) {
      if (/^-?[_a-zA-Z][\w-]*$/.test(token)) {
        classes.add(token);
      }
    }
  }
  const ids = new Set(idValues.map((value) => value.trim()).filter((value) => /^-?[_a-zA-Z][\w-]*$/.test(value)));
  return { classes, ids };
}

/** Top-level blocks of `css`, as text: what dedupe compares. */
function blocksOf(css: string): readonly string[] {
  const root = parsed(css);
  if (root === undefined) {
    return [];
  }
  const out: string[] = [];
  root.walkRules((rule) => {
    out.push(wrappedIn(rule, `${rule.selector} {${declarationsOf(rule)}}`));
  });
  return out;
}

function parsed(css: string): postcss.Root | undefined {
  try {
    return postcss.parse(css);
  } catch {
    return undefined; // A syntax error in the person's CSS is input, not a broken invariant.
  }
}

function insideKeyframes(rule: Rule): boolean {
  let parent: unknown = rule.parent;
  // Only a rule or an at-rule has a parent worth climbing to; the root (or a document) ends the chain.
  for (let depth = 0; depth < PASTE_STYLE_LIMITS.chainDepthMax; depth++) {
    if (isAtRule(parent)) {
      if (/keyframes$/i.test(parent.name)) {
        return true;
      }
      parent = parent.parent;
    } else if (isRule(parent)) {
      parent = parent.parent;
    } else {
      return false;
    }
  }
  return false;
}

interface Judged {
  readonly kept: readonly string[];
  readonly tagOnly: readonly string[];
}

// Each member of the list alone: kept when every class and id it names is on the copy and it
// names one at least; noted when it would match by tags alone.
function judgedSelectors(selectorText: string, subject: PasteStyleSubject): Judged {
  const kept: string[] = [];
  const tagOnly: string[] = [];
  try {
    selectorParser((selectors) => {
      selectors.each((selector) => {
        let classes = 0;
        let missing = 0;
        let tags = 0;
        selector.walk((part) => {
          if (part.type === 'class') {
            classes += 1;
            missing += subject.classes.has(part.value) ? 0 : 1;
          } else if (part.type === 'id') {
            classes += 1;
            missing += subject.ids.has(part.value) ? 0 : 1;
          } else if (part.type === 'tag') {
            tags += 1;
          }
        });
        const text = selector.toString().trim();
        if (classes > 0) {
          if (missing === 0) {
            kept.push(text);
          }
        } else if (tags > 0) {
          tagOnly.push(text);
        }
      });
    }).processSync(selectorText);
  } catch {
    return { kept: [], tagOnly: [] }; // An unreadable selector is not guessed at.
  }
  return { kept, tagOnly };
}

function declarationsOf(rule: Rule): string {
  const body = rule.nodes.map((node) => node.toString().trim()).filter((text) => text !== '');
  return body.length === 0 ? ' ' : `\n  ${body.join(';\n  ')};\n`;
}

// The rule inside the at-rules it sat in, outermost first.
function wrappedIn(rule: Rule, block: string): string {
  let text = block;
  let parent: unknown = rule.parent;
  // Climbs at-rules and rules only; the root (or a document) ends the chain.
  for (let depth = 0; depth <= PASTE_STYLE_LIMITS.chainDepthMax; depth++) {
    assert(depth < PASTE_STYLE_LIMITS.chainDepthMax, 'wrappedIn: at-rule nesting within limit');
    if (isAtRule(parent)) {
      if (WRAPPING_AT_RULES.has(parent.name.toLowerCase())) {
        text = `@${parent.name} ${parent.params} {\n${indent(text)}\n}`;
      }
      parent = parent.parent;
    } else if (isRule(parent)) {
      // A nested rule's parent selector is part of what it means.
      text = `${parent.selector} {\n${indent(text)}\n}`;
      parent = parent.parent;
    } else {
      return text;
    }
  }
  return text;
}

function isAtRule(node: unknown): node is AtRule {
  return node instanceof postcss.AtRule;
}

function isRule(node: unknown): node is Rule {
  return node instanceof postcss.Rule;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => (line === '' ? line : `  ${line}`))
    .join('\n');
}

function normalized(block: string): string {
  return block
    .replace(/\s+/g, ' ')
    .replace(/\s*([{};:,])\s*/g, '$1')
    .trim();
}

function collectAnimationNames(property: string, value: string, into: Set<string>): void {
  if (property === 'animation-name' || property === 'animation') {
    for (const token of value.split(/[\s,]+/)) {
      if (/^-?[_a-zA-Z][\w-]*$/.test(token)) {
        into.add(token);
      }
    }
  }
}

function collectVariables(value: string, into: Set<string>): void {
  const pattern = /var\(\s*--([\w-]+)/g;
  for (let match = pattern.exec(value), count = 0; match !== null; match = pattern.exec(value), count++) {
    assert(count <= LIMITS.scanEntriesMax, 'collectVariables: matches within limit');
    const name = match[1];
    if (name !== undefined) {
      into.add(name);
    }
  }
}

function keyframesFor(root: postcss.Root, animations: ReadonlySet<string>, held: Set<string>): readonly string[] {
  const out: string[] = [];
  root.each((node: ChildNode) => {
    if (node.type === 'atrule' && /keyframes$/i.test(node.name) && animations.has(node.params.trim())) {
      const text = node.toString().trim();
      if (!held.has(normalized(text))) {
        held.add(normalized(text));
        out.push(text);
      }
    }
  });
  return out;
}

// `define:vars={{ accent, size: big }}` defines `--accent` and `--size`.
function readsDefinedVariable(defineVars: string, used: ReadonlySet<string>): boolean {
  const keys = [...defineVars.matchAll(/(?:^|[{,])\s*([A-Za-z_$][\w$]*)\s*(?=[:,}])/g)].map((match) => match[1]);
  return keys.some((key) => key !== undefined && used.has(key));
}
