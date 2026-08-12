// Selector parsing, specificity, and matching against the selected element.
//
// The Designer gives us no canvas DOM, so we can't call `element.matches()`.
// Instead we parse each selector with postcss-selector-parser and match it
// ourselves. Matching is tree-aware: it navigates the real page tree (ancestors,
// ordered siblings, descendants) via a TreeView, so descendant/child/sibling
// combinators, `:is()`/`:where()`/`:not()` and `:has()` all resolve correctly.
// It's async because element snapshots are read (and cached) on demand.

import selectorParser from 'postcss-selector-parser'
import type { ElementSnapshot, SelectorInfo, Specificity } from './types'

type Combinator = ' ' | '>' | '+' | '~'
type HasAxis = 'descendant' | 'child' | 'sibling' | 'adjacent'
type HasCond = { axis: HasAxis; sel: CompiledSelector }

type AttrCond = {
  name: string
  operator: string | null
  value: string | null
  insensitive: boolean
}

type Compound = {
  universal: boolean
  tag: string | null
  id: string | null
  classes: string[]
  attrs: AttrCond[]
  /** `:not(...)` arguments, each a compiled selector to negate. */
  negations: CompiledSelector[]
  /** `:is()` / `:where()` groups — element must match ≥1 selector in each group. */
  requireAny: CompiledSelector[][]
  /** `:has(...)` relational conditions — element must satisfy each. */
  hasGroups: HasCond[]
  hasPseudoClass: boolean
  /** State/structural pseudo-classes on this compound (`:hover`, `:focus`, …), lowercased. */
  pseudoClasses: string[]
  /** Positional pseudos with their raw `An+B` argument, which pseudoClasses drops. */
  positional: PositionalPseudo[]
  pseudoElement: string | null
}

type PositionalPseudo = { name: string; arg: string | null }

type CompiledSelector = {
  text: string
  compounds: Compound[]
  /** combinators[i] links compounds[i-1] and compounds[i]; combinators[0] unused. */
  combinators: Combinator[]
  specificity: Specificity
  hasPseudoClass: boolean
  pseudoElement: string | null
}

const emptyCompound = (): Compound => ({
  universal: false,
  tag: null,
  id: null,
  classes: [],
  attrs: [],
  negations: [],
  requireAny: [],
  hasGroups: [],
  hasPseudoClass: false,
  pseudoClasses: [],
  positional: [],
  pseudoElement: null,
})

function normalizeCombinator(value: string): Combinator {
  const v = value.trim()
  if (v === '>') return '>'
  if (v === '+') return '+'
  if (v === '~') return '~'
  return ' '
}

function isPseudoElement(value: string): boolean {
  if (value.startsWith('::')) return true
  // Legacy single-colon pseudo-elements.
  return /^:(before|after|first-line|first-letter|placeholder|selection|marker|backdrop)$/i.test(value)
}

/** Parse a full selector list (comma-separated) into display + match info. */
export function parseSelectorList(selectorText: string): SelectorInfo[] {
  const compiled = compileSelectorList(selectorText)
  return compiled.map((sel) => ({
    text: sel.text,
    specificity: sel.specificity,
    hasPseudoClass: sel.hasPseudoClass,
    pseudoElement: sel.pseudoElement,
    approximate: false,
  }))
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
  simple: boolean
  /** True when the selector is a single compound (no combinator / descendant) — it
   *  may still carry `:is()`/`:not()`/pseudos, unlike `simple`. Distinguishes
   *  `.a:is(:hover,:focus)` (one compound) from `.parent .a` (complex). */
  oneCompound: boolean
  tokens: string[]
  pseudoClasses: string[]
  /** The pseudo-element the selector targets ('::before'), normalized, or ''. A
   *  pseudo-element styles a generated box, so it's a separate edit target from the
   *  element itself and never `simple` (not chip/native-editable). */
  pseudoElement: string
  /** True when the selector is a single plain compound (tag/class/attr[/id], plus a
   *  pseudo-class and/or pseudo-element) with NO combinator and NO `:is()`/`:has()`/
   *  `:not()`. Such a selector reads cleanly on its own, so it can be split out of a
   *  grouped rule for an isolated edit (`.a::before` yes; `:not(.x) > :is(...)` no). */
  splittable: boolean
  /** True when the subject compound is the universal `*` (with no tag/class/attr). */
  universal: boolean
}

// Pseudo-classes representable as a Webflow class STATE (a chip / native-editable
// combo). Any other pseudo-class — structural (:nth-child, :first-child, :nth-of-type,
// …) or an unsupported state — must keep the compound COMPLEX so its full text is
// preserved (embed-editable) instead of collapsing to the bare class.
const STATE_PSEUDO_CLASSES = new Set([':hover', ':focus', ':active'])

export function canonicalCompound(selectorText: string): CanonicalCompound {
  const sel = compileSelectorList(selectorText)[0]
  const subject = sel?.compounds[sel.compounds.length - 1]
  if (!sel || !subject) return { simple: false, oneCompound: false, tokens: [], pseudoClasses: [], pseudoElement: '', splittable: false, universal: false }

  const pseudoClasses = subject.pseudoClasses
  const pseudoElement = normalizePseudoElement(sel.pseudoElement)
  const oneCompound = sel.compounds.length === 1 && sel.combinators.length === 0
  const noFunctionalPseudo =
    subject.negations.length === 0 && subject.requireAny.length === 0 && subject.hasGroups.length === 0
  // Only bare state pseudos keep a compound "simple"; a structural pseudo (:nth-child …)
  // isn't a Webflow class state, so it must read as complex to keep its full text.
  const stateOnly = pseudoClasses.every((p) => STATE_PSEUDO_CLASSES.has(p))
  const simple = oneCompound && !pseudoElement && !subject.universal && subject.id == null && noFunctionalPseudo && stateOnly
  // Like `simple`, but a pseudo-element is allowed (it's the whole point of splitting
  // `.a::before`). A bare universal (`::before`) is never splittable — it's hidden.
  const splittable = oneCompound && !subject.universal && noFunctionalPseudo

  const tokens: string[] = []
  if (subject.tag) tokens.push(`tag:${subject.tag}`)
  subject.classes.forEach((cls) => tokens.push(`class:${cls}`))
  subject.attrs.forEach((attr) => {
    // Presence `[data-x]` → `attr:data-x` (matches a chip); a valued/operator
    // form `[data-x="y"]` gets a distinct token so it stays orange-only.
    tokens.push(attr.operator && attr.value != null ? `attr:${attr.name}${attr.operator}"${attr.value}"` : `attr:${attr.name}`)
  })
  return { simple, oneCompound, tokens, pseudoClasses, pseudoElement, splittable, universal: subject.universal }
}

/** Normalize a pseudo-element to its `::name` form (handles legacy `:before`), or ''. */
export function normalizePseudoElement(pe: string | null | undefined): string {
  if (!pe) return ''
  return `::${pe.replace(/^::?/, '').toLowerCase()}`
}

const compileCache = new Map<string, CompiledSelector[]>()

function compileSelectorList(selectorText: string): CompiledSelector[] {
  const cached = compileCache.get(selectorText)
  if (cached) return cached

  let result: CompiledSelector[] = []
  try {
    selectorParser((root) => {
      root.each((selector) => {
        if (selector.type !== 'selector') return
        result.push(compileSelector(selector))
      })
    }).processSync(selectorText)
  } catch {
    // Unparseable selector — yield a never-matching stub so the rule still lists.
    result = [{
      text: selectorText.trim(),
      compounds: [],
      combinators: [],
      specificity: [0, 0, 0],
      hasPseudoClass: false,
      pseudoElement: null,
    }]
  }

  compileCache.set(selectorText, result)
  return result
}

type SelectorNode = selectorParser.Selector

function compileSelector(selector: SelectorNode): CompiledSelector {
  const compounds: Compound[] = []
  const combinators: Combinator[] = []
  let current = emptyCompound()
  let started = false
  let a = 0
  let b = 0
  let c = 0
  let hasPseudoClass = false
  let pseudoElement: string | null = null

  const pushCurrent = () => {
    compounds.push(current)
    current = emptyCompound()
  }

  selector.each((node) => {
    switch (node.type) {
      case 'combinator': {
        if (started) {
          pushCurrent()
          combinators.push(normalizeCombinator(node.value))
          started = false
        }
        break
      }
      case 'tag': {
        current.tag = node.value.toLowerCase()
        c += 1
        started = true
        break
      }
      case 'universal': {
        current.universal = true
        started = true
        break
      }
      case 'id': {
        current.id = node.value
        a += 1
        started = true
        break
      }
      case 'class': {
        current.classes.push(node.value)
        b += 1
        started = true
        break
      }
      case 'attribute': {
        const attr = node as selectorParser.Attribute
        current.attrs.push({
          name: attr.attribute.toLowerCase(),
          operator: attr.operator ?? null,
          value: attr.value ?? null,
          insensitive: Boolean(attr.insensitive),
        })
        b += 1
        started = true
        break
      }
      case 'pseudo': {
        const value = node.value
        if (isPseudoElement(value)) {
          current.pseudoElement = value
          pseudoElement = value
          c += 1
        } else if (value === ':not') {
          // Negation: compile inner, negate at match time; specificity = the
          // most specific argument (per spec).
          const inner = compileFunctionalArg(node)
          current.negations.push(...inner)
          const top = mostSpecific(inner)
          if (top) { a += top[0]; b += top[1]; c += top[2] }
        } else if (value === ':is' || value === ':matches' || value === ':where') {
          // :is()/:where() are static structural matchers, NOT state pseudo-
          // classes — the element must match one of their arguments. :where
          // adds zero specificity; :is/:matches add their most specific arg.
          const inner = compileFunctionalArg(node)
          if (inner.length) current.requireAny.push(inner)
          if (value !== ':where') {
            const top = mostSpecific(inner)
            if (top) { a += top[0]; b += top[1]; c += top[2] }
          }
        } else if (value === ':has') {
          // Relational: element must have a descendant/sibling matching the arg.
          const conds = compileHasArg(node)
          current.hasGroups.push(...conds)
          const top = mostSpecific(conds.map((cnd) => cnd.sel))
          if (top) { a += top[0]; b += top[1]; c += top[2] }
        } else {
          // A real state/structural pseudo-class (:hover, :focus, :nth-child, …)
          // — mark conditional. Positional ones also keep their An+B argument,
          // which pseudoClasses (names only) can't carry, so the matcher can
          // evaluate them against the tree.
          current.hasPseudoClass = true
          const pseudoName = value.toLowerCase()
          current.pseudoClasses.push(pseudoName)
          if (POSITIONAL_PSEUDOS.has(pseudoName)) {
            current.positional.push({ name: pseudoName, arg: pseudoArgText(node) })
          }
          hasPseudoClass = true
          b += 1
        }
        started = true
        break
      }
      default:
        break
    }
  })
  if (started) pushCurrent()

  return {
    text: selector.toString().trim(),
    compounds,
    combinators,
    specificity: [a, b, c],
    hasPseudoClass,
    pseudoElement,
  }
}

function compileFunctionalArg(node: selectorParser.Pseudo): CompiledSelector[] {
  const out: CompiledSelector[] = []
  node.each?.((child) => {
    if (child.type === 'selector') out.push(compileSelector(child))
  })
  return out
}

function axisFromCombinator(value: string): HasAxis {
  const v = value.trim()
  if (v === '>') return 'child'
  if (v === '+') return 'adjacent'
  if (v === '~') return 'sibling'
  return 'descendant'
}

/** Compile `:has(...)` args, reading the leading combinator as the relation. */
function compileHasArg(node: selectorParser.Pseudo): HasCond[] {
  const out: HasCond[] = []
  node.each?.((child) => {
    if (child.type !== 'selector') return
    const first = child.nodes[0]
    const axis: HasAxis = first && first.type === 'combinator' ? axisFromCombinator(first.value) : 'descendant'
    // compileSelector ignores a leading combinator, so `sel` is the arg minus it.
    out.push({ axis, sel: compileSelector(child) })
  })
  return out
}

/** The most specific argument's specificity (for :not / :is / :has). */
function mostSpecific(selectors: CompiledSelector[]): Specificity | null {
  let best: Specificity | null = null
  for (const sel of selectors) {
    if (!best || compareSpecificity(sel.specificity, best) > 0) best = sel.specificity
  }
  return best
}

// ─────────────────────────── Matching ───────────────────────────
//
// Matching is STRICT and tree-aware: a rule matches only when we can
// affirmatively confirm it against the element's tag/id/classes/attributes and
// its real position in the page tree (ancestors, ordered siblings, descendants).
// Anything unverifiable (an unknown tag on a bare type selector, a sibling we
// can't see) is a non-match, so the panel never shows styles that don't apply.

export type MatchResult = { matched: boolean; approximate: boolean }
const NO_MATCH: MatchResult = { matched: false, approximate: false }

/** Read-only view of the page tree the matcher navigates. */
export type TreeView = {
  /** True when ancestors above the root are unknown (component boundary). */
  truncated: boolean
  parentKey: (key: string) => string | null
  /** Ordered child keys of an element. */
  childKeys: (key: string) => string[]
  /**
   * Ordered children that actually render as elements, for the positional
   * pseudo-classes — `childKeys` also carries text/comment nodes, which CSS
   * doesn't count. Returns null when the answer can't be trusted (a loop or
   * expression sibling expands to an unknown number of elements), so callers
   * stay optimistic rather than guessing.
   */
  elementChildKeys?: (key: string) => string[] | null
  /** Element identity by key, read + cached on demand. */
  snapshot: (key: string) => Promise<ElementSnapshot | null>
}

export type MatchTarget = {
  rootKey: string
  view: TreeView
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
  domMatched?: Map<string, boolean>
}

const MAX_HAS_DESCENDANTS = 2000

/** Match every selector in a list against the target element; results in order. */
export async function matchSelectorList(selectorText: string, target: MatchTarget): Promise<MatchResult[]> {
  const compiled = compileSelectorList(selectorText)
  const results: MatchResult[] = []
  for (const sel of compiled) {
    const fromDom = target.domMatched?.get(sel.text)
    if (fromDom !== undefined) {
      results.push({ matched: fromDom, approximate: false })
      continue
    }
    results.push(await matchComplex(sel, target.rootKey, target.view))
  }
  return results
}

async function matchComplex(sel: CompiledSelector, subjectKey: string, view: TreeView): Promise<MatchResult> {
  if (!sel.compounds.length) return NO_MATCH
  const keyIndex = sel.compounds.length - 1
  // Key (rightmost) compound must match the subject element itself.
  if (!(await matchCompound(sel.compounds[keyIndex], subjectKey, view))) return NO_MATCH
  return { matched: await matchUpchain(sel, keyIndex, subjectKey, view), approximate: false }
}

/** Anchor compounds to the left of `compoundIndex` by walking the real tree. */
async function matchUpchain(sel: CompiledSelector, compoundIndex: number, currentKey: string, view: TreeView): Promise<boolean> {
  if (compoundIndex === 0) return true
  // combinators[i] links compounds[i] and compounds[i+1], so the combinator to
  // the LEFT of compoundIndex lives at compoundIndex - 1.
  const combinator = sel.combinators[compoundIndex - 1]
  const left = sel.compounds[compoundIndex - 1]

  if (combinator === '>') {
    const parent = view.parentKey(currentKey)
    if (parent == null) return false // parent unknown → can't confirm
    if (!(await matchCompound(left, parent, view))) return false
    return matchUpchain(sel, compoundIndex - 1, parent, view)
  }

  if (combinator === ' ') {
    // Descendant: some real ancestor must satisfy `left`.
    let ancestor = view.parentKey(currentKey)
    while (ancestor != null) {
      if (await matchCompound(left, ancestor, view) && await matchUpchain(sel, compoundIndex - 1, ancestor, view)) {
        return true
      }
      ancestor = view.parentKey(ancestor)
    }
    return false
  }

  // Sibling (`~` any preceding, `+` immediately preceding).
  for (const sibling of precedingSiblings(currentKey, view, combinator === '+')) {
    if (await matchCompound(left, sibling, view) && await matchUpchain(sel, compoundIndex - 1, sibling, view)) {
      return true
    }
  }
  return false
}

async function matchCompound(compound: Compound, key: string, view: TreeView): Promise<boolean> {
  const el = await view.snapshot(key)
  if (!el) return false

  // id
  if (compound.id != null && el.id !== compound.id) return false

  // classes — every class in the selector must be on the element
  for (const cls of compound.classes) {
    if (!el.classes.includes(cls)) return false
  }

  // attributes / data attributes
  for (const attr of compound.attrs) {
    if (!matchAttr(attr, el)) return false
  }

  // tag — strict: must equal the known tag. If the tag is unknown, only accept
  // when other constraints already pinned the element, so a bare unverifiable
  // type selector (`div`, `a`) never matches.
  if (compound.tag && compound.tag !== '*') {
    const hasOther = compound.id != null || compound.classes.length > 0 || compound.attrs.length > 0
      || compound.requireAny.length > 0 || compound.hasGroups.length > 0
    if (el.tag != null) {
      if (el.tag !== compound.tag) return false
    } else if (!hasOther) {
      return false
    }
  }

  // :is(...) / :where(...) — element must match ≥1 selector in every group
  for (const group of compound.requireAny) {
    let ok = false
    for (const sel of group) {
      if ((await matchComplex(sel, key, view)).matched) { ok = true; break }
    }
    if (!ok) return false
  }

  // :has(...) — element must satisfy each relational condition
  for (const cond of compound.hasGroups) {
    if (!(await matchHas(cond, key, view))) return false
  }

  // :not(...) — element must NOT match the negated selector
  for (const negation of compound.negations) {
    if ((await matchComplex(negation, key, view)).matched) return false
  }

  // Structural pseudo-classes we can decide statically. `:root` matches only the
  // document root (<html>); a nested element merely *inherits* the custom
  // properties declared on `:root`, so `:root { --var }` must not count as
  // applied to this element. Dynamic states (:hover/:focus/…) stay optimistic
  // (matched + flagged conditional) since we can't know the runtime state.
  for (const pseudo of compound.pseudoClasses) {
    if (pseudo === ':root' && el.tag !== 'html') return false
  }

  // Position in the parent is knowable from the tree, so don't wave these
  // through with the dynamic states — a first child was matching
  // `> :last-child` and picking up styles it never gets on the page.
  for (const entry of compound.positional) {
    if ((await matchesPosition(entry, key, view)) === false) return false
  }

  return true
}

// Pseudo-classes decided by position among siblings rather than runtime state.
const POSITIONAL_PSEUDOS = new Set([
  ':first-child', ':last-child', ':only-child',
  ':nth-child', ':nth-last-child',
  ':first-of-type', ':last-of-type', ':only-of-type',
  ':nth-of-type', ':nth-last-of-type',
])

/** The text between a functional pseudo's parentheses (`2n + 1`), or null. */
function pseudoArgText(node: { toString: () => string }): string | null {
  const text = String(node)
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  return open !== -1 && close > open ? text.slice(open + 1, close).trim() : null
}

/**
 * CSS An+B — "odd", "even", "3", "n", "2n", "-n+2", "2n+1"…
 * Returns null for anything unrecognised (including the `of S` form, whose
 * selector list we don't evaluate) so the caller stays optimistic.
 */
function parseAnB(raw: string | null): { a: number; b: number } | null {
  if (!raw) return null
  const s = raw.replace(/\s+/g, '').toLowerCase()
  if (s === 'odd') return { a: 2, b: 1 }
  if (s === 'even') return { a: 2, b: 0 }
  if (s.includes('of')) return null
  const anb = /^([+-]?\d*)n([+-]\d+)?$/.exec(s)
  if (anb) {
    const lead = anb[1]
    const a = lead === '' || lead === '+' ? 1 : lead === '-' ? -1 : Number(lead)
    const b = anb[2] ? Number(anb[2]) : 0
    return Number.isFinite(a) && Number.isFinite(b) ? { a, b } : null
  }
  if (/^[+-]?\d+$/.test(s)) return { a: 0, b: Number(s) }
  return null
}

/** Does 1-based `pos` satisfy An+B for some integer n ≥ 0? */
function nthMatches(pos: number, a: number, b: number): boolean {
  if (a === 0) return pos === b
  const n = (pos - b) / a
  return Number.isInteger(n) && n >= 0
}

/**
 * Whether `key` sits where the pseudo requires, or null when the tree can't
 * say — no known parent (a component boundary), a sibling that expands to an
 * unknown number of elements, an unparseable An+B, or, for the `-of-type`
 * family, a sibling whose tag is unknown (a component renders markup this
 * panel can't see, so its element type is unknowable). Null keeps the old
 * optimistic behaviour instead of guessing.
 */
async function matchesPosition(
  entry: PositionalPseudo,
  key: string,
  view: TreeView,
): Promise<boolean | null> {
  const parent = view.parentKey(key)
  if (parent == null) return null
  const siblings = view.elementChildKeys?.(parent)
  if (!siblings || siblings.indexOf(key) < 0) return null

  // `-of-type` counts only siblings sharing this element's tag.
  let list = siblings
  if (entry.name.endsWith('-of-type')) {
    const snaps = await Promise.all(siblings.map((k) => view.snapshot(k)))
    if (snaps.some((s) => !s?.tag)) return null
    const ownTag = snaps[siblings.indexOf(key)]?.tag
    if (!ownTag) return null
    list = siblings.filter((_, i) => snaps[i]?.tag === ownTag)
  }

  const pos = list.indexOf(key) + 1
  if (pos === 0) return null
  const total = list.length

  switch (entry.name) {
    case ':first-child':
    case ':first-of-type':
      return pos === 1
    case ':last-child':
    case ':last-of-type':
      return pos === total
    case ':only-child':
    case ':only-of-type':
      return total === 1
    case ':nth-child':
    case ':nth-of-type': {
      const anb = parseAnB(entry.arg)
      return anb ? nthMatches(pos, anb.a, anb.b) : null
    }
    case ':nth-last-child':
    case ':nth-last-of-type': {
      const anb = parseAnB(entry.arg)
      return anb ? nthMatches(total - pos + 1, anb.a, anb.b) : null
    }
    default:
      return null
  }
}

async function matchHas(cond: HasCond, subjectKey: string, view: TreeView): Promise<boolean> {
  for (const candidate of hasCandidates(cond.axis, subjectKey, view)) {
    if ((await matchComplex(cond.sel, candidate, view)).matched) return true
  }
  return false
}

function hasCandidates(axis: HasAxis, key: string, view: TreeView): string[] {
  if (axis === 'child') return view.childKeys(key)
  if (axis === 'adjacent') return followingSiblings(key, view, true)
  if (axis === 'sibling') return followingSiblings(key, view, false)
  return descendants(key, view)
}

function precedingSiblings(key: string, view: TreeView, adjacentOnly: boolean): string[] {
  const parent = view.parentKey(key)
  if (parent == null) return []
  const sibs = view.childKeys(parent)
  const idx = sibs.indexOf(key)
  if (idx <= 0) return []
  return adjacentOnly ? [sibs[idx - 1]] : sibs.slice(0, idx).reverse() // nearest-first
}

function followingSiblings(key: string, view: TreeView, adjacentOnly: boolean): string[] {
  const parent = view.parentKey(key)
  if (parent == null) return []
  const sibs = view.childKeys(parent)
  const idx = sibs.indexOf(key)
  if (idx < 0) return []
  const after = sibs.slice(idx + 1)
  return adjacentOnly ? after.slice(0, 1) : after
}

function descendants(key: string, view: TreeView): string[] {
  const out: string[] = []
  const stack = [...view.childKeys(key)]
  while (stack.length && out.length < MAX_HAS_DESCENDANTS) {
    const current = stack.shift() as string
    out.push(current)
    for (const child of view.childKeys(current)) stack.push(child)
  }
  return out
}

function attrValue(el: ElementSnapshot, name: string): string | undefined {
  if (name === 'class') return el.classes.join(' ')
  if (name === 'id') return el.id ?? undefined
  return el.attributes[name]
}

function matchAttr(attr: AttrCond, el: ElementSnapshot): boolean {
  const actual = attrValue(el, attr.name)
  if (actual == null) return false
  if (attr.operator == null || attr.value == null) return true // [attr] presence

  const expected = attr.insensitive ? attr.value.toLowerCase() : attr.value
  const got = attr.insensitive ? actual.toLowerCase() : actual

  switch (attr.operator) {
    case '=':
      return got === expected
    case '~=':
      return got.split(/\s+/).includes(expected)
    case '|=':
      return got === expected || got.startsWith(`${expected}-`)
    case '^=':
      return expected.length > 0 && got.startsWith(expected)
    case '$=':
      return expected.length > 0 && got.endsWith(expected)
    case '*=':
      return expected.length > 0 && got.includes(expected)
    default:
      return false
  }
}

export function formatSpecificity(spec: Specificity): string {
  return `${spec[0]},${spec[1]},${spec[2]}`
}

/** Compare specificity: positive when `a` is stronger than `b`. */
export function compareSpecificity(a: Specificity, b: Specificity): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}
