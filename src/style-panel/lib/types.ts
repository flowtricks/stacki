// Shared data model for the Embed Editor.
//
// The tool treats every HtmlEmbed on the page (and inside every component used
// on the page) as a source of page-global CSS. We parse each embed's `<style>`
// blocks, match the rules against the currently-selected element, and surface
// the applied declarations like a style panel — annotated with the embed they
// come from.

import type { Root, Rule, Declaration as PostcssDeclaration } from 'postcss'

/** A `<style>...</style>` region located inside an embed's code string. */
export type StyleRegion = {
  /** Offset in the embed code where the inner CSS begins (just after `>`). */
  start: number
  /** Offset in the embed code where the inner CSS ends (just before `</style>`). */
  end: number
  css: string
  root: Root | null
  parseError?: string
  /** The region's opening tag verbatim (`<style is:global>`) — what tells a
   *  component's global block from a scoped one. */
  openTag?: string
}

/** Specificity tuple: [ids, classes/attrs/pseudo-classes, types/pseudo-elements]. */
export type Specificity = readonly [number, number, number]

/** One comma-separated selector within a rule's selector list. */
export type SelectorInfo = {
  /** Selector text as authored (trimmed). */
  text: string
  specificity: Specificity
  /** True when the selector carries a pseudo-class (`:hover`, `:focus`, …). */
  hasPseudoClass: boolean
  /** The pseudo-element (`::before`) if present, else null. */
  pseudoElement: string | null
  /** True when matching had to guess (e.g. sibling combinator we can't verify). */
  approximate: boolean
}

/** A parsed CSS rule, tied back to its live postcss node for editing. */
export type ParsedRule = {
  ruleId: string
  /** Document order across all embeds, ascending = earlier in the cascade. */
  order: number
  /** Serialized FullElementId of the owning embed. */
  embedKey: string
  embedLabel: string
  /** True when the embed lives in a component definition (shared across instances). */
  fromComponent: boolean
  componentName: string | null
  regionIndex: number
  node: Rule
  selectorText: string
  /** Nested-source display for a nested rule (`.hero {.title}`), else undefined —
   *  shown in the chip so nested code reads differently from a flat selector. */
  nestedDisplay?: string
  /** Nested display with an `@` marking the query's position (`.hero {@ .title}`),
   *  shown when viewing that query, else undefined. */
  queryDisplay?: string
  /** At-rule chain wrapping the rule, e.g. `['@media (max-width: 767px)']`. */
  atContext: string[]
  selectors: SelectorInfo[]
  declarations: ParsedDeclaration[]
}

export type ParsedDeclaration = {
  declId: string
  prop: string
  value: string
  important: boolean
  node: PostcssDeclaration
}

// ─────────────────────────── Native Webflow styles ───────────────────────────

/** Webflow's fixed breakpoint scale (mirrors the Designer's BreakpointId). */
export type BreakpointId = 'xxl' | 'xl' | 'large' | 'main' | 'medium' | 'small' | 'tiny'

/** One property value read off a native Webflow class style. */
export type NativeProp = {
  /** The literal value, or (for a variable-bound value) the variable's name. */
  value: string
  /** True when the value is bound to a Webflow Variable rather than a literal. */
  isVariable: boolean
}

/**
 * A native Webflow class style available to the selected element, read via the
 * Designer Style API. `applied` styles come from getStyles() — index 0 is the
 * base class and later indexes are combo classes (each representing the chain
 * classes[0..index]). `applied: false` styles are project-level classes the
 * element carries only through its `class` attribute (not the Styles panel), so
 * they're absent from getStyles() and matched by name instead.
 */
export type NativeStyle = {
  styleId: string
  /** Display name as shown in Webflow (e.g. "Hero Section"). */
  displayName: string
  /** Compiled CSS class name (e.g. "hero-section"). */
  className: string
  /** Position in NativeModel.styles — the identity used everywhere as its index. */
  index: number
  isCombo: boolean
  /** True when the style is applied via the Styles panel (present in getStyles()). */
  applied: boolean
  /** Display-name path to fetch a writable handle via getStyleByName: base → … →
   *  this class for applied combos; [displayName] for a standalone class. */
  namePath: string[]
  /** props keyed by `${breakpoint}|${state}` → prop → value. */
  propsByContext: Map<string, Map<string, NativeProp>>
  /** The live Designer Style handle, used for writes (loosely typed). */
  style: unknown
}

/** The native class styles applied to the current element. */
export type NativeModel = {
  styles: NativeStyle[]
  /** True when getStyles() actually returned (vs. a read failure / unsupported). */
  read: boolean
}

/** Identity of the selected element, used for selector matching. */
export type ElementSnapshot = {
  /** Resolved lowercase HTML tag, or null when unknown. */
  tag: string | null
  webflowType: string
  /** DOM id attribute, or null. */
  id: string | null
  /** CSS class tokens (compiled names + normalized display names). */
  classes: string[]
  /** Ordered compiled class list (primary first, then combos) for scaffolding. */
  classList: string[]
  /** Custom attributes plus synthesized `class`/`id` for attribute selectors. */
  attributes: Record<string, string>
}

