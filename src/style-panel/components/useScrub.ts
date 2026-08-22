import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { caretAtX } from '../lib/caret-at-x'
import { findScrubTarget, hasScrubTarget, scrubNumber, stepModeOf } from '../lib/number-step'
import type { NumberRun, StepMode } from '../lib/number-step'

// Drag-to-change on a CSS value, on two surfaces:
//
//   • the field's LABEL — plain drag, no modifier, grabs the value's first number.
//   • the INPUT itself — Alt or Shift drag, grabs the number under the pointer, so
//     `0 2px 4px` gives you three independent handles. A plain drag there is left
//     alone: it still selects text, which is the only thing you can do with a caret.
//
// Steps match the arrow keys exactly (lib/number-step.ts): plain 1, Shift 10, Alt 0.1
// — rem 1/16 — read live off the drag, so releasing Alt mid-drag drops you to whole
// units. One step per screen pixel.
//
// Writes follow the same discipline as DragSlider: the field's own text repaints every
// animation frame (free), but the CSS write is throttled, because each one is a real
// postcss edit and a high-Hz mouse emits moves far faster than they can drain. The final
// value always commits on release, so nothing is lost to the throttle.

const DEAD_ZONE = 3 // px of travel before a press counts as a drag rather than a click
const PX_PER_STEP = 1
const WRITE_MS = 50

type Surface = 'input' | 'label'

type Drag = {
  pointerId: number
  startX: number
  /** The value as it was when the press landed; every frame recomputes from this. */
  base: string
  run: NumberRun
  mode: StepMode
  moved: boolean
  latestX: number
  raf: number | null
  lastWriteAt: number
  text: string
}

export type ScrubHandlers = {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void
  onLostPointerCapture: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerEnter: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerLeave: () => void
}

export default function useScrub({ value, disabled = false, onPreview, onInput, onCommit }: {
  /** The field's current text. The scrub rewrites exactly this string. */
  value: string
  disabled?: boolean
  /** Every frame of the drag — for the field's own text only, never a write. */
  onPreview?: (text: string) => void
  /** Throttled during the drag: the live (preview-only) CSS write. Omit it on a field
   *  that has no preview channel — the drag then shows in the field and lands on the
   *  canvas once, at release, rather than writing for real at pointer speed. */
  onInput?: (text: string) => void
  /** Once, on release, with the final text: the authoritative write. */
  onCommit: (text: string) => void
}): { input: ScrubHandlers; label: ScrubHandlers } {
  // The pointer handlers outlive the render that installed them, so read callbacks and
  // the value through refs rather than closing over a stale render's copies.
  const valueRef = useRef(value); valueRef.current = value
  const disabledRef = useRef(disabled); disabledRef.current = disabled
  const onPreviewRef = useRef(onPreview); onPreviewRef.current = onPreview
  const onInputRef = useRef(onInput); onInputRef.current = onInput
  const onCommitRef = useRef(onCommit); onCommitRef.current = onCommit

  const drag = useRef<Drag | null>(null)

  // Hover state for the ew-resize affordance. `armed` is what the cursor reflects: over a
  // label it's enough to be hovering a value with a number in it; over an input you also
  // have to be holding the modifier that would start the scrub.
  const hoverEl = useRef<HTMLElement | null>(null)
  const hoverSurface = useRef<Surface>('input')
  const [hovering, setHovering] = useState(false)
  const [modifierHeld, setModifierHeld] = useState(false)

  const frame = useCallback(() => {
    const d = drag.current
    if (!d) return
    d.raf = null
    const steps = Math.round((d.latestX - d.startX) / PX_PER_STEP)
    const text = scrubNumber(d.base, d.run, steps, d.mode)
    if (text === d.text) return
    d.text = text
    onPreviewRef.current?.(text)
    const now = performance.now()
    if (now - d.lastWriteAt >= WRITE_MS) {
      d.lastWriteAt = now
      onInputRef.current?.(text)
    }
  }, [])

  const finish = useCallback(() => {
    const d = drag.current
    if (!d) return
    drag.current = null
    if (d.raf != null) cancelAnimationFrame(d.raf)
    document.body.classList.remove('is-scrubbing')
    if (!d.moved) return // never crossed the dead zone: it was a click, leave it be
    // The press that ended a drag must not also register as a click — on a label that
    // would pop the reset menu open the moment you let go.
    const swallow = (event: MouseEvent) => { event.preventDefault(); event.stopPropagation() }
    window.addEventListener('click', swallow, { capture: true, once: true })
    window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
    onCommitRef.current(d.text)
  }, [])

  // A drag can outlive its field — a commit elsewhere may re-render the section away.
  useEffect(() => finish, [finish])

  const begin = useCallback((event: ReactPointerEvent<HTMLElement>, base: string, run: NumberRun) => {
    if (drag.current) return // a second pointer (touch) must not hijack the one in flight
    // Capture so the drag survives leaving the field — and so pointerup still lands here
    // when the pointer is released halfway across the window.
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      base,
      run,
      mode: stepModeOf(event),
      moved: false,
      latestX: event.clientX,
      raf: null,
      lastWriteAt: performance.now(),
      text: base,
    }
  }, [])

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d || event.pointerId !== d.pointerId) return
    d.latestX = event.clientX
    d.mode = stepModeOf(event)
    if (!d.moved) {
      if (Math.abs(event.clientX - d.startX) < DEAD_ZONE) return
      d.moved = true
      // One class on <body> beats a per-drag <style> tag: the cursor has to win over
      // every element the pointer crosses, including the ones it's captured away from.
      document.body.classList.add('is-scrubbing')
    }
    if (d.raf == null) d.raf = requestAnimationFrame(frame)
  }, [frame])

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d || event.pointerId !== d.pointerId) return
    // Land on where the pointer actually was released, not on the last frame we drew.
    if (d.moved) {
      d.latestX = event.clientX
      if (d.raf != null) { cancelAnimationFrame(d.raf); d.raf = null }
      frame()
    }
    finish()
  }, [finish, frame])

  const enter = useCallback((surface: Surface, event: ReactPointerEvent<HTMLElement>) => {
    hoverEl.current = event.currentTarget
    hoverSurface.current = surface
    setModifierHeld(event.altKey || event.shiftKey)
    setHovering(true)
  }, [])
  const onInputPointerEnter = useCallback((event: ReactPointerEvent<HTMLElement>) => enter('input', event), [enter])
  const onLabelPointerEnter = useCallback((event: ReactPointerEvent<HTMLElement>) => enter('label', event), [enter])

  const onPointerLeave = useCallback(() => {
    hoverEl.current = null
    setHovering(false)
  }, [])

  // Only the hovered field listens for the modifier, so pressing Alt anywhere else in the
  // app costs nothing — with a few dozen fields on screen, always-on listeners wouldn't.
  useEffect(() => {
    if (!hovering || hoverSurface.current === 'label') return
    const sync = (event: KeyboardEvent) => setModifierHeld(event.altKey || event.shiftKey)
    window.addEventListener('keydown', sync)
    window.addEventListener('keyup', sync)
    return () => {
      window.removeEventListener('keydown', sync)
      window.removeEventListener('keyup', sync)
    }
  }, [hovering])

  // Set the cursor on the element itself rather than through a class the caller has to
  // merge into its own className — every field would otherwise pay for the plumbing.
  useEffect(() => {
    const el = hoverEl.current
    if (!el || !hovering) return
    const armed = !disabled && hasScrubTarget(valueRef.current)
      && (hoverSurface.current === 'label' || modifierHeld)
    el.style.cursor = armed ? 'ew-resize' : ''
    return () => { el.style.cursor = '' }
  }, [hovering, modifierHeld, disabled, value])

  const onInputPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (disabledRef.current || event.button !== 0) return
    if (!event.altKey && !event.shiftKey) return // a bare drag is still a text selection
    const el = event.currentTarget as HTMLInputElement | HTMLTextAreaElement
    if (typeof el.value !== 'string') return
    const run = findScrubTarget(el.value, caretAtX(el, event.clientX))
    if (!run) return
    // Stops the caret from moving and the selection from starting. It also drops the
    // click, which is fine: a modifier-click on a value field means nothing else.
    event.preventDefault()
    begin(event, el.value, run)
  }, [begin])

  const onLabelPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (disabledRef.current || event.button !== 0) return
    const run = findScrubTarget(valueRef.current, 0)
    if (!run) return
    // Deliberately no preventDefault: a press that never turns into a drag has to reach
    // the label as a click and open its reset menu. Text selection is handled instead by
    // the body class, which lands the moment the dead zone is crossed.
    begin(event, valueRef.current, run)
  }, [begin])

  const shared = { onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onLostPointerCapture: onPointerUp, onPointerLeave }
  return {
    input: { ...shared, onPointerDown: onInputPointerDown, onPointerEnter: onInputPointerEnter },
    label: { ...shared, onPointerDown: onLabelPointerDown, onPointerEnter: onLabelPointerEnter },
  }
}
