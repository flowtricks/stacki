// Reading a selector list: its members, their canonical compounds, and the
// compiled form the matcher walks, cached per selector text; and comparing
// specificity (selectors.ts).

import selectorParser from 'postcss-selector-parser';
import type { SelectorInfo, Specificity } from './styleTypes';
import { assert } from '../../../../shared/core/assert';

export type Combinator = ' ' | '>' | '+' | '~';
export type HasAxis = 'descendant' | 'child' | 'sibling' | 'adjacent';
export type HasCond = { axis: HasAxis; sel: CompiledSelector };

export type AttrCond = {
  name: string;
  operator: string | undefined;
  value: string | undefined;
  insensitive: boolean;
};

export type Compound = {
  universal: boolean;
  tag: string | undefined;
  id: string | undefined;
  classes: string[];
  attrs: AttrCond[];
  /** `:not(...)` arguments, each a compiled selector to negate. */
  negations: CompiledSelector[];
  /** `:is()` / `:where()` groups — element must match ≥1 selector in each group. */
  requireAny: CompiledSelector[][];
  /** `:has(...)` relational conditions — element must satisfy each. */
  hasGroups: HasCond[];
  hasPseudoClass: boolean;
  /** State/structural pseudo-classes on this compound (`:hover`, `:focus`, …), lowercased. */
  pseudoClasses: string[];
  /** Positional pseudos with their raw `An+B` argument, which pseudoClasses drops. */
  positional: PositionalPseudo[];
  pseudoElement: string | undefined;
};

export type PositionalPseudo = { name: string; arg: string | undefined };

export type CompiledSelector = {
  text: string;
  compounds: Compound[];
  /** combinators[i] links compounds[i-1] and compounds[i]; combinators[0] unused. */
  combinators: Combinator[];
  specificity: Specificity;
  hasPseudoClass: boolean;
  pseudoElement: string | undefined;
};

export const emptyCompound = (): Compound => ({
  universal: false,
  tag: undefined,
  id: undefined,
  classes: [],
  attrs: [],
  negations: [],
  requireAny: [],
  hasGroups: [],
  hasPseudoClass: false,
  pseudoClasses: [],
  positional: [],
  pseudoElement: undefined,
});

export function normalizeCombinator(value: string): Combinator {
  const trimmed = value.trim();
  if (trimmed === '>') {
    return '>';
  }
  if (trimmed === '+') {
    return '+';
  }
  if (trimmed === '~') {
    return '~';
  }
  return ' ';
}

export function isPseudoElement(value: string): boolean {
  if (value.startsWith('::')) {
    return true;
  }
  // Legacy single-colon pseudo-elements.
  return /^:(before|after|first-line|first-letter|placeholder|selection|marker|backdrop)$/i.test(value);
}

/** Parse a full selector list (comma-separated) into display + match info. */
export function parseSelectorList(selectorText: string): SelectorInfo[] {
  const compiled = compileSelectorList(selectorText);
  return compiled.map((selector) => ({
    text: selector.text,
    specificity: selector.specificity,
    hasPseudoClass: selector.hasPseudoClass,
    pseudoElement: selector.pseudoElement,
    approximate: false,
  }));
}

export type SelectorListMember = {
  readonly text: string;
  readonly from: number;
  readonly to: number;
};

/** Locate top-level selector-list members without splitting commas in functions,
 *  attributes, or quoted attribute values. Offsets refer to the original text. */
export function selectorListMembers(selectorText: string): readonly SelectorListMember[] {
  const members: SelectorListMember[] = [];
  let bracketDepth = 0;
  let parenthesisDepth = 0;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let start = 0;
  const append = (end: number) => {
    const raw = selectorText.slice(start, end);
    const leadingLength = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text.length === 0) {
      return;
    }
    const from = start + leadingLength;
    members.push({ text, from, to: from + text.length });
  };

  for (let index = 0; index < selectorText.length; index += 1) {
    const character = selectorText[index] ?? '';
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '(') {
      parenthesisDepth += 1;
      continue;
    }
    if (character === ')') {
      parenthesisDepth = Math.max(0, parenthesisDepth - 1);
      continue;
    }
    if (character === '[') {
      bracketDepth += 1;
      continue;
    }
    if (character === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (character === ',' && parenthesisDepth === 0 && bracketDepth === 0) {
      append(index);
      start = index + 1;
    }
  }
  append(selectorText.length);
  return members;
}

/**
 * A single selector's subject compound projected into the element-token namespace
 * (`tag:div` / `class:a` / `attr:data-x`), matching snapshotTokens. `simple` is
 * true only for a lone compound of tag/classes/attrs (no combinator, no id, no
 * `:is()`/`:has()`/`:not()`) — the only shape a token chip can represent, so the
 * resolver treats non-simple selectors as complex/orange-only. `pseudoClasses`
 * carries the subject's state pseudos (`:hover`, …) regardless of `simple`.
 */
export type CanonicalCompound = {
  simple: boolean;
  /** True when the selector is a single compound (no combinator / descendant) — it
   *  may still carry `:is()`/`:not()`/pseudos, unlike `simple`. Distinguishes
   *  `.a:is(:hover,:focus)` (one compound) from `.parent .a` (complex). */
  oneCompound: boolean;
  tokens: string[];
  pseudoClasses: string[];
  /** The pseudo-element the selector targets ('::before'), normalized, or ''. A
   *  pseudo-element styles a generated box, so it's a separate edit target from the
   *  element itself and never `simple` (not chip/native-editable). */
  pseudoElement: string;
  /** True when the selector is a single plain compound (tag/class/attr[/id], plus a
   *  pseudo-class and/or pseudo-element) with NO combinator and NO `:is()`/`:has()`/
   *  `:not()`. Such a selector reads cleanly on its own, so it can be split out of a
   *  grouped rule for an isolated edit (`.a::before` yes; `:not(.x) > :is(...)` no). */
  splittable: boolean;
  /** True when the subject compound is the universal `*` (with no tag/class/attr). */
  universal: boolean;
  /** True when the subject is narrowed by `:is()`, `:not()`, `:has()` or `:global()`,
   *  which leave no token but keep `:is(.a, .b)::after` from being a bare `::after`. */
  functional: boolean;
};

// Pseudo-classes representable as a Webflow class STATE (a chip / native-editable
// combo). Any other pseudo-class — structural (:nth-child, :first-child, :nth-of-type,
// …) or an unsupported state — must keep the compound COMPLEX so its full text is
// preserved (embed-editable) instead of collapsing to the bare class.
export const STATE_PSEUDO_CLASSES = new Set([':hover', ':focus', ':active']);

export function canonicalCompound(selectorText: string): CanonicalCompound {
  const first = compileSelectorList(selectorText)[0];
  const subject = first?.compounds[first.compounds.length - 1];
  if (!first || !subject) {
    return {
      simple: false,
      oneCompound: false,
      tokens: [],
      pseudoClasses: [],
      pseudoElement: '',
      splittable: false,
      universal: false,
      functional: false,
    };
  }

  const pseudoClasses = subject.pseudoClasses;
  const pseudoElement = normalizePseudoElement(first.pseudoElement);
  const oneCompound = first.compounds.length === 1 && first.combinators.length === 0;
  const noFunctionalPseudo = subject.negations.length === 0 && subject.requireAny.length === 0 && subject.hasGroups.length === 0;
  // Only bare state pseudos keep a compound "simple"; a structural pseudo (:nth-child …)
  // isn't a Webflow class state, so it must read as complex to keep its full text.
  const stateOnly = pseudoClasses.every((pseudo) => STATE_PSEUDO_CLASSES.has(pseudo));
  const simple = oneCompound && !pseudoElement && !subject.universal && subject.id === undefined && noFunctionalPseudo && stateOnly;
  // Like `simple`, but a pseudo-element is allowed (it's the whole point of splitting
  // `.a::before`). A bare universal (`::before`) is never splittable — it's hidden.
  const splittable = oneCompound && !subject.universal && noFunctionalPseudo;

  const tokens: string[] = [];
  if (subject.tag) {
    tokens.push(`tag:${subject.tag}`);
  }
  subject.classes.forEach((cls) => tokens.push(`class:${cls}`));
  subject.attrs.forEach((attr) => {
    // Presence `[data-x]` → `attr:data-x` (matches a chip); a valued/operator
    // form `[data-x="y"]` gets a distinct token so it stays orange-only.
    tokens.push(attr.operator && attr.value !== undefined ? `attr:${attr.name}${attr.operator}"${attr.value}"` : `attr:${attr.name}`);
  });
  return {
    simple,
    oneCompound,
    tokens,
    pseudoClasses,
    pseudoElement,
    splittable,
    universal: subject.universal,
    functional: !noFunctionalPseudo,
  };
}

/** True when the selector's subject is qualified by a parent or ancestor. */
export function selectorDependsOnAncestor(selectorText: string): boolean {
  const selectors = compileSelectorList(selectorText);
  return selectors.some((selector) => selector.combinators.some((combinator) => combinator === ' ' || combinator === '>'));
}

/**
 * What a selector is built from, for the well's colour. `class`: a class, id or
 * attribute in any compound, including inside `:is()`, `:where()`, `:not()` and
 * `:has()`; the chip is blue, because it names this element's identity. `plain`:
 * only tags, `*` and pseudos; the chip is grey, because it describes a project-wide
 * group. Text that does not parse falls back to looking for `.`, `#` or `[`.
 */
export type SelectorKind = 'class' | 'plain';

export function selectorKind(text: string): SelectorKind {
  assert(typeof text === 'string', 'selectorKind: the selector is text');
  let root: selectorParser.Root;
  try {
    root = selectorParser().astSync(text);
  } catch {
    return /[.#[]/.test(text) ? 'class' : 'plain';
  }
  let named = false;
  root.walk((node) => {
    if (node.type === 'class' || node.type === 'id' || node.type === 'attribute') {
      named = true;
      return false;
    }
    return undefined;
  });
  const kind: SelectorKind = named ? 'class' : 'plain';
  assert(kind === 'class' || !/^[.#[]/.test(text.trim()), 'selectorKind: a selector led by a class, id or attribute is a class chip');
  return kind;
}

// A selector made only from tags, universal selectors, and pseudos describes a
// project-wide group rather than this element's identity (selectorKind). The well
// colours these chips grey and reads them before the element's classes (wellOrder).
export function isGlobalSelector(text: string): boolean {
  return selectorKind(text) === 'plain';
}

/** Normalize a pseudo-element to its `::name` form (handles legacy `:before`), or ''. */
export function normalizePseudoElement(pseudoElement: string | undefined): string {
  if (!pseudoElement) {
    return '';
  }
  return `::${pseudoElement.replace(/^::?/, '').toLowerCase()}`;
}

/**
 * The box a selector styles, as the navigator lists boxes: the element ('') or
 * one of its ::before and ::after rows. Other pseudo-elements (`::marker`,
 * `::placeholder`) have no row, so they stay with the element.
 */
export type SelectorLayer = '' | '::before' | '::after';

/** The layer of a parsed selector, from the pseudo-element on its subject. */
export function selectorLayerOf(pseudoElement: string | undefined): SelectorLayer {
  const normalized = normalizePseudoElement(pseudoElement);
  return normalized === '::before' || normalized === '::after' ? normalized : '';
}

/** The layer each member of a selector list styles, in list order. */
export function selectorListLayers(selectorText: string): readonly SelectorLayer[] {
  const layers = compileSelectorList(selectorText).map((selector) => selectorLayerOf(selector.pseudoElement));
  assert(layers.length <= selectorText.length + 1, 'selectorListLayers: one layer per member');
  return layers;
}

export const compileCache = new Map<string, CompiledSelector[]>();

export function compileSelectorList(selectorText: string): CompiledSelector[] {
  const cached = compileCache.get(selectorText);
  if (cached) {
    return cached;
  }

  let result: CompiledSelector[] = [];
  try {
    selectorParser((root) => {
      root.each((selector) => {
        if (selector.type !== 'selector') {
          return;
        }
        result.push(compileSelector(selector));
      });
    }).processSync(selectorText);
  } catch {
    // Unparseable selector — yield a never-matching stub so the rule still lists.
    result = [
      {
        text: selectorText.trim(),
        compounds: [],
        combinators: [],
        specificity: [0, 0, 0],
        hasPseudoClass: false,
        pseudoElement: undefined,
      },
    ];
  }

  compileCache.set(selectorText, result);
  return result;
}

export type SelectorNode = selectorParser.Selector;

export function compileSelector(selector: SelectorNode): CompiledSelector {
  const builder = new SelectorBuilder();
  selector.each((node) => {
    builder.add(node);
  });
  return builder.finish(selector.toString().trim());
}

// Accumulates one selector's compounds, combinators and specificity as its nodes are
// visited left to right. `current` is the compound being built; a combinator closes it.
export class SelectorBuilder {
  private readonly compounds: Compound[] = [];
  private readonly combinators: Combinator[] = [];
  private current = emptyCompound();
  private started = false;
  private idCount = 0;
  private classCount = 0;
  private typeCount = 0;
  private hasPseudoClass = false;

  add(node: selectorParser.Node): void {
    switch (node.type) {
      case 'combinator': {
        if (this.started) {
          this.pushCurrent();
          this.combinators.push(normalizeCombinator(node.value));
          this.started = false;
        }
        return;
      }
      case 'tag': {
        this.current.tag = node.value.toLowerCase();
        this.typeCount += 1;
        break;
      }
      case 'universal': {
        this.current.universal = true;
        break;
      }
      case 'id': {
        this.current.id = node.value;
        this.idCount += 1;
        break;
      }
      case 'class': {
        this.current.classes.push(node.value);
        this.classCount += 1;
        break;
      }
      case 'attribute': {
        this.current.attrs.push({
          name: node.attribute.toLowerCase(),
          operator: node.operator,
          value: node.value,
          insensitive: Boolean(node.insensitive),
        });
        this.classCount += 1;
        break;
      }
      case 'pseudo': {
        this.addPseudo(node);
        break;
      }
      case 'string':
      case 'root':
      case 'comment':
      case 'nesting':
      case 'selector':
        return;
      default: {
        const unhandled: never = node;
        return unhandled;
      }
    }
    this.started = true;
  }

  private addPseudo(node: selectorParser.Pseudo): void {
    const value = node.value;
    if (isPseudoElement(value)) {
      this.current.pseudoElement = value;
      this.typeCount += 1;
    } else if (value === ':not') {
      // Negation: compile inner, negate at match time; specificity = the
      // most specific argument (per spec).
      const inner = compileFunctionalArg(node);
      this.current.negations.push(...inner);
      this.addSpecificity(mostSpecific(inner));
    } else if (value === ':global') {
      // Astro's `:global(.button)` is `.button` with the file's scope left off
      // (how a user lets a page's rules reach markup it renders through a
      // component): it matches what its argument matches, at its argument's
      // weight.
      const inner = compileFunctionalArg(node);
      if (inner.length) {
        this.current.requireAny.push(inner);
      }
      this.addSpecificity(mostSpecific(inner));
      // `:global(.a::after)` styles what its argument styles, a generated box included.
      this.current.pseudoElement ??= sharedPseudoElement(inner);
    } else if (value === ':is' || value === ':matches' || value === ':where') {
      // :is()/:where() are static structural matchers, NOT state pseudo-
      // classes — the element must match one of their arguments. :where
      // adds zero specificity; :is/:matches add their most specific arg.
      const inner = compileFunctionalArg(node);
      if (inner.length) {
        this.current.requireAny.push(inner);
      }
      if (value !== ':where') {
        this.addSpecificity(mostSpecific(inner));
      }
    } else if (value === ':has') {
      // Relational: element must have a descendant/sibling matching the arg.
      const conditions = compileHasArg(node);
      this.current.hasGroups.push(...conditions);
      this.addSpecificity(mostSpecific(conditions.map((condition) => condition.sel)));
    } else {
      // A real state/structural pseudo-class (:hover, :focus, :nth-child, …)
      // — mark conditional. Positional ones also keep their An+B argument,
      // which pseudoClasses (names only) can't carry, so the matcher can
      // evaluate them against the tree.
      this.current.hasPseudoClass = true;
      const pseudoName = value.toLowerCase();
      this.current.pseudoClasses.push(pseudoName);
      if (POSITIONAL_PSEUDOS.has(pseudoName)) {
        this.current.positional.push({ name: pseudoName, arg: pseudoArgText(node) });
      }
      this.hasPseudoClass = true;
      this.classCount += 1;
    }
  }

  private addSpecificity(top: Specificity | undefined): void {
    if (top) {
      this.idCount += top[0];
      this.classCount += top[1];
      this.typeCount += top[2];
    }
  }

  private pushCurrent(): void {
    this.compounds.push(this.current);
    this.current = emptyCompound();
  }

  finish(text: string): CompiledSelector {
    if (this.started) {
      this.pushCurrent();
    }
    assert(this.combinators.length <= Math.max(0, this.compounds.length - 1), 'SelectorBuilder: a combinator sits between two compounds');
    return {
      text,
      compounds: this.compounds,
      combinators: this.combinators,
      specificity: [this.idCount, this.classCount, this.typeCount],
      hasPseudoClass: this.hasPseudoClass,
      // Only the subject's: a pseudo-element on any other compound styles nothing here.
      pseudoElement: this.compounds[this.compounds.length - 1]?.pseudoElement,
    };
  }
}

// The pseudo-element every argument styles, or undefined when they do not agree.
function sharedPseudoElement(selectors: readonly CompiledSelector[]): string | undefined {
  const first = selectors[0]?.pseudoElement;
  return selectors.every((selector) => normalizePseudoElement(selector.pseudoElement) === normalizePseudoElement(first)) ? first : undefined;
}

export function compileFunctionalArg(node: selectorParser.Pseudo): CompiledSelector[] {
  const out: CompiledSelector[] = [];
  node.each?.((child) => {
    if (child.type === 'selector') {
      out.push(compileSelector(child));
    }
  });
  return out;
}

export function axisFromCombinator(value: string): HasAxis {
  const trimmed = value.trim();
  if (trimmed === '>') {
    return 'child';
  }
  if (trimmed === '+') {
    return 'adjacent';
  }
  if (trimmed === '~') {
    return 'sibling';
  }
  return 'descendant';
}

/** Compile `:has(...)` args, reading the leading combinator as the relation. */
export function compileHasArg(node: selectorParser.Pseudo): HasCond[] {
  const out: HasCond[] = [];
  node.each?.((child) => {
    if (child.type !== 'selector') {
      return;
    }
    const first = child.nodes[0];
    const axis: HasAxis = first && first.type === 'combinator' ? axisFromCombinator(first.value) : 'descendant';
    // compileSelector ignores a leading combinator, so `sel` is the arg minus it.
    out.push({ axis, sel: compileSelector(child) });
  });
  return out;
}

/** The most specific argument's specificity (for :not / :is / :has). */
export function mostSpecific(selectors: CompiledSelector[]): Specificity | undefined {
  let best: Specificity | undefined;
  for (const selector of selectors) {
    if (!best || compareSpecificity(selector.specificity, best) > 0) {
      best = selector.specificity;
    }
  }
  return best;
}

/**
 * The (a, b, c) specificity of a selector text, by the parser above: `:is()`, `:not()`
 * and `:has()` count their most specific argument, `:where()` counts nothing, and a
 * pseudo-element counts as a type. A list is as specific as its strongest member; text
 * that does not parse counts (0, 0, 0), as its stub rule does.
 */
export function selectorSpecificity(selectorText: string): Specificity {
  const strongest = mostSpecific(compileSelectorList(selectorText)) ?? [0, 0, 0];
  assert(
    strongest.every((count) => Number.isSafeInteger(count)),
    'selectorSpecificity: counts are integers',
  );
  assert(
    strongest.every((count) => count >= 0),
    'selectorSpecificity: counts are never negative',
  );
  return strongest;
}

// Pseudo-classes decided by position among siblings rather than runtime state.
export const POSITIONAL_PSEUDOS = new Set([
  ':first-child',
  ':last-child',
  ':only-child',
  ':nth-child',
  ':nth-last-child',
  ':first-of-type',
  ':last-of-type',
  ':only-of-type',
  ':nth-of-type',
  ':nth-last-of-type',
]);

/** The text between a functional pseudo's parentheses (`2n + 1`), or undefined. */
export function pseudoArgText(node: { toString: () => string }): string | undefined {
  const text = String(node);
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  return open !== -1 && close > open ? text.slice(open + 1, close).trim() : undefined;
}

export function formatSpecificity(spec: Specificity): string {
  return `${spec[0]},${spec[1]},${spec[2]}`;
}

/** Compare specificity: positive when `left` is stronger than `right`. */
export function compareSpecificity(left: Specificity, right: Specificity): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}
