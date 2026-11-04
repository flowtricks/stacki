// Keeping a page's styles on markup that became a component on that page
// (useCreateComponent, appNodeEdits.ts).
//
// A page's `<style>` is scoped: Astro gives every element the page writes the
// page's `data-astro-cid-…` attribute and adds it to every compound of every
// selector in the block. Markup moved into a component carries the
// component's attribute instead, so the page's rules stopped matching it: an
// `<a class="button">` styled by the page's `.button` became a plain link.
// The page's CSS is the page's, and keeps reaching the markup wherever it
// now lives; nothing is moved or copied into the component.
//
// Each selector that matched the moved markup gains a second member in its
// own list, the same selector with the compounds the moved markup matched
// written `:global(…)`:
//
//   .button { & > span { … } }  →  .button, :global(.button) { & > span, & > :global(span) { … } }
//   .hero .note                 →  .hero .note, .hero :global(.note)
//
// Why not `is:global` on the whole block: Astro's default scope strategy is
// an attribute, worth one class of specificity per compound, so unscoping
// the block changes which rule wins wherever two of its rules (or one of them
// and a stylesheet) meet with different compound counts — `.a .b` beat
// `.b.c` scoped and ties with it unscoped. Keeping the scoped member keeps
// every element still on the page matched at exactly the specificity it had:
// a rule's specificity for an element is its most specific matching member.
// A compound led by `&` is left as written: Astro does not scope it (the
// parent's members carry the scope), so `&:hover > span` needs only its span.
//
// The limits, said once: the unscoped member is one class lighter per
// wrapped compound for the moved markup, which only matters against another
// rule of exactly that weight in between; and it also reaches an element of
// the same class inside another component rendered on this page.
//
// Matching reads the page model, not the rendered page, and errs on the safe
// side: what it cannot know (a class from an expression, a positional
// pseudo-class, `:has()`) counts as a possible match, which at worst adds a
// member that matches nothing new. What it cannot see — markup from
// `set:html`, a selector whose subject stays on the page but whose chain
// passes through the moved markup (`.button + .button`), `define:vars` — is
// left as it was.

import postcss, { type AtRule, type ChildNode, type Container, type Root, type Rule } from 'postcss';
import selectorParser from 'postcss-selector-parser';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import type { Attr } from '../../../shared/page/pageNode';
import type { EditorModel, EditorNode } from '../../editor/pageView';
import { compileSelectorList, emptyCompound, selectorListMembers, type Combinator, type Compound } from '../../features/style/model/selectorParse';

export const COMPONENT_STYLE_LIMITS = {
  /** Elements the page model can hold. */
  elementsMax: LIMITS.treeNodesMax,
  /** Selectors one block resolves to, nesting expanded: past it the block is left alone. */
  selectorsMax: 20_000,
  /** Compounds in one selector, as the style panel's matcher allows. */
  compoundsMax: 256,
} as const satisfies Record<string, number>;

/** A page `<style>` block whose text changes: its rules opened to the moved markup. */
export interface StyleBlockChange {
  readonly nodeId: string;
  /** The block's text the change was worked out from; the change applies to that text only. */
  readonly before: string;
  readonly css: string;
}

export interface ComponentStyles {
  readonly pageBlocks: readonly StyleBlockChange[];
  /** Selectors that gained a `:global()` member. */
  readonly openedCount: number;
}

/** The page's `<style>` blocks rewritten so their rules still reach `nodeId`
 *  and its descendants once that markup is a component on this page. Pure:
 *  the model is read, never changed. */
export function componentStyles(model: EditorModel, nodeId: string): ComponentStyles {
  const tree = styledElements(model.nodes, nodeId);
  assert(tree.elements.length <= COMPONENT_STYLE_LIMITS.elementsMax, 'componentStyles: the element count is bounded by the tree');
  const pageBlocks: StyleBlockChange[] = [];
  if (!tree.elements.some((element) => element.moved)) {
    return { pageBlocks, openedCount: 0 };
  }
  let openedCount = 0;
  for (const block of tree.blocks) {
    const opened = openedBlock(block, tree.elements);
    if (opened !== undefined) {
      assert(opened.count > 0, 'componentStyles: a changed block opened a selector');
      assert(opened.css !== block.css, 'componentStyles: a changed block changed');
      pageBlocks.push({ nodeId: block.nodeId, before: block.css, css: opened.css });
      openedCount += opened.count;
    }
  }
  return { pageBlocks, openedCount };
}

// ───────────────────────────── One block ─────────────────────────────

// The block's new text and how many selectors it opened; undefined when
// nothing in it styled the moved markup, or it can't be read (a syntax error,
// more selectors than the bound) and is left exactly as it is.
function openedBlock(block: StyleBlock, elements: readonly StyledElement[]): { readonly css: string; readonly count: number } | undefined {
  let root: Root;
  try {
    root = postcss.parse(block.css);
  } catch {
    return undefined;
  }
  const facts = new Map<ChildNode, RuleFacts>();
  if (annotated(root, undefined, { elements, facts, used: 0 }, 0) === undefined) {
    return undefined;
  }
  const count = opened(root, undefined, facts, 0);
  return count === 0 ? undefined : { css: root.toString(), count };
}

interface RuleFacts {
  /** Per resolved selector whose subject is moved markup: the counts of leading compounds matched on the page. */
  readonly moved: ReadonlyMap<string, ReadonlySet<number>>;
}

interface Annotation {
  readonly elements: readonly StyledElement[];
  readonly facts: Map<ChildNode, RuleFacts>;
  /** Selectors resolved so far in this block. */
  readonly used: number;
}

// Facts for every rule: which of its resolved selectors reach moved markup.
// Returns the selectors resolved so far, or undefined past the bound.
function annotated(container: Container, parents: readonly string[] | undefined, annotation: Annotation, depth: number): number | undefined {
  assert(depth <= LIMITS.treeDepthMax, 'componentStyles: CSS nesting is bounded');
  let used = annotation.used;
  for (const child of container.nodes ?? []) {
    let inner: readonly string[] | undefined = parents;
    if (child.type === 'rule') {
      inner = resolvedSelectors(child.selector, parents);
      used += inner.length;
      if (used > COMPONENT_STYLE_LIMITS.selectorsMax) {
        return undefined;
      }
      annotation.facts.set(child, ruleFacts(inner, annotation.elements));
    } else if (!isStyleContainer(child)) {
      continue;
    }
    const after = annotated(child, inner, { ...annotation, used }, depth + 1);
    if (after === undefined) {
      return undefined;
    }
    used = after;
  }
  return used;
}

function resolvedSelectors(selector: string, parents: readonly string[] | undefined): readonly string[] {
  return parents === undefined ? selectorListMembers(selector).map((member) => member.text) : nestedSelectors(selector, parents);
}

function ruleFacts(selectors: readonly string[], elements: readonly StyledElement[]): RuleFacts {
  const moved = new Map<string, ReadonlySet<number>>();
  for (const text of selectors) {
    const complex = complexSelector(text);
    if (complex === undefined) {
      continue; // Unreadable: it matches nothing we can see, and stays as it is.
    }
    const subject = complex.compounds[complex.compounds.length - 1];
    assert(subject !== undefined, 'ruleFacts: a complex selector has a subject');
    if (subject.pseudoClasses.includes(':global')) {
      continue; // Already unscoped: the move changes nothing for it.
    }
    const splits = new Set<number>();
    const matcher = new ChainMatcher(complex, elements);
    for (let index = 0; index < elements.length; index++) {
      const element = elements[index];
      assert(element !== undefined, 'ruleFacts: the index is inside the list');
      if (element.moved) {
        for (const split of matcher.splits(complex.compounds.length - 1, index)) {
          splits.add(split);
        }
      }
    }
    if (splits.size > 0) {
      moved.set(text, splits);
    }
  }
  return { moved };
}

// Adds the `:global()` members, walking the tree the facts were read from.
// Returns how many members it added.
function opened(container: Container, parents: readonly string[] | undefined, facts: ReadonlyMap<ChildNode, RuleFacts>, depth: number): number {
  assert(depth <= LIMITS.treeDepthMax, 'opened: CSS nesting is bounded');
  let count = 0;
  for (const child of container.nodes ?? []) {
    let inner = parents;
    if (child.type === 'rule') {
      // The parents are the selectors as written before any member was added:
      // the facts are keyed by those.
      inner = resolvedSelectors(child.selector, parents);
      const own = facts.get(child);
      assert(own !== undefined, 'opened: every rule was annotated');
      const added = own.moved.size === 0 ? [] : openedMembers(child.selector, parents, own);
      count += opened(child, inner, facts, depth + 1);
      if (added.length > 0) {
        child.selector = `${child.selector}, ${added.join(', ')}`;
        count += added.length;
      }
    } else if (isStyleContainer(child)) {
      count += opened(child, inner, facts, depth + 1);
    }
  }
  return count;
}

// The members a rule's list gains: each written member that reached moved
// markup, with the compounds the moved markup matched in `:global()`.
function openedMembers(selector: string, parents: readonly string[] | undefined, facts: RuleFacts): readonly string[] {
  const written = selectorListMembers(selector).map((member) => member.text);
  const added: string[] = [];
  for (const member of written) {
    const own = complexSelector(member);
    if (own === undefined) {
      continue;
    }
    for (const parent of parents ?? [undefined]) {
      const resolved = parent === undefined ? member : nestedSelectors(member, [parent])[0];
      const splits = resolved === undefined ? undefined : facts.moved.get(resolved);
      const whole = resolved === undefined ? undefined : complexSelector(resolved);
      if (splits === undefined || whole === undefined) {
        continue;
      }
      // The written member's compounds are the resolved selector's last ones
      // (the first may be `&` merged with the parent's subject). A member with
      // `&` anywhere but its start resolves another way, and is left alone.
      const offset = whole.compounds.length - own.compounds.length;
      if (offset < 0) {
        continue;
      }
      if (member.includes('&') && !member.startsWith('&')) {
        continue;
      }
      for (const split of splits) {
        const variant = globalMember(own, Math.max(0, split - offset));
        if (variant !== member && !written.includes(variant) && !added.includes(variant)) {
          added.push(variant);
        }
      }
    }
  }
  return added;
}

// `.hero .note` with its compounds from `first` on in `:global()`: `.hero :global(.note)`.
function globalMember(complex: ComplexSelector, first: number): string {
  assert(first >= 0, 'globalMember: the first wrapped compound is inside the selector');
  let out = '';
  for (let index = 0; index < complex.texts.length; index++) {
    const piece = complex.texts[index] ?? '';
    const written = index >= first && !piece.startsWith('&') ? `:global(${piece})` : piece;
    if (index === 0) {
      out = written;
    } else {
      const combinator = complex.combinators[index - 1] ?? ' ';
      out += combinator === ' ' ? ` ${written}` : ` ${combinator} ${written}`;
    }
  }
  return out;
}

// ───────────────────────────── Selectors ─────────────────────────────

interface ComplexSelector {
  /** Each compound's own text, for writing it back. */
  readonly texts: readonly string[];
  readonly compounds: readonly Compound[];
  /** combinators[i] sits between compounds[i] and compounds[i + 1]. */
  readonly combinators: readonly Combinator[];
}

// One resolved selector, cut into compounds the matcher reads and texts the
// writer reuses. Undefined for one that can't be parsed, or one longer than the bound.
function complexSelector(text: string): ComplexSelector | undefined {
  const texts: string[] = [];
  const combinators: Combinator[] = [];
  try {
    selectorParser((root) => {
      const first = root.first;
      let current = '';
      for (const node of first.nodes) {
        if (node.type === 'combinator') {
          if (current.trim().length > 0) {
            texts.push(current.trim());
            combinators.push(combinatorOf(node.value));
          }
          current = '';
        } else if (node.type !== 'comment') {
          current += node.toString();
        }
      }
      if (current.trim().length > 0) {
        texts.push(current.trim());
      }
    }).processSync(text);
  } catch {
    return undefined;
  }
  if (texts.length === 0) {
    return undefined;
  }
  if (texts.length > COMPONENT_STYLE_LIMITS.compoundsMax) {
    return undefined;
  }
  if (combinators.length !== texts.length - 1) {
    return undefined; // A trailing combinator: not a selector a browser reads either.
  }
  const compounds: Compound[] = [];
  for (const piece of texts) {
    // A bare `&` (a written nested member) is a compound with nothing of its own.
    const compound = piece === '&' ? emptyCompound() : compileSelectorList(piece)[0]?.compounds[0];
    if (compound === undefined) {
      return undefined;
    }
    compounds.push(compound);
  }
  return { texts, compounds, combinators };
}

function combinatorOf(value: string): Combinator {
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

// CSS nesting resolved by substitution: `&` is the parent, and a selector
// without one is a descendant of it (`> span` → `.button > span`).
function nestedSelectors(selector: string, parents: readonly string[]): string[] {
  const out: string[] = [];
  for (const parent of parents) {
    for (const member of selectorListMembers(selector)) {
      out.push(member.text.includes('&') ? member.text.replaceAll('&', parent) : `${parent} ${member.text}`);
    }
  }
  return out;
}

// ───────────────────────────── Matching ─────────────────────────────

type Possibility = 'yes' | 'maybe' | 'no';

const better = (left: Possibility, right: Possibility): Possibility => {
  if (left === 'yes' || right === 'yes') {
    return 'yes';
  }
  if (left === 'maybe' || right === 'maybe') {
    return 'maybe';
  }
  return 'no';
};
const worse = (left: Possibility, right: Possibility): Possibility => {
  if (left === 'no' || right === 'no') {
    return 'no';
  }
  if (left === 'maybe' || right === 'maybe') {
    return 'maybe';
  }
  return 'yes';
};

interface SelectorChain {
  readonly compounds: readonly Compound[];
  readonly combinators: readonly Combinator[];
}

// One selector matched right to left against the element list. `chain` says
// whether some chain of elements satisfies it; `splits` how many of the
// leading compounds that chain found on the page, for a subject that moved.
// Leaving the moved subtree only ever goes further out (parents, earlier
// siblings), so a chain's page part is always a prefix of the selector.
class ChainMatcher {
  readonly #selector: SelectorChain;
  readonly #elements: readonly StyledElement[];
  readonly #chains = new Map<string, Possibility>();
  readonly #splits = new Map<string, ReadonlySet<number>>();

  constructor(selector: SelectorChain, elements: readonly StyledElement[]) {
    assert(selector.compounds.length > 0, 'ChainMatcher: a selector has a compound');
    assert(selector.compounds.length <= COMPONENT_STYLE_LIMITS.compoundsMax, 'ChainMatcher: the selector is bounded');
    this.#selector = selector;
    this.#elements = elements;
  }

  chain(index: number, elementIndex: number): Possibility {
    // Each step anchors one compound further left.
    const depth = this.#selector.compounds.length - 1 - index;
    assert(depth <= COMPONENT_STYLE_LIMITS.compoundsMax, 'ChainMatcher.chain: the chain is bounded');
    const key = `${index}:${elementIndex}`;
    const known = this.#chains.get(key);
    if (known !== undefined) {
      return known;
    }
    const own = this.#compound(index, elementIndex);
    let result: Possibility = own;
    if (own !== 'no' && index > 0) {
      let left: Possibility = 'no';
      for (const candidate of this.#candidates(index, elementIndex)) {
        left = better(left, this.chain(index - 1, candidate));
        if (left === 'yes') {
          break;
        }
      }
      result = worse(own, left);
    }
    this.#chains.set(key, result);
    return result;
  }

  splits(index: number, elementIndex: number): ReadonlySet<number> {
    const depth = this.#selector.compounds.length - 1 - index;
    assert(depth <= COMPONENT_STYLE_LIMITS.compoundsMax, 'ChainMatcher.splits: the chain is bounded');
    const key = `${index}:${elementIndex}`;
    const known = this.#splits.get(key);
    if (known !== undefined) {
      return known;
    }
    const element = this.#elements[elementIndex];
    assert(element !== undefined, 'ChainMatcher.splits: the element exists');
    const out = new Set<number>();
    if (element.moved) {
      if (this.#compound(index, elementIndex) !== 'no') {
        if (index === 0) {
          out.add(0);
        } else {
          for (const candidate of this.#candidates(index, elementIndex)) {
            for (const split of this.splits(index - 1, candidate)) {
              out.add(split);
            }
          }
        }
      }
    } else if (this.chain(index, elementIndex) !== 'no') {
      out.add(index + 1);
    }
    this.#splits.set(key, out);
    return out;
  }

  #compound(index: number, elementIndex: number): Possibility {
    const compound = this.#selector.compounds[index];
    const element = this.#elements[elementIndex];
    assert(compound !== undefined, 'ChainMatcher: the compound exists');
    assert(element !== undefined, 'ChainMatcher: the element exists');
    return compoundMatch(compound, element, this.#elements, elementIndex);
  }

  // The elements the compound left of `index` may sit on, by its combinator.
  #candidates(index: number, elementIndex: number): readonly number[] {
    const combinator = this.#selector.combinators[index - 1];
    assert(combinator !== undefined, 'ChainMatcher: compounds are joined by combinators');
    return relatives(this.#elements, elementIndex, combinator);
  }
}

function relatives(elements: readonly StyledElement[], elementIndex: number, combinator: Combinator): readonly number[] {
  const element = elements[elementIndex];
  assert(element !== undefined, 'relatives: the element exists');
  const out: number[] = [];
  const step = combinator === '>' || combinator === ' ' ? 'parent' : 'previous';
  let next = step === 'parent' ? element.parent : element.previous;
  // Ancestors are bounded by the tree's depth, earlier siblings by its size.
  for (let guard = 0; next !== undefined && guard <= elements.length; guard++) {
    out.push(next);
    if (combinator === '>' || combinator === '+') {
      break;
    }
    const current: StyledElement | undefined = elements[next];
    assert(current !== undefined, 'relatives: a relative exists');
    next = step === 'parent' ? current.parent : current.previous;
  }
  return out;
}

function compoundMatch(compound: Compound, element: StyledElement, elements: readonly StyledElement[], elementIndex: number): Possibility {
  if (element.instance) {
    return 'no'; // A component's elements carry its own scope, never the page's.
  }
  let result: Possibility = 'yes';
  if (compound.tag !== undefined && compound.tag !== '*') {
    if (element.tag === undefined) {
      result = worse(result, 'maybe');
    } else if (element.tag !== compound.tag) {
      return 'no';
    }
  }
  if (compound.id !== undefined) {
    result = worse(result, attributeMatch(element, { name: 'id', operator: '=', value: compound.id, insensitive: false }));
  }
  for (const name of compound.classes) {
    result = worse(result, classMatch(element, name));
  }
  for (const condition of compound.attrs) {
    result = worse(result, attributeMatch(element, condition));
  }
  for (const pseudo of compound.pseudoClasses) {
    if (pseudo === ':root') {
      result = worse(result, element.parent === undefined && element.tag === 'html' ? 'yes' : 'no');
    } else {
      // State (:hover) and position (:nth-child) are not things the source says.
      result = worse(result, 'maybe');
    }
  }
  if (compound.hasGroups.length > 0) {
    result = worse(result, 'maybe');
  }
  for (const negation of compound.negations) {
    const negated = new ChainMatcher(negation, elements).chain(negation.compounds.length - 1, elementIndex);
    result = worse(result, negated === 'yes' ? 'no' : negated === 'maybe' ? 'maybe' : 'yes');
  }
  for (const group of compound.requireAny) {
    let any: Possibility = 'no';
    for (const member of group) {
      if (member.compounds.length > 0) {
        any = better(any, new ChainMatcher(member, elements).chain(member.compounds.length - 1, elementIndex));
      }
    }
    result = worse(result, any);
  }
  return result;
}

function classMatch(element: StyledElement, name: string): Possibility {
  if (element.classes.has(name)) {
    return 'yes';
  }
  return element.classesKnown ? 'no' : 'maybe';
}

interface AttributeCondition {
  readonly name: string;
  readonly operator: string | undefined;
  readonly value: string | undefined;
  readonly insensitive: boolean;
}

function attributeMatch(element: StyledElement, condition: AttributeCondition): Possibility {
  const found = attributeValue(element, condition.name);
  if (found.kind === 'unknown') {
    return 'maybe';
  }
  if (found.kind === 'absent') {
    return element.spread ? 'maybe' : 'no';
  }
  if (condition.operator === undefined || condition.value === undefined) {
    return 'yes';
  }
  const value = condition.insensitive ? found.value.toLowerCase() : found.value;
  const wanted = condition.insensitive ? condition.value.toLowerCase() : condition.value;
  return valueMatches(condition.operator, value, wanted) ? 'yes' : element.spread ? 'maybe' : 'no';
}

function valueMatches(operator: string, value: string, wanted: string): boolean {
  switch (operator) {
    case '=':
      return value === wanted;
    case '~=':
      return value.split(/\s+/).includes(wanted);
    case '|=':
      return value === wanted || value.startsWith(`${wanted}-`);
    case '^=':
      return wanted.length > 0 && value.startsWith(wanted);
    case '$=':
      return wanted.length > 0 && value.endsWith(wanted);
    case '*=':
      return wanted.length > 0 && value.includes(wanted);
    default:
      return true; // An operator we don't know: assume it may hold.
  }
}

type AttributeValue = { readonly kind: 'absent' } | { readonly kind: 'unknown' } | { readonly kind: 'known'; readonly value: string };

function attributeValue(element: StyledElement, name: string): AttributeValue {
  if (name === 'class') {
    if (!element.classesKnown) {
      return { kind: 'unknown' };
    }
    if (element.classes.size === 0) {
      return element.spread ? { kind: 'unknown' } : { kind: 'absent' };
    }
    return { kind: 'known', value: element.classText };
  }
  const key = Object.keys(element.props).find((candidate) => candidate.toLowerCase() === name);
  const attribute = key === undefined ? undefined : element.props[key];
  if (attribute === undefined) {
    return { kind: 'absent' };
  }
  switch (attribute.type) {
    case 'string':
      return { kind: 'known', value: attribute.value };
    case 'bare':
      return { kind: 'known', value: '' };
    case 'expr':
    case 'spread':
      return { kind: 'unknown' };
    default: {
      const exhaustive: never = attribute;
      return exhaustive;
    }
  }
}

// ───────────────────────────── The page tree ─────────────────────────────

interface StyledElement {
  /** Lowercased; undefined for a tag chosen at runtime. */
  readonly tag: string | undefined;
  /** A component instance: page selectors never reach what it renders. */
  readonly instance: boolean;
  readonly props: Readonly<Record<string, Attr>>;
  readonly classes: ReadonlySet<string>;
  readonly classText: string;
  /** False when an expression or `class:list` adds classes the source doesn't spell. */
  readonly classesKnown: boolean;
  readonly spread: boolean;
  readonly parent: number | undefined;
  /** The element rendered just before it under the same parent. */
  readonly previous: number | undefined;
  readonly moved: boolean;
}

interface StyleBlock {
  readonly nodeId: string;
  readonly css: string;
}

// Kinds that render their children in place and no element of their own.
const TRANSPARENT_KINDS = new Set(['map', 'cond', 'branch', 'chunk-group']);

// The page's elements in document order, and the scoped `<style>` blocks that
// can style them. A block inside the moved markup moves with it; a global or
// inline one is not scoped and keeps working.
function styledElements(
  nodes: readonly EditorNode[],
  movedId: string,
): { readonly elements: readonly StyledElement[]; readonly blocks: readonly StyleBlock[] } {
  const elements: StyledElement[] = [];
  const blocks: StyleBlock[] = [];
  // Returns the last element it placed: the next sibling's `previous`.
  const walk = (list: readonly EditorNode[], place: Place, depth: number): number | undefined => {
    assert(depth <= LIMITS.treeDepthMax, 'styledElements: the tree depth is bounded');
    let previous = place.previous;
    for (const node of list) {
      const inside = place.moved || node.id === movedId;
      if (TRANSPARENT_KINDS.has(node.kind) || isFragment(node)) {
        previous = walk(node.children ?? [], { parent: place.parent, previous, moved: inside }, depth + 1);
        continue;
      }
      if (node.kind !== 'element' && node.kind !== 'component' && node.kind !== 'raw') {
        continue; // Text, expressions and comments render no element we can name.
      }
      if (node.kind === 'raw' && node.name === 'style' && !inside && isScoped(node)) {
        blocks.push({ nodeId: node.id, css: node.inner ?? '' });
      }
      const index = elements.length;
      elements.push(styledElement(node, { parent: place.parent, previous, moved: inside }));
      previous = index;
      walk(node.children ?? [], { parent: index, previous: undefined, moved: inside }, depth + 1);
    }
    return previous;
  };
  walk(nodes, { parent: undefined, previous: undefined, moved: false }, 0);
  return { elements, blocks };
}

interface Place {
  readonly parent: number | undefined;
  readonly previous: number | undefined;
  readonly moved: boolean;
}

function styledElement(node: EditorNode, place: Place): StyledElement {
  const props = node.props ?? {};
  const classAttribute = props['class'];
  const classText = classAttribute?.type === 'string' ? classAttribute.value : '';
  const names = Object.keys(props);
  const spread = names.some((name) => props[name]?.type === 'spread');
  const dynamicClass = (classAttribute !== undefined && classAttribute.type !== 'string') || props['class:list'] !== undefined || spread;
  return {
    tag: node.dynamicTag === true || node.name === undefined ? undefined : node.name.toLowerCase(),
    instance: node.kind === 'component',
    props,
    classes: new Set(classText.split(/\s+/).filter((name) => name.length > 0)),
    classText,
    classesKnown: !dynamicClass,
    spread,
    parent: place.parent,
    previous: place.previous,
    moved: place.moved,
  };
}

const isFragment = (node: EditorNode): boolean => node.kind === 'component' && node.name === 'Fragment';

// `is:global` and `is:inline` blocks are left unscoped by Astro.
function isScoped(node: EditorNode): boolean {
  const props = node.props ?? {};
  return props['is:global'] === undefined && props['is:inline'] === undefined;
}

// ───────────────────────────── CSS helpers ─────────────────────────────

type StyleContainer = Rule | AtRule;

// Queries and layers wrap element styles; @keyframes, @font-face and the like don't.
const GROUP_AT_RULES = new Set(['media', 'supports', 'container', 'layer', 'scope', 'starting-style', 'document']);

function isStyleContainer(node: ChildNode): node is StyleContainer {
  if (node.type === 'rule') {
    return true;
  }
  return node.type === 'atrule' && node.nodes !== undefined && GROUP_AT_RULES.has(node.name.toLowerCase());
}
