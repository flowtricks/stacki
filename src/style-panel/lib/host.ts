// The app state the style panel reads.
//
// EmbedEditor takes no props — in moden it read the Webflow Designer through
// an ambient global. The same shape works here: App pushes the current
// project, page model and selection in, and the adapter below (webflow.ts)
// answers the panel's questions from it. One panel, one selection, so a
// module-level record is enough.

export type HostNode = {
  id: string
  kind: string
  name?: string
  props?: Record<string, { type: string; value?: string } | null>
  children?: HostNode[] | null
  inner?: string
}

/** Which sides of which box the spacing control is pointing at, and what each
 *  one says — the label is the authored value ("4.8rem"), not the pixels. */
export type SpacingHover = {
  kind: 'padding' | 'margin'
  sides: Array<'top' | 'right' | 'bottom' | 'left'>
  labels: Record<string, string>
}

export type HostState = {
  projectPath: string | null
  /** The page (or open component) being edited. */
  nodes: HostNode[]
  selectedId: string | null
  /** Canvas breakpoint: desktop | tablet | phone. */
  device: string
  /** Stylesheets in the project, from style:listFiles. */
  files: Array<{ rel: string; name: string; path: string; size: number }>
  /** Component files holding a `<style is:global>` block, from
   *  style:listAstroStyles. Their rules reach the whole page, so they belong to
   *  the cascade even when the selection came from another file. */
  astroFiles: Array<{ rel: string; name: string; path: string; size: number }>
  /** Absolute path of the file being edited — its own <style> blocks come from
   *  the model, so it must not also be read off disk. */
  openFilePath: string | null
  /**
   * Bumped by the app whenever undo or redo runs. The panel reads its rules
   * from files and from the page model, and an undo rewrites both behind its
   * back: without a nudge it kept showing what it had cached until its own
   * background refresh came round (throttled to seconds), so the canvas moved
   * and the panel followed late.
   */
  historyTick: number
  /**
   * Classes the SELECTED element actually carries on the page, reported by the
   * preview. `class:list={[…]}` and `class={expr}` are expressions — the source
   * holds no class text — so this is the only way to know what a given instance
   * resolved to. Empty when nothing is selected or the node isn't rendered.
   */
  renderedClasses: string[]
  /** Write a <style> node's CSS back into the page model. `immediate` saves the page
   *  right away (a committed edit) instead of coalescing like a typing burst. */
  /** Writes a <style> node's text into the open file's model. Returns false when
   *  that node isn't in the file currently open (a page's block while a component
   *  is being edited) — the panel then keeps the edit and flushes it on exit
   *  rather than reporting a save that never happened. */
  writeStyleNode: ((nodeId: string, css: string, immediate?: boolean) => boolean | void) | null
  /** Select a node in the app (used when navigating from a provenance chip). */
  selectNode: ((nodeId: string) => void) | null
  /** Put a class on the selected element. Typing a bare class in the selector
   *  box should land it on the element, the way a class field would — a rule
   *  for a class the element doesn't carry would never apply. */
  addClass: ((className: string) => void) | null
  /** What the spacing box is pointing at, for the canvas to draw over the
   *  selected element: hovering `padding-top` lights the strip of the page that
   *  padding-top holds open. Null when the pointer leaves it. */
  onSpacingHover: ((hover: SpacingHover | null) => void) | null
  /**
   * A node's path in the rendered page (`0.1.2`), which is how the canvas
   * addresses elements. Lets the panel ask the real DOM about the selected
   * element instead of inferring it from the source tree.
   */
  pathOf: ((nodeId: string) => string | null) | null
  /** Record an already-applied change on the app's undo stack. Stylesheet edits
   *  don't go through the page model, so without this ⌘Z would skip straight
   *  past them to the last layout change. */
  recordUndo: ((cmd: UndoCommand) => void) | null
}

export type UndoCommand = {
  label?: string
  /** Edits sharing a key inside one burst collapse into a single step. */
  coalesceKey?: string | null
  undo: () => void | Promise<void>
  redo: () => void | Promise<void>
}

const state: HostState = {
  projectPath: null,
  nodes: [],
  selectedId: null,
  pathOf: null,
  historyTick: 0,
  device: 'desktop',
  files: [],
  astroFiles: [],
  openFilePath: null,
  renderedClasses: [],
  writeStyleNode: null,
  selectNode: null,
  recordUndo: null,
  addClass: null,
  onSpacingHover: null,
}

const listeners = new Set<() => void>()

export function setHost(patch: Partial<HostState>) {
  let changed = false
  for (const [k, v] of Object.entries(patch)) {
    if ((state as Record<string, unknown>)[k] !== v) {
      ;(state as Record<string, unknown>)[k] = v
      changed = true
    }
  }
  if (changed) for (const fn of listeners) fn()
}

export function getHost(): HostState {
  return state
}

export function onHostChange(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// Depth-first walk of the page model.
export function walkNodes(
  nodes: HostNode[] | null | undefined,
  visit: (node: HostNode, parent: HostNode | null) => void,
  parent: HostNode | null = null,
) {
  for (const n of nodes || []) {
    visit(n, parent)
    if (Array.isArray(n.children)) walkNodes(n.children, visit, n)
  }
}

export function findNode(nodes: HostNode[] | null | undefined, id: string): HostNode | null {
  let found: HostNode | null = null
  walkNodes(nodes, (n) => {
    if (!found && n.id === id) found = n
  })
  return found
}

// A prop's literal string value, or '' for expressions and bare attributes —
// the panel matches selectors against text, and `class={x}` has no text.
export function propText(node: HostNode | null | undefined, name: string): string {
  const p = node?.props?.[name]
  if (!p || p.type !== 'string') return ''
  return String(p.value ?? '')
}
