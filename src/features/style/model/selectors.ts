// Selector parsing, specificity, and matching against the selected element.
//
// The Designer gives us no canvas DOM, so we can't call `element.matches()`.
// Instead we parse each selector with postcss-selector-parser and match it
// ourselves. Matching is tree-aware: it navigates the real page tree (ancestors,
// ordered siblings, descendants) via a TreeView, so descendant/child/sibling
// combinators, `:is()`/`:where()`/`:not()` and `:has()` all resolve correctly.
// It's async because element snapshots are read (and cached) on demand.

import type { ElementSnapshot } from './styleTypes';
import { type HasAxis, type HasCond, type AttrCond, type Compound, type PositionalPseudo, type CompiledSelector, compileSelectorList } from './selectorParse';
export {
  parseSelectorList,
  type SelectorListMember,
  selectorListMembers,
  type CanonicalCompound,
  canonicalCompound,
  selectorDependsOnAncestor,
  normalizePseudoElement,
  formatSpecificity,
  compareSpecificity,
} from './selectorParse';

// ─────────────────────────── Matching ───────────────────────────
//
// Matching is STRICT and tree-aware: a rule matches only when we can
// affirmatively confirm it against the element's tag/id/classes/attributes and
// its real position in the page tree (ancestors, ordered siblings, descendants).
// Anything unverifiable (an unknown tag on a bare type selector, a sibling we
// can't see) is a non-match, so the panel never shows styles that don't apply.

export type MatchResult = { matched: boolean; approximate: boolean };
const NO_MATCH: MatchResult = { matched: false, approximate: false };

/** Read-only view of the page tree the matcher navigates. */
export type TreeView = {
  /** True when ancestors above the root are unknown (component boundary). */
  truncated: boolean;
  parentKey: (key: string) => string | undefined;
  /** Ordered child keys of an element. */
  childKeys: (key: string) => string[];
  /**
   * Ordered children that actually render as elements, for the positional
   * pseudo-classes — `childKeys` also carries text/comment nodes, which CSS
   * doesn't count. Returns undefined when the answer can't be trusted (a loop or
   * expression sibling expands to an unknown number of elements), so callers
   * stay optimistic rather than guessing.
   */
  elementChildKeys?: (key: string) => string[] | undefined;
  /** Element identity by key, read + cached on demand. */
  snapshot: (key: string) => Promise<ElementSnapshot | undefined>;
};

export type MatchTarget = {
  rootKey: string;
  view: TreeView;
  /**
   * What the RENDERED page says about this element, when a live canvas can be
   * asked (see canvasQuery.js / primeDomMatches). Keyed by selector text.
   *
   * The tree walk below can only see the source: it stops at a component's
   * edge, and knows nothing of classes applied at runtime. Chromium matching
   * against the real DOM has neither limit, so its answer wins wherever it
   * has one — this map — and the walk stays as the fallback for everything
   * else (no preview running, a page that failed to build, a selector the
   * engine rejected).
   */
  domMatched?: Map<string, boolean>;
};

const HAS_DESCENDANTS_MAX = 2000;

// Compounds one selector may chain (`a > b c + d …`) before matching refuses it.
// Real stylesheets chain a handful; a few hundred leaves room for generated CSS.
const SELECTOR_LIMITS = { chainDepthMax: 256 } as const;

/** Match every selector in a list against the target element; results in order. */
export async function matchSelectorList(selectorText: string, target: MatchTarget): Promise<MatchResult[]> {
  const compiled = compileSelectorList(selectorText);
  const results: MatchResult[] = [];
  for (const selector of compiled) {
    const fromDom = target.domMatched?.get(selector.text);
    if (fromDom !== undefined) {
      results.push({ matched: fromDom, approximate: false });
      continue;
    }
    results.push(await matchComplex(selector, target.rootKey, target.view));
  }
  return results;
}

async function matchComplex(selector: CompiledSelector, subjectKey: string, view: TreeView): Promise<MatchResult> {
  if (!selector.compounds.length) {
    return NO_MATCH;
  }
  const keyIndex = selector.compounds.length - 1;
  const subject = selector.compounds[keyIndex];
  if (subject === undefined) {
    return NO_MATCH;
  }
  // Key (rightmost) compound must match the subject element itself.
  if (!(await matchCompound(subject, subjectKey, view))) {
    return NO_MATCH;
  }
  return { matched: await matchUpchain(selector, keyIndex, subjectKey, view), approximate: false };
}

/** Anchor compounds to the left of `compoundIndex` by walking the real tree. */
async function matchUpchain(selector: CompiledSelector, compoundIndex: number, currentKey: string, view: TreeView): Promise<boolean> {
  if (compoundIndex === 0) {
    return true;
  }
  // Each call anchors one compound further left, so the chain is as deep as the
  // selector is long. A chain past the bound is not hand-written CSS: refuse it.
  const chainDepth = selector.compounds.length - 1 - compoundIndex;
  if (chainDepth > SELECTOR_LIMITS.chainDepthMax) {
    return false;
  }
  // combinators[i] links compounds[i] and compounds[i+1], so the combinator to
  // the LEFT of compoundIndex lives at compoundIndex - 1.
  const combinator = selector.combinators[compoundIndex - 1];
  const left = selector.compounds[compoundIndex - 1];
  if (left === undefined) {
    return false;
  }

  if (combinator === '>') {
    const parent = view.parentKey(currentKey);
    if (parent === undefined) {
      return false;
    } // parent unknown → can't confirm
    if (!(await matchCompound(left, parent, view))) {
      return false;
    }
    return matchUpchain(selector, compoundIndex - 1, parent, view);
  }

  if (combinator === ' ') {
    // Descendant: some real ancestor must satisfy `left`.
    let ancestor = view.parentKey(currentKey);
    while (ancestor !== undefined) {
      if ((await matchCompound(left, ancestor, view)) && (await matchUpchain(selector, compoundIndex - 1, ancestor, view))) {
        return true;
      }
      ancestor = view.parentKey(ancestor);
    }
    return false;
  }

  // Sibling (`~` any preceding, `+` immediately preceding).
  const reach = combinator === '+' ? 'adjacent' : 'all';
  for (const sibling of precedingSiblings(currentKey, view, reach)) {
    if ((await matchCompound(left, sibling, view)) && (await matchUpchain(selector, compoundIndex - 1, sibling, view))) {
      return true;
    }
  }
  return false;
}

async function matchCompound(compound: Compound, key: string, view: TreeView): Promise<boolean> {
  const snapshot = await view.snapshot(key);
  if (!snapshot) {
    return false;
  }

  // An id must equal the element's.
  if (compound.id !== undefined && snapshot.id !== compound.id) {
    return false;
  }

  // Classes: every class in the selector must be on the element.
  for (const cls of compound.classes) {
    if (!snapshot.classes.includes(cls)) {
      return false;
    }
  }

  // Attributes and data attributes.
  for (const attr of compound.attrs) {
    if (!matchAttr(attr, snapshot)) {
      return false;
    }
  }

  // The tag is strict: it must equal the known tag. If the tag is unknown, only accept
  // when other constraints already pinned the element, so a bare unverifiable
  // type selector (`div`, `a`) never matches.
  if (compound.tag && compound.tag !== '*') {
    const hasOther =
      compound.id !== undefined || compound.classes.length > 0 || compound.attrs.length > 0 || compound.requireAny.length > 0 || compound.hasGroups.length > 0;
    if (snapshot.tag !== undefined) {
      if (snapshot.tag !== compound.tag) {
        return false;
      }
    } else if (!hasOther) {
      return false;
    }
  }

  // `:is(...)` / `:where(...)`: the element must match ≥1 selector in every group.
  for (const group of compound.requireAny) {
    let ok = false;
    for (const selector of group) {
      if ((await matchComplex(selector, key, view)).matched) {
        ok = true;
        break;
      }
    }
    if (!ok) {
      return false;
    }
  }

  // `:has(...)`: the element must satisfy each relational condition.
  for (const cond of compound.hasGroups) {
    if (!(await matchHas(cond, key, view))) {
      return false;
    }
  }

  // `:not(...)`: the element must NOT match the negated selector.
  for (const negation of compound.negations) {
    if ((await matchComplex(negation, key, view)).matched) {
      return false;
    }
  }

  // Structural pseudo-classes we can decide statically. `:root` matches only the
  // document root (<html>); a nested element merely *inherits* the custom
  // properties declared on `:root`, so `:root { --var }` must not count as
  // applied to this element. Dynamic states (:hover/:focus/…) stay optimistic
  // (matched + flagged conditional) since we can't know the runtime state.
  for (const pseudo of compound.pseudoClasses) {
    if (pseudo === ':root' && snapshot.tag !== 'html') {
      return false;
    }
  }

  // Position in the parent is knowable from the tree, so don't wave these
  // through with the dynamic states — a first child was matching
  // `> :last-child` and picking up styles it never gets on the page.
  for (const entry of compound.positional) {
    if ((await matchesPosition(entry, key, view)) === false) {
      return false;
    }
  }

  return true;
}

/**
 * CSS An+B — "odd", "even", "3", "n", "2n", "-n+2", "2n+1"…
 * Returns undefined for anything unrecognised (including the `of S` form, whose
 * selector list we don't evaluate) so the caller stays optimistic.
 */
function parseNthFormula(raw: string | undefined): { step: number; offset: number } | undefined {
  if (!raw) {
    return undefined;
  }
  const compact = raw.replace(/\s+/g, '').toLowerCase();
  if (compact === 'odd') {
    return { step: 2, offset: 1 };
  }
  if (compact === 'even') {
    return { step: 2, offset: 0 };
  }
  if (compact.includes('of')) {
    return undefined;
  }
  const anb = /^([+-]?\d*)n([+-]\d+)?$/.exec(compact);
  if (anb) {
    const lead = anb[1];
    const step = lead === '' || lead === '+' ? 1 : lead === '-' ? -1 : Number(lead);
    const offset = anb[2] ? Number(anb[2]) : 0;
    return Number.isFinite(step) && Number.isFinite(offset) ? { step, offset } : undefined;
  }
  if (/^[+-]?\d+$/.test(compact)) {
    return { step: 0, offset: Number(compact) };
  }
  return undefined;
}

/** Does 1-based `position` satisfy An+B for some integer n ≥ 0? */
function nthMatches(position: number, step: number, offset: number): boolean {
  if (step === 0) {
    return position === offset;
  }
  const cycles = (position - offset) / step;
  return Number.isInteger(cycles) && cycles >= 0;
}

/**
 * Whether `key` sits where the pseudo requires, or undefined when the tree can't
 * say — no known parent (a component boundary), a sibling that expands to an
 * unknown number of elements, an unparseable An+B, or, for the `-of-type`
 * family, a sibling whose tag is unknown (a component renders markup this
 * panel can't see, so its element type is unknowable). Undefined keeps the old
 * optimistic behaviour instead of guessing.
 */
async function matchesPosition(entry: PositionalPseudo, key: string, view: TreeView): Promise<boolean | undefined> {
  const parent = view.parentKey(key);
  if (parent === undefined) {
    return undefined;
  }
  const siblings = view.elementChildKeys?.(parent);
  if (!siblings || siblings.indexOf(key) < 0) {
    return undefined;
  }

  // `-of-type` counts only siblings sharing this element's tag.
  let list = siblings;
  if (entry.name.endsWith('-of-type')) {
    const snaps = await Promise.all(siblings.map((siblingKey) => view.snapshot(siblingKey)));
    if (snaps.some((snapshot) => !snapshot?.tag)) {
      return undefined;
    }
    const ownTag = snaps[siblings.indexOf(key)]?.tag;
    if (!ownTag) {
      return undefined;
    }
    list = siblings.filter((_, i) => snaps[i]?.tag === ownTag);
  }

  const position = list.indexOf(key) + 1;
  if (position === 0) {
    return undefined;
  }
  const total = list.length;

  switch (entry.name) {
    case ':first-child':
    case ':first-of-type':
      return position === 1;
    case ':last-child':
    case ':last-of-type':
      return position === total;
    case ':only-child':
    case ':only-of-type':
      return total === 1;
    case ':nth-child':
    case ':nth-of-type': {
      const anb = parseNthFormula(entry.arg);
      return anb ? nthMatches(position, anb.step, anb.offset) : undefined;
    }
    case ':nth-last-child':
    case ':nth-last-of-type': {
      const anb = parseNthFormula(entry.arg);
      return anb ? nthMatches(total - position + 1, anb.step, anb.offset) : undefined;
    }
    default:
      return undefined;
  }
}

async function matchHas(cond: HasCond, subjectKey: string, view: TreeView): Promise<boolean> {
  for (const candidate of hasCandidates(cond.axis, subjectKey, view)) {
    if ((await matchComplex(cond.sel, candidate, view)).matched) {
      return true;
    }
  }
  return false;
}

function hasCandidates(axis: HasAxis, key: string, view: TreeView): string[] {
  if (axis === 'child') {
    return view.childKeys(key);
  }
  if (axis === 'adjacent') {
    return followingSiblings(key, view, 'adjacent');
  }
  if (axis === 'sibling') {
    return followingSiblings(key, view, 'all');
  }
  return descendants(key, view);
}

/** Which siblings a combinator reaches: only the adjacent one (`+`), or all (`~`). */
type SiblingReach = 'adjacent' | 'all';

function precedingSiblings(key: string, view: TreeView, reach: SiblingReach): string[] {
  const parent = view.parentKey(key);
  if (parent === undefined) {
    return [];
  }
  const siblings = view.childKeys(parent);
  const index = siblings.indexOf(key);
  if (index <= 0) {
    return [];
  }
  const adjacent = siblings[index - 1];
  // The preceding siblings come back nearest-first.
  return reach === 'adjacent' && adjacent !== undefined ? [adjacent] : siblings.slice(0, index).reverse();
}

function followingSiblings(key: string, view: TreeView, reach: SiblingReach): string[] {
  const parent = view.parentKey(key);
  if (parent === undefined) {
    return [];
  }
  const siblings = view.childKeys(parent);
  const index = siblings.indexOf(key);
  if (index < 0) {
    return [];
  }
  const after = siblings.slice(index + 1);
  return reach === 'adjacent' ? after.slice(0, 1) : after;
}

function descendants(key: string, view: TreeView): string[] {
  const out: string[] = [];
  const stack = [...view.childKeys(key)];
  while (stack.length && out.length < HAS_DESCENDANTS_MAX) {
    const current = stack.shift();
    if (current === undefined) {
      break;
    }
    out.push(current);
    for (const child of view.childKeys(current)) {
      stack.push(child);
    }
  }
  return out;
}

function attrValue(snapshot: ElementSnapshot, name: string): string | undefined {
  if (name === 'class') {
    return snapshot.classes.join(' ');
  }
  if (name === 'id') {
    return snapshot.id;
  }
  return snapshot.attributes[name];
}

function matchAttr(attr: AttrCond, snapshot: ElementSnapshot): boolean {
  const actual = attrValue(snapshot, attr.name);
  if (actual === undefined) {
    return false;
  }
  if (attr.operator === undefined || attr.value === undefined) {
    return true;
  } // [attr] presence

  const expected = attr.insensitive ? attr.value.toLowerCase() : attr.value;
  const got = attr.insensitive ? actual.toLowerCase() : actual;

  switch (attr.operator) {
    case '=':
      return got === expected;
    case '~=':
      return got.split(/\s+/).includes(expected);
    case '|=':
      return got === expected || got.startsWith(`${expected}-`);
    case '^=':
      return expected.length > 0 && got.startsWith(expected);
    case '$=':
      return expected.length > 0 && got.endsWith(expected);
    case '*=':
      return expected.length > 0 && got.includes(expected);
    default:
      return false;
  }
}
