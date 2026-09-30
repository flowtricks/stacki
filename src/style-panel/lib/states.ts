// The states a selector can be styled in, and the arithmetic around them.
//
// Webflow gives a class one dropdown — None, Hover, Pressed, Focused, … — and the
// class stays the same while the state changes: "Hover" on `.card` is the
// selector `.card:hover`, nothing more. This module is that dropdown's model,
// kept free of React so it can be tested and so the CSS matching code (which
// must agree on what counts as a state) can share the same list.
//
// A state is a suffix appended to the selector: a pseudo-class (`:hover`) that
// describes a moment of the element, or a pseudo-element (`::before`) that styles
// a box the element generates. Structural pseudo-classes with an argument
// (`:nth-child(odd)`) are listed too, but only as suffixes: the panel treats the
// resulting selector as a complex one, which keeps its full text.

export type StateGroup = 'interaction' | 'form' | 'position' | 'element'

export type StateDefinition = {
  /** The CSS suffix appended to the selector, e.g. `:hover` or `::before`. */
  readonly suffix: string
  readonly label: string
  readonly group: StateGroup
}

export const STATE_GROUP_LABEL: Readonly<Record<StateGroup, string>> = {
  interaction: 'Interaction',
  form: 'Form',
  position: 'Position',
  element: 'Pseudo-elements',
}

export const STATE_DEFINITIONS: readonly StateDefinition[] = [
  { suffix: ':hover', label: 'Hover', group: 'interaction' },
  { suffix: ':active', label: 'Pressed (active)', group: 'interaction' },
  { suffix: ':focus', label: 'Focused', group: 'interaction' },
  { suffix: ':focus-visible', label: 'Focus visible', group: 'interaction' },
  { suffix: ':focus-within', label: 'Focus within', group: 'interaction' },
  { suffix: ':visited', label: 'Visited', group: 'interaction' },
  { suffix: ':checked', label: 'Checked', group: 'form' },
  { suffix: ':disabled', label: 'Disabled', group: 'form' },
  { suffix: ':required', label: 'Required', group: 'form' },
  { suffix: ':optional', label: 'Optional', group: 'form' },
  { suffix: ':empty', label: 'Empty', group: 'form' },
  { suffix: ':first-child', label: 'First item', group: 'position' },
  { suffix: ':last-child', label: 'Last item', group: 'position' },
  { suffix: ':nth-child(odd)', label: 'Odd items', group: 'position' },
  { suffix: ':nth-child(even)', label: 'Even items', group: 'position' },
  { suffix: '::before', label: 'Before', group: 'element' },
  { suffix: '::after', label: 'After', group: 'element' },
  { suffix: '::placeholder', label: 'Placeholder', group: 'element' },
  { suffix: '::selection', label: 'Selection', group: 'element' },
  { suffix: '::marker', label: 'Marker', group: 'element' },
  { suffix: '::first-line', label: 'First line', group: 'element' },
  { suffix: '::first-letter', label: 'First letter', group: 'element' },
]

/**
 * The pseudo-classes the panel treats as a VIEW STATE: viewing one shows its own
 * rules on top of the resting ones, and a rule carrying it is not part of the
 * resting view. Only dynamic and form states qualify. Position pseudo-classes are
 * decided by where the element sits in the tree, not by a moment, so the matcher
 * already resolves them statically and they stay part of the resting view.
 */
export const VIEW_STATE_PSEUDO_CLASSES = [
  ':hover',
  ':active',
  ':focus',
  ':focus-visible',
  ':focus-within',
  ':visited',
  ':checked',
  ':disabled',
  ':required',
  ':optional',
] as const

export type ViewStatePseudoClass = (typeof VIEW_STATE_PSEUDO_CLASSES)[number]

const VIEW_STATE_SET: ReadonlySet<string> = new Set(VIEW_STATE_PSEUDO_CLASSES)

export function isViewStatePseudoClass(value: string): value is ViewStatePseudoClass {
  return VIEW_STATE_SET.has(value)
}

// Longest suffix first, so `:focus-visible` is never read as `:focus`.
const SUFFIXES_LONGEST_FIRST: readonly string[] = STATE_DEFINITIONS.map(
  (definition) => definition.suffix,
).sort((left, right) => right.length - left.length)

export type StateSplit = {
  /** The selector without its trailing state, e.g. `.card`. */
  readonly base: string
  /** The trailing state suffix, or '' when the selector is at rest. */
  readonly suffix: string
}

/**
 * Splits a selector into what it selects and the state it selects it in.
 * Only one trailing state is peeled off: `.a:hover` is (`.a`, `:hover`), and
 * `.a:hover:focus` is (`.a:hover`, `:focus`) — the last thing written is the
 * one the dropdown shows and replaces.
 */
export function splitState(selector: string): StateSplit {
  const text = selector.trim()
  for (const suffix of SUFFIXES_LONGEST_FIRST) {
    if (text.length > suffix.length && text.endsWith(suffix)) {
      return { base: text.slice(0, text.length - suffix.length), suffix }
    }
  }
  return { base: text, suffix: '' }
}

/** The selector for `base` in the state `suffix` ('' → at rest). */
export function withState(base: string, suffix: string): string {
  return `${base.trim()}${suffix}`
}

/** The definition for a suffix, or undefined for '' and for anything unlisted. */
export function stateDefinition(suffix: string): StateDefinition | undefined {
  return STATE_DEFINITIONS.find((definition) => definition.suffix === suffix)
}
