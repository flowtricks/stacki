// Turn a selected element's identity into pickable tokens: its HTML tag (first),
// then its classes, then its data attributes — the set of things an embed
// selector can target. Used by the header ClassPicker.

import type { ClassToken } from '../components/ClassPicker'
import type { ElementSnapshot } from './types'
import { webflowClassToCss } from './webflow'

/** Build ordered tokens (tag → classes → data attributes) from a snapshot. */
export function snapshotTokens(snapshot: ElementSnapshot | undefined): ClassToken[] {
  if (!snapshot) return []
  const tokens: ClassToken[] = []

  // Tag first — when there is one. A component instance renders markup this
  // side can't see, so it has no tag of its own, and the node's KIND is not a
  // substitute: `component.card` is a selector for a `<component>` element,
  // which no page has. Such an element is matched by its classes alone.
  const tag = snapshot.tag
  if (tag) tokens.push({ name: `tag:${tag}`, label: tag, kind: 'tag' })

  // Then classes, in element order — each shown in its Webflow CSS form (`Div Block`
  // → `div-block`), de-duplicated. The snapshot keeps both the raw display name and
  // the CSS name to bridge matching; a chip must show ONE formatted class, never the
  // raw name (which would also compose an invalid selector like `.Div Block`).
  const seen = new Set<string>()
  snapshot.classes.forEach((cls) => {
    const compiled = webflowClassToCss(cls)
    if (!compiled || seen.has(compiled)) return
    seen.add(compiled)
    tokens.push({ name: `class:${compiled}`, label: compiled, kind: 'class' })
  })

  // Then data attributes, sorted for stability.
  Object.keys(snapshot.attributes)
    .filter((key) => key.startsWith('data-'))
    .sort()
    .forEach((key) => tokens.push({ name: `attr:${key}`, label: key, kind: 'attribute' }))

  return tokens
}

/**
 * The class tokens (from `tokens`, in token order) named by a selector's subject
 * compound — the inverse of tokensToSelector for class selectors. Returns null
 * when the selector isn't a plain class chain on this element (has a class the
 * element lacks, or no classes at all), so the caller can leave the pick alone.
 */
export function selectorToClassTokens(selectorText: string, tokens: ClassToken[]): string[] | null {
  // The subject is the last compound (after any descendant / combinator).
  const subject = selectorText.split(/\s+|[>+~]/).filter(Boolean).pop() ?? ''
  const wanted = new Set([...subject.matchAll(/\.([\w-]+)/g)].map((m) => m[1].toLowerCase()))
  if (!wanted.size) return null
  const picked: string[] = []
  const matched = new Set<string>()
  for (const token of tokens) {
    if (token.kind !== 'class') continue
    const compiled = webflowClassToCss(token.label ?? token.name.slice('class:'.length))
    if (wanted.has(compiled)) {
      picked.push(token.name)
      matched.add(compiled)
    }
  }
  // Every class the selector names must exist on the element, or we can't select it.
  return matched.size === wanted.size && picked.length ? picked : null
}

/**
 * Which tokens a newly selected element is styled through, before anyone picks:
 * its FIRST class, else its last data attribute, else its tag.
 *
 * The first class, not all of them. Every class joined is Webflow's model, where
 * a combo is itself a thing to style — but writing CSS to a file it means the
 * first property set on an element creates
 * `.layout.card.theme-dark.flex-grow.theme-brand { … }`, and since the combo
 * then counts as a styled selector, everything after it lands there too: a rule
 * of five classes that nothing else can reuse, assembled a property at a time
 * from a default nobody chose. A combo is a deliberate act; it takes picking
 * that chip.
 */
export function defaultSelectorTokens(tokens: ClassToken[]): string[] {
  const classes = tokens.filter((token) => token.kind === 'class')
  if (classes.length) return [classes[0].name]
  const attrs = tokens.filter((token) => token.kind === 'attribute')
  if (attrs.length) return [attrs[attrs.length - 1].name]
  return tokens.length ? [tokens[0].name] : []
}

/** Compose a CSS selector from selected token names, honoring token order. */
export function tokensToSelector(selectedNames: string[], tokens: ClassToken[]): string {
  let selector = ''
  for (const token of tokens) {
    if (!selectedNames.includes(token.name)) continue
    const label = token.label ?? token.name
    if (token.kind === 'tag') selector += label
    else if (token.kind === 'attribute') selector += `[${label}]`
    else selector += `.${label}`
  }
  return selector
}
