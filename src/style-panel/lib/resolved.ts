// Resolved style model — re-projects the already-matched rules (from
// computeRuleModel) for ONE context (base / a query), ONE state (:hover/…), and
// ONE selected selector (the picked element tokens). It answers, per property:
// is it set by the SELECTED selector (blue) or only through ANOTHER selector
// (orange), which selectors contribute, and which one wins. Pure + synchronous
// so switching selector/context/state just re-derives — no re-scan.

import { compareCascade } from './cascade'
import type { RuleModel } from './cascade'
import { canonicalCompound, compareSpecificity, normalizePseudoElement } from './selectors'
import type { BreakpointId, ParsedRule, Specificity } from './types'

export type ContextKey = string // '' = Base; else the joined atContext
export type StateKey = '' | ':hover' | ':focus' | ':active'

/** Which layer an edit targets: the embed CSS or the native Webflow class style. */
export type SourceKey = 'embed' | 'native'

/**
 * A selectable context in the panel — Base, a Webflow breakpoint, an embed
 * `@media`/`@container`, or a breakpoint merged with an equivalent embed query.
 */
export type StyleContext = {
  /** Stable id used as the panel's `context` value. '' = Base. */
  key: string
  label: string
  /** The Webflow breakpoint native reads/writes target here, or null. */
  breakpoint: BreakpointId | null
  /** The embed at-context to match embed rules against ('' = base), or null. */
  embedAtContext: string | null
}

/** One property value contributed by a native Webflow class style. */
export type NativeContribution = {
  /** Index into NativeModel.styles (0 = base class, then combos). */
  styleIndex: number
  className: string
  /** The full compiled selector for this style — the whole combo chain
   *  (`.test.is-2`), not just the leaf class. Used to name the winner. */
  selector: string
  prop: string
  value: string
  isVariable: boolean
  /** Number of classes producing this style (combo depth) — its class-specificity. */
  classDepth: number
  /** Position in the breakpoint cascade (0 = base/main, higher = narrower). A
   *  narrower breakpoint's override wins a same-specificity tie over base. */
  bpTier: number
  /** True when this value is set at the VIEW's interaction state (not inherited from
   *  the base state under a :hover/… view) — only these read as "set here" (blue). */
  atState: boolean
}

export const STATES: readonly StateKey[] = ['', ':hover', ':focus', ':active']
const INTERACTION_STATES = new Set<string>([':hover', ':focus', ':active'])

function isStateKey(value: string): value is Exclude<StateKey, ''> {
  return INTERACTION_STATES.has(value)
}

// Native class styles are ordered before any embed rule so embed CSS (injected
// into the page after Webflow's compiled stylesheet) wins on a cascade tie.
const NATIVE_ORDER_BASE = -1_000_000

/** Extra data resolveStyle needs to fold native class styles into the model. */
export type NativeResolveInput = {
  source: SourceKey
  /** Native contributions for the current context + state (already filtered). */
  contribs: NativeContribution[]
  /** The native style index that is the editable target (source==='native'), else null. */
  selectedIndex: number | null
  /** In embed mode, the embed whose rule is the editable (blue) target — scopes
   *  `isSelected`/`selectedRule` to that one embed so each embed is edited on its
   *  own. Null/undefined → don't scope (any matching embed rule counts). */
  selectedEmbedKey?: string | null
  /** The current breakpoint's cascade tier (top of the chain). A native value is
   *  "set here" (blue) only at this tier; a lower tier means it's inherited from a
   *  wider breakpoint (orange). Undefined → don't gate (Base / non-breakpoint). */
  currentTier?: number
}

export type Contributor = {
  /** The matched selector's own text (e.g. '.a', '.parent .a', '.a:hover'). */
  selectorText: string
  value: string
  important: boolean
  specificity: Specificity
  /** Document order of the owning rule (ascending = earlier in the cascade). */
  order: number
  ruleId: string
  /** Where this value comes from: an embed rule or a native Webflow style. */
  origin: SourceKey
  /** For native contributors: the NativeModel.styles index (else undefined). */
  styleIndex?: number
  /** For native contributors: breakpoint cascade tier (0 = base; else undefined). */
  bpTier?: number
  /** For native contributors: whether the value is set at the view's interaction
   *  state (vs inherited from base under a :hover/… view). */
  atState?: boolean
  /** For embed contributors: the source embed — its key (canvas navigation), its
   *  display label (the chip text), and whether it lives in a component. */
  embedKey?: string
  embedLabel?: string
  fromComponent?: boolean
  /** True when this contributor IS the selected selector's rule. */
  isSelected: boolean
  /** True for the contributor whose value is the one being edited (the picked
   *  selector's) — the row the provenance list emphasizes. */
  editing?: boolean
  /** True for the single cascade winner of this property. */
  winning: boolean
  /** True when the selector can't be a token chip (combinator / :is / :has / …). */
  complexOnly: boolean
}

export type ResolvedProp = {
  prop: string
  /** 'selected' → blue (set on the picked selector); 'other' → orange. */
  source: 'selected' | 'other'
  /** Which layer the editable (selected) value lives in — so writes/clears target
   *  the right place. 'native' when the Webflow class sets it, 'embed' when the
   *  picked embed does (native-first, embed-fallback). undefined when 'other'. */
  selectedOrigin?: SourceKey
  /** The selected selector's own value for this prop (source==='selected'). */
  selectedValue?: { value: string; important: boolean }
  /** The cascade winner across all contributors in this context/state. */
  winner: Contributor
  /** True when the selected selector DOES set this prop but a more specific
   *  selector wins — the value is struck through and the winner named. */
  overridden: boolean
  contributors: Contributor[]
}

export type ResolvedStyle = {
  props: Map<string, ResolvedProp>
  /** The selected selector's rule in this context/state, or null (create on edit). */
  selectedRule: ParsedRule | null
  /** Distinct contexts present for this element (Base first) — drives the switcher. */
  contexts: ContextKey[]
  states: readonly StateKey[]
}

/** The context key for a rule: '' for base, else the joined at-rule chain. */
export function contextKeyOf(rule: ParsedRule): ContextKey {
  return rule.atContext.length ? rule.atContext.join(' › ') : ''
}

/** The interaction state a selector targets (from its subject pseudo-classes). */
function stateOf(pseudoClasses: string[]): StateKey {
  for (const pseudo of pseudoClasses) {
    if (isStateKey(pseudo)) {return pseudo}
  }
  return ''
}

export type ContextInfo = {
  key: ContextKey
  /** The element has ≥1 applied declaration in this context (any selector). */
  hasStyles: boolean
  /** Simple token-combos (chip-representable) with styles here, strongest first. */
  styledCombos: string[][]
  /** The strongest such combo — what to auto-select when switching here. */
  bestTokens: string[] | null
}

/**
 * Per-context summary across ALL the element's matched rules (any selector,
 * any state): does the context have applied styles (→ dropdown dot), and which
 * token-combos carry them (→ auto-highlight on switch). `contextKeys` may include
 * queries with no element styles (so the dropdown can offer them); those come
 * back with hasStyles=false.
 */
export function indexContexts(model: RuleModel, contextKeys: ContextKey[]): ContextInfo[] {
  const all = [...model.base, ...model.conditional]
  return contextKeys.map((key) => {
    let hasStyles = false
    const combos: Array<{ tokens: string[]; specificity: Specificity }> = []
    for (const matched of all) {
      if (contextKeyOf(matched.rule) !== key) {continue}
      if (matched.rule.declarations.length === 0) {continue}
      hasStyles = true
      for (const sel of matched.matchedSelectors) {
        if (sel.pseudoElement != null) {continue} // styles a generated box, not the element
        const canon = canonicalCompound(sel.text)
        if (!canon.simple) {continue}
        combos.push({ tokens: canon.tokens, specificity: sel.specificity })
      }
    }
    combos.sort((a, b) => compareSpecificity(b.specificity, a.specificity))
    // Dedup combos (by token set) keeping strongest-first order.
    const seen = new Set<string>()
    const styledCombos: string[][] = []
    for (const combo of combos) {
      const id = [...combo.tokens].sort().join('|')
      if (seen.has(id)) {continue}
      seen.add(id)
      styledCombos.push(combo.tokens)
    }
    return { key, hasStyles, styledCombos, bestTokens: styledCombos[0] ?? null }
  })
}

/** A selector (subject = the element) that has styles — one chip in the picker. */
export type MatchedSelector = {
  /** The authored selector text, e.g. `.test:hover`, `.parent.is-active .test`. */
  text: string
  specificity: Specificity
  /** Interaction state encoded in the subject (:hover/:focus/:active), else ''. */
  state: StateKey
  /** True for a lone tag/class/attr compound (chip-composable / native-eligible). */
  simple: boolean
  /** True when at least one matching rule comes from a component's style tag. */
  fromComponent: boolean
  /** Normalized identity key (also used to dedupe + compare). */
  key: string
  /** Set for the active selector when no rule exists for it yet (a freshly picked /
   *  typed selector) — rendered as a pending chip until its first property lands. */
  pending?: boolean
  /** False when this selector is styled only in OTHER contexts (dimmed in the
   *  picker); true/undefined when it has styles in the current context. */
  inContext?: boolean
  /** Source-order index (first appearance in the embed CSS) — a tiebreaker so the
   *  picker keeps authored order, e.g. `:before` before `:after` when written first. */
  order?: number
  /** Nested-source display (`.hero {.title}`) for a nested rule, else undefined —
   *  the chip label; matching still uses `text` (the resolved selector). */
  display?: string
  /** Nested display with an `@` at the query's position (`.hero {@ .title}`), shown
   *  when viewing that query, else undefined. */
  queryDisplay?: string
}

type MatchedSelectorCandidate = Omit<MatchedSelector, 'key' | 'order'>

function listMatchedSelectorsCandidate(input: {
  readonly rule: ParsedRule
  readonly text: string
  readonly specificity: Specificity
  readonly state: StateKey
  readonly simple: boolean
  readonly inContext: boolean
}): MatchedSelectorCandidate {
  return {
    text: input.text,
    specificity: input.specificity,
    state: input.state,
    simple: input.simple,
    inContext: input.inContext,
    fromComponent: input.rule.fromComponent,
    ...(input.rule.nestedDisplay === undefined
      ? {}
      : { display: input.rule.nestedDisplay }),
    ...(input.rule.queryDisplay === undefined
      ? {}
      : { queryDisplay: input.rule.queryDisplay }),
  }
}

const normalizeSelectorText = (text: string) =>
  text.replace(/\s*([>+~])\s*/g, ' $1 ').replace(/\s+/g, ' ').trim()

/**
 * A normalized identity for a selector so equal selectors compare equal: a simple
 * compound by its token SET + state (so `.a.b` === `.b.a`, `div.a` === `.a` + tag),
 * a complex selector by its whitespace-normalized text.
 */
export function selectorKey(text: string): string {
  const canon = canonicalCompound(text)
  const state = stateOf(canon.pseudoClasses)
  if (canon.simple) {return `s:${[...canon.tokens].sort().join('&')}|${state}`}
  return `c:${normalizeSelectorText(text)}`
}

/** Whether two selectors are the same target (subject compound / full selector). */
export function selectorsMatch(a: string, b: string): boolean {
  return selectorKey(a) === selectorKey(b)
}

/** The interaction state a selector targets, from its subject pseudo-classes. */
export function stateForSelector(text: string): StateKey {
  return stateOf(canonicalCompound(text).pseudoClasses)
}

/**
 * Every distinct selector that has styles and targets this element (subject match),
 * for the selector-chip picker — the element's own classes plus stateful (`.a:hover`)
 * and complex/ancestor (`.parent .a`, `:first-child`) selectors. Selectors from
 * EVERY context are returned; each is flagged `inContext` for `context` so the
 * picker can dim (rather than hide) the ones styled only in other queries. Ordered
 * least-specific first, then alphabetically.
 */
export function listMatchedSelectors(model: RuleModel, context: ContextKey): MatchedSelector[] {
  const all = [...model.base, ...model.conditional]
  const byKey = new Map<string, MatchedSelector>()
  let order = 0 // source-order rank, assigned on first appearance
  const addChip = (chip: MatchedSelectorCandidate) => {
    const key = selectorKey(chip.text)
    const existing = byKey.get(key)
    if (existing) {
      // A selector styled in several contexts is one chip. When a later match lives in
      // the viewed context, adopt its in-context flag AND its query display so the `@`
      // marker attaches even though an out-of-query rule (iterated first) created it.
      if (chip.inContext) {
        existing.inContext = true
        if (chip.queryDisplay) {existing.queryDisplay = chip.queryDisplay}
      }
      if (chip.fromComponent) {existing.fromComponent = true}
      return
    }
    byKey.set(key, {
      ...chip,
      key,
      order: order++,
    })
  }

  for (const matched of all) {
    if (matched.rule.declarations.length === 0) {continue}
    const inContext = contextKeyOf(matched.rule) === context
    // A splittable selector (`.card::before`) gets its own chip — editing it splits it
    // out of the grouped rule. Complex matched selectors (`:not(.x) > :is(...)`, which
    // can't be cleanly split) are folded into ONE chip showing the rule's FULL grouped
    // selector, so it's clear that editing touches every selector/element it targets.
    let complexSpec: Specificity | null = null
    for (const sel of matched.matchedSelectors) {
      const canon = canonicalCompound(sel.text)
      // A BARE pseudo-element (`::before`, `*::before`) styles every element's box with
      // no element-specific selector — it'd pollute every element's list; skip it.
      if (canon.pseudoElement && canon.oneCompound && canon.tokens.length === 0) {continue}
      // A lone universal (`*`) matches everything — too generic to be a useful chip on
      // its own. Skip it UNLESS it's part of a more specific selector (a combinator,
      // a state, or a pseudo-element makes it non-bare, so it isn't caught here).
      if (
        canon.universal &&
        canon.oneCompound &&
        canon.tokens.length === 0 &&
        !canon.pseudoElement &&
        canon.pseudoClasses.length === 0
      ) {continue}
      if (canon.splittable) {
        addChip(listMatchedSelectorsCandidate({
          rule: matched.rule,
          text: sel.text,
          simple: canon.simple,
          state: stateOf(canon.pseudoClasses),
          specificity: sel.specificity,
          inContext,
        }))
      } else if (!complexSpec || compareSpecificity(sel.specificity, complexSpec) > 0) {
        complexSpec = sel.specificity
      }
    }
    if (complexSpec) {
      const canon = canonicalCompound(matched.rule.selectorText)
      addChip(listMatchedSelectorsCandidate({
        rule: matched.rule,
        text: matched.rule.selectorText,
        simple: false,
        state: stateOf(canon.pseudoClasses),
        specificity: complexSpec,
        inContext,
      }))
    }
  }
  return [...byKey.values()].sort(
    (a, b) => compareSpecificity(a.specificity, b.specificity) || a.text.localeCompare(b.text),
  )
}

export function resolveStyle(
  model: RuleModel,
  context: ContextKey,
  activeSelector: string,
  native?: NativeResolveInput,
): ResolvedStyle {
  const all = [...model.base, ...model.conditional]

  // The panel views ONE interaction state and ONE pseudo-element target at a time,
  // both derived from the active selector: `.a:hover` → hover state, `.a::before` →
  // the ::before box. Picking a `::before` chip shows only that box's styles (not the
  // element's); picking the element (no pseudo-element) hides `::before`/`::after`.
  const activeCanon = canonicalCompound(activeSelector)
  const state = stateOf(activeCanon.pseudoClasses)
  const activePseudo = activeCanon.pseudoElement

  // Distinct contexts (Base first, others in first-appearance order).
  const contexts: ContextKey[] = []
  for (const matched of all) {
    const key = contextKeyOf(matched.rule)
    if (!contexts.includes(key)) {contexts.push(key)}
  }
  contexts.sort((a, b) => (a === '' ? -1 : b === '' ? 1 : 0))

  const byProp = new Map<string, Contributor[]>()
  let selectedRule: ParsedRule | null = null

  for (const matched of all) {
    const ruleCtx = contextKeyOf(matched.rule)
    // Show the current context's OWN rules plus the ones it inherits from — base ('')
    // and any ancestor query it nests inside — so a query view surfaces the base styles
    // it builds on (as inherited/orange), not only its own overrides. Mirrors how a
    // Webflow breakpoint shows wider-breakpoint values. Sibling queries don't apply.
    const atContext = ruleCtx === context
    const inherited = !atContext && (ruleCtx === '' || context.startsWith(`${ruleCtx} › `))
    if (!atContext && !inherited) {continue}

    // Pick this rule's strongest selector that applies in the view state: the base
    // state ('') always applies, and under a :hover/… view the state's own selectors
    // apply on top — so both fold in (base shows as inherited/orange). Other
    // interaction states (viewing :hover → a :focus rule) don't apply.
    let best: { text: string; specificity: Specificity; simple: boolean; tokens: string[] } | null = null
    for (const sel of matched.matchedSelectors) {
      // Only fold selectors targeting the SAME pseudo-element box as the view: the
      // element itself ('') hides `::before`/`::after`, and a `::before` view shows
      // only `::before` selectors.
      if (normalizePseudoElement(sel.pseudoElement) !== activePseudo) {continue}
      const canon = canonicalCompound(sel.text)
      const selState = stateOf(canon.pseudoClasses)
      if (selState !== '' && selState !== state) {continue}
      if (!best || compareSpecificity(sel.specificity, best.specificity) > 0) {
        best = { text: sel.text, specificity: sel.specificity, simple: canon.simple, tokens: canon.tokens }
      }
    }
    if (!best) {continue}

    // A rule is "selected" (blue, editable) when it carries a matched selector — in
    // the active state — equal to the active selector (by selector identity: `.a.b`
    // == `.b.a`, complex by text). This is NOT scoped to the source dropdown: the
    // dropdown only picks where NEW styles go, while an existing rule is edited in
    // whichever embed it already lives in (selectedRule carries that embed). So the
    // active selector shows blue regardless of which embed defines it.
    // Also selected when the active selector IS this rule's full grouped selector —
    // that's the single chip we show for a rule of complex (non-splittable) selectors.
    // Only a rule IN the current context is editable-here (blue) / the selectedRule.
    // An inherited (base/ancestor) rule shows as orange; editing it creates an override
    // in the current context rather than mutating the inherited rule.
    const isSelected = atContext && (
      selectorsMatch(matched.rule.selectorText, activeSelector) ||
      matched.matchedSelectors.some((sel) =>
        normalizePseudoElement(sel.pseudoElement) === activePseudo &&
        stateOf(canonicalCompound(sel.text).pseudoClasses) === state &&
        selectorsMatch(sel.text, activeSelector)))
    if (isSelected && !selectedRule) {selectedRule = matched.rule}

    // One contributor per (rule, prop) — the last decl wins within a rule.
    const lastByProp = new Map<string, { value: string; important: boolean }>()
    for (const decl of matched.rule.declarations) {
      lastByProp.set(decl.prop, { value: decl.value, important: decl.important })
    }
    lastByProp.forEach((decl, prop) => {
      const list = byProp.get(prop) ?? []
      list.push({
        selectorText: best!.text,
        value: decl.value,
        important: decl.important,
        specificity: best!.specificity,
        order: matched.rule.order,
        ruleId: matched.rule.ruleId,
        origin: 'embed',
        embedKey: matched.rule.embedKey,
        embedLabel: matched.rule.embedLabel,
        fromComponent: matched.rule.fromComponent,
        isSelected,
        winning: false,
        complexOnly: !best!.simple,
      })
      byProp.set(prop, list)
    })
  }

  // Fold native Webflow class-style values in as extra contributors. They carry a
  // class-chain specificity (combos outrank the base class) and sort before embed
  // rules on a cascade tie (embed CSS is injected after Webflow's stylesheet).
  // Skip them entirely for a pseudo-element view — native class styles belong to the
  // element, not its generated `::before`/`::after` box.
  const source = native?.source ?? 'embed'
  for (const nc of activePseudo ? [] : native?.contribs ?? []) {
    const list = byProp.get(nc.prop) ?? []
    list.push({
      selectorText: nc.selector,
      value: nc.value,
      important: false,
      specificity: [0, nc.classDepth, 0],
      // A narrower breakpoint's value (higher bpTier) wins the same-specificity
      // tie over the inherited base value; both stay below any embed rule.
      order: NATIVE_ORDER_BASE + nc.bpTier * 1_000 + nc.styleIndex,
      ruleId: `native:${nc.styleIndex}:${nc.bpTier}:${nc.atState ? 's' : 'b'}:${nc.prop}`,
      origin: 'native',
      styleIndex: nc.styleIndex,
      bpTier: nc.bpTier,
      atState: nc.atState,
      isSelected: false,
      winning: false,
      complexOnly: false,
    })
    byProp.set(nc.prop, list)
  }

  const props = new Map<string, ResolvedProp>()
  byProp.forEach((list, prop) => {
    list.sort((a, b) => compareCascade(a, b, a.order, b.order))
    const winner = list[0]
    if (winner === undefined) {
      throw new Error(`Resolved style invariant failed: ${prop} has no contributors`)
    }
    winner.winning = true
    // The editable (blue) contributor depends on the chosen source: the picked
    // native style when editing natively, else the picked embed selector. A native
    // value only counts as "set here" at the current breakpoint tier — a value
    // carried down from a wider breakpoint stays orange (inherited).
    // Native-first, embed-fallback: when editing natively, the picked native
    // style is the editable value; but if it doesn't set this prop, the picked
    // embed's value (a fallback write, or a pre-existing embed rule) is editable
    // too. In embed-only mode (no native layer) the picked embed is the target.
    // A native value is editable-here only at the current breakpoint tier AND the
    // view's interaction state — a base-state value shown under a :hover view is
    // inherited (orange), and editing it creates the :hover override.
    const nativeSelected = list.find((c) => c.origin === 'native' && c.styleIndex === native?.selectedIndex
      && (native?.currentTier == null || c.bpTier === native.currentTier) && c.atState !== false)
    const embedSelected = list.find((c) => c.origin === 'embed' && c.isSelected)
    const selected = source === 'native' ? (nativeSelected ?? embedSelected) : embedSelected
    // Mark the contributor whose value is the one being edited (the picked selector's)
    // so the provenance list can highlight it rather than the cascade winner.
    if (selected) {selected.editing = true}
    props.set(prop, {
      prop,
      source: selected ? 'selected' : 'other',
      ...(selected === undefined ? {} : { selectedOrigin: selected.origin }),
      ...(selected === undefined
        ? {}
        : { selectedValue: { value: selected.value, important: selected.important } }),
      winner,
      // The picked selector sets it, but a more specific selector wins the cascade.
      overridden: selected !== undefined && winner !== selected,
      contributors: list,
    })
  })

  return { props, selectedRule, contexts, states: STATES }
}
