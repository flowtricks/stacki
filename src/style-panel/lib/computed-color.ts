// What a colour value actually looks like, on the element it applies to.
//
// A swatch used to paint the value straight into the panel's own DOM, which
// works for `#c6fb50` and fails for everything that depends on where it lives:
// `var(--background)` is not defined in the app's document, so it painted
// nothing (a transparent chequerboard), and `color-mix(in srgb, var(--brand)
// 20%, transparent)` the same. Worse, those values are not even constant —
// the same variable resolves differently under a theme class, a colour scheme
// or a container query, so there is no static answer to look up.
//
// So the page is asked. The canvas resolves the value against the selected
// element (see the `compute` half of avb:query) and hands back the computed
// colour, which is what the swatch paints.

import { useEffect, useState } from 'react'
import { hasCanvas, queryCanvas } from '../../canvasQuery.js'
import { getHost, onHostChange } from './host'

/**
 * Does this value need the page to resolve it?
 *
 * Anything referring to something outside itself: a custom property, a
 * function whose arguments may hold one, or a keyword that means "whatever
 * this element inherits". A literal colour is painted as-is — no round trip
 * for `#fff`.
 */
export function needsPage(value: string): boolean {
  const v = String(value ?? '').trim().toLowerCase()
  if (!v) return false
  return (
    v.includes('var(') ||
    v.includes('color-mix(') ||
    v.includes('light-dark(') ||
    v.includes('currentcolor') ||
    v.startsWith('--')
  )
}

// Answers already given, so a panel full of swatches asks once per value and a
// re-render costs nothing. Keyed by the element asked about as well as the
// value: the same `var(--background)` is a different colour on two elements.
const answers = new Map<string, string | null>()
const inFlight = new Map<string, Promise<string | null>>()

/** Forget everything: the page changed under us, so the answers may have too. */
export function forgetComputedColors(): void {
  answers.clear()
  inFlight.clear()
}

// The element to resolve against: whatever is selected, and the page itself
// when nothing is — which is where `:root`'s custom properties are declared.
// The variables panel has no selection to speak of and its swatches are as
// answerable as any other.
function pathOfSelection(): string {
  const host = getHost()
  return (host.selectedId ? host.pathOf?.(host.selectedId) : null) ?? ''
}

async function resolve(path: string, value: string): Promise<string | null> {
  const key = `${path}|${value}`
  if (answers.has(key)) return answers.get(key) ?? null
  const pending = inFlight.get(key)
  if (pending) return pending
  const ask = queryCanvas(path, [], [value]).then((answer: { computed?: Record<string, string | null> } | null) => {
    const computed = answer?.computed?.[value] ?? null
    answers.set(key, computed)
    inFlight.delete(key)
    return computed
  })
  inFlight.set(key, ask)
  return ask
}

/**
 * The colour to paint for `value`: the value itself when it stands alone, and
 * what the page computes it to when it doesn't. Returns the raw value until
 * the answer arrives, so a swatch never flashes empty on a re-render.
 */
export function useResolvedColor(value: string): string {
  const raw = String(value ?? '').trim()
  const [resolved, setResolved] = useState<string | null>(null)

  useEffect(() => {
    if (!needsPage(raw) || !hasCanvas()) {
      setResolved(null)
      return undefined
    }
    let live = true
    const ask = () => {
      const path = pathOfSelection()
      void resolve(path, raw).then((color) => {
        if (live) setResolved(color)
      })
    }
    ask()
    // The selection moves, or the page re-renders under it: ask again for the
    // element that is selected now.
    const off = onHostChange(ask)
    return () => {
      live = false
      off()
    }
  }, [raw])

  return resolved || raw
}
