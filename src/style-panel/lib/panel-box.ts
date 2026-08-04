// Where the panel ends.
//
// Popovers in this panel are absolutely positioned and right-anchored to their
// label, so a field in the left column pushes the menu's left edge past the
// panel edge. Every one of them clamps itself back inside — but they were
// written against moden, where `.app_body` is both the visible panel and the
// scroll container, and this app has neither: the panel is `.style-panel-host`
// wrapping `.embed-editor_root`, and that root is the scroller (overflow-y:
// auto, overflow-x: clip — see styles.css).
//
// Falling back to `document.documentElement` there was the bug: the menus were
// clamped to the WINDOW, so no shift was ever applied, and the panel's
// overflow-x clipped whatever hung past its edge.

/** The panel's visible box — what a popover must stay inside. */
export function panelBox(anchor: Element): HTMLElement | null {
  // `.app_body` first (moden), where `.embed-editor_root` is an inner box and
  // the wrong answer; `closest` on both at once would pick the nearer root.
  return (
    anchor.closest<HTMLElement>('.app_body') ??
    anchor.closest<HTMLElement>('.embed-editor_root') ??
    null
  )
}

/** That box's rect, or the window when the panel isn't found. */
export function panelBounds(anchor: Element): DOMRect {
  const el = panelBox(anchor)
  return (el ?? document.documentElement).getBoundingClientRect()
}

/**
 * The horizontal span a body-portaled popup should occupy.
 *
 * Several of these popups were written as `left: 0; right: 0` — full window,
 * which in moden WAS the panel. Here the panel is a right-hand column, so they
 * have to measure it. An anchor inside another portal (a control in a modal)
 * has no panel ancestor to walk to; the host publishes the panel's box as CSS
 * variables for that case (see StylePanel.jsx).
 */
export function panelSpan(anchor: Element): { left: number; width: number } {
  const el = panelBox(anchor)
  if (el) {
    const r = el.getBoundingClientRect()
    return { left: r.left, width: r.width }
  }
  const root = getComputedStyle(document.documentElement)
  const left = parseFloat(root.getPropertyValue('--style-panel-left'))
  const width = parseFloat(root.getPropertyValue('--style-panel-width'))
  if (Number.isFinite(left) && Number.isFinite(width) && width > 0) return { left, width }
  return { left: 0, width: window.innerWidth }
}
