// What a control shows when nothing in the panel sets its property.
//
// The resolved model only knows what the project's CSS declares. A control whose
// property nobody declares still isn't showing nothing on the page: `pointer-events`
// may be `none` because a parent set it, `text-align` may be `center` from a `*` rule
// the panel's matcher can't see past a component edge, and `display` is whatever the
// user-agent stylesheet says for that tag. Guessing the CSS initial value gets all
// three wrong.
//
// So the page is asked, the same way colours are (see computed-color.ts): the canvas
// runs getComputedStyle on the selected element and hands back the values. Controls
// use it to HIGHLIGHT an option — never to claim the property is set, which stays the
// resolved model's call (the label is dim either way).

import { useEffect, useState } from 'react'
import { hasCanvas, queryCanvas } from '../../canvasQuery.js'
import { findNode, getHost, onHostChange } from './host'

type Answers = Record<string, string>

// path → the computed values already fetched for it. Cleared whenever the page
// re-renders, since anything inherited may have moved with it.
const answers = new Map<string, Answers>()
// Properties asked for since the last flush, batched so a panel full of controls
// costs one round trip instead of thirty.
let queued = new Set<string>()
let flushing: number | null = null
const listeners = new Set<() => void>()

/** Forget everything: the page changed under us, so the answers may have too. */
export function forgetComputedStyles(): void {
  answers.clear()
  notify()
}

function notify() {
  for (const fn of listeners) fn()
}

function pathOfSelection(): string | null {
  const host = getHost()
  return host.selectedId ? host.pathOf?.(host.selectedId) ?? null : null
}

// The selected node's HTML tag, when it has one. A component instance's name is its
// component ('Card'), which says nothing about the tag it renders, so only a plain
// lowercase name counts — those are the ones a rendered tag can be checked against.
function selectedTag(): string | null {
  const host = getHost()
  const node = host.selectedId ? findNode(host.nodes, host.selectedId) : null
  if (node?.kind !== 'element') return null
  const name = node.name ?? ''
  return /^[a-z][a-z0-9-]*$/.test(name) ? name : null
}

/** The element the page measured, per path — surfaced in the label tooltips. */
const measured = new Map<string, string>()

function flush(path: string) {
  const props = [...queued]
  queued = new Set()
  flushing = null
  if (!props.length) return
  const expected = selectedTag()
  void queryCanvas(path, [], [], props).then((answer: { computedProps?: Record<string, string | null>; identity?: { tag?: string } } | null) => {
    if (!answer?.computedProps) return
    // Only trust values read off the element we asked about. If the page resolved
    // that path to a different tag, the answer describes something else — showing it
    // as this control's default would be worse than showing nothing.
    const tag = answer.identity?.tag ?? ''
    if (tag) measured.set(path, tag)
    if (tag && expected && tag !== expected) return
    const next: Answers = { ...(answers.get(path) ?? {}) }
    let changed = false
    for (const [prop, value] of Object.entries(answer.computedProps)) {
      const v = (value ?? '').trim()
      if (v && next[prop] !== v) { next[prop] = v; changed = true }
    }
    if (!changed) return
    answers.set(path, next)
    notify()
  })
}

function request(path: string, prop: string) {
  if (answers.get(path)?.[prop] != null) return
  queued.add(prop)
  // A microtask would batch only one component's render; a timeout of 0 catches the
  // whole panel's pass, which is what makes this one query instead of thirty.
  if (flushing == null) flushing = window.setTimeout(() => flush(path), 0)
}

/**
 * The selected element's computed value for `prop` — '' until the page answers (or
 * forever, when there's no canvas to ask). Pass '' to skip asking entirely, so a
 * control that already has an authored value costs nothing.
 */
export function useComputedValue(prop: string): string {
  const [value, setValue] = useState('')

  useEffect(() => {
    if (!prop) { setValue(''); return undefined }
    let live = true
    const sync = () => {
      if (!live) return
      // `hasCanvas` is checked HERE, not once on mount: the panel can render before
      // the preview frame registers, and that first pass must not opt out for good.
      const path = hasCanvas() ? pathOfSelection() : null
      if (!path) { setValue(''); return }
      const known = answers.get(path)?.[prop]
      if (known != null) setValue(known)
      else { setValue(''); request(path, prop) }
    }
    sync()
    listeners.add(sync)
    // The selection moves, or the page re-renders under it: ask for the element
    // that's selected now.
    const off = onHostChange(sync)
    return () => {
      live = false
      listeners.delete(sync)
      off()
    }
  }, [prop])

  return value
}

/**
 * What the page says about `prop`, for the label tooltip: its computed value, the tag
 * of the element that was measured, and whether that element is the one selected.
 * A tooltip mounts fresh on hover, so reading the path here rather than subscribing
 * is enough.
 */
export function useComputedMeta(prop: string): { value: string; tag: string; mismatch: boolean } {
  const value = useComputedValue(prop)
  const path = pathOfSelection()
  const tag = (path && measured.get(path)) || ''
  const expected = selectedTag()
  return { value, tag, mismatch: Boolean(tag && expected && tag !== expected) }
}

/**
 * The computed value for `prop`, but only when it's one of `values` — the options
 * this control can actually highlight. Anything else ('normal' for a justify-content
 * the page never sets, a resolved `14px` for a keyword control) returns '', leaving
 * the control's own default in charge.
 */
export function useComputedChoice(prop: string, values: readonly string[]): string {
  const computed = useComputedValue(prop).toLowerCase()
  return computed && values.includes(computed) ? computed : ''
}
