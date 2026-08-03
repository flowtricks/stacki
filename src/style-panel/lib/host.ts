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

export type HostState = {
  projectPath: string | null
  /** The page (or open component) being edited. */
  nodes: HostNode[]
  selectedId: string | null
  /** Canvas breakpoint: desktop | tablet | phone. */
  device: string
  /** Stylesheets in the project, from style:listFiles. */
  files: Array<{ rel: string; name: string; path: string; size: number }>
  /**
   * Classes the SELECTED element actually carries on the page, reported by the
   * preview. `class:list={[…]}` and `class={expr}` are expressions — the source
   * holds no class text — so this is the only way to know what a given instance
   * resolved to. Empty when nothing is selected or the node isn't rendered.
   */
  renderedClasses: string[]
  /** Write a <style> node's CSS back into the page model. `immediate` saves the page
   *  right away (a committed edit) instead of coalescing like a typing burst. */
  writeStyleNode: ((nodeId: string, css: string, immediate?: boolean) => void) | null
  /** Select a node in the app (used when navigating from a provenance chip). */
  selectNode: ((nodeId: string) => void) | null
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
  device: 'desktop',
  files: [],
  renderedClasses: [],
  writeStyleNode: null,
  selectNode: null,
  recordUndo: null,
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
