// The app state the style panel reads.
//
// EmbedEditor takes no props — in moden it read the Webflow Designer through
// an ambient global. The same shape works here: App pushes the current
// project, page model and selection in, and the adapter below (webflow.ts)
// answers the panel's questions from it. One panel, one selection, so a
// module-level record is enough.

import { assert } from '../../../../shared/core/assert';
import { LIMITS } from '../../../../shared/core/limits';

type HostAttr = { readonly type: string; readonly value?: string };

// A page node as the panel reads it: the panel never edits the tree (its
// class and style changes go through App's gestures), so the view is readonly.
export type HostNode = {
  readonly id: string;
  readonly kind: string;
  readonly name?: string;
  readonly value?: string;
  readonly props?: Readonly<Record<string, HostAttr>>;
  readonly children?: readonly HostNode[] | undefined;
  readonly inner?: string;
};

/** Which sides of which box the spacing control is pointing at, and what each
 *  one says — the label is the authored value ("4.8rem"), not the pixels. */
export type SpacingHover = {
  /** 'gap' lights the space BETWEEN children rather than around one element. */
  kind: 'padding' | 'margin' | 'gap';
  /** Edges for padding and margin; axes for gap. */
  sides: Array<'top' | 'right' | 'bottom' | 'left' | 'row' | 'column'>;
  labels: Record<string, string>;
  /** The values a drag is writing right now, per side, as authored ("4.8rem"):
   *  the canvas sizes the band from them on the frame the number changes,
   *  instead of waiting for the page to lay out and be measured. Absent outside
   *  a drag; the band is then the measured one. */
  live?: Record<string, string>;
};

/** What became of a class added to the page, for the rule that depends on it. */
/** A `<style>` node, named by the file it belongs to as well as its id: ids are
 * tree paths, so two files' blocks can share one. */
export type StyleNodeTarget = {
  readonly nodeId: string;
  readonly filePath: string | undefined;
};

export type ClassOutcome = { readonly tag: 'applied' } | { readonly tag: 'refused'; readonly message: string };

export type HostState = {
  projectPath: string | undefined;
  /** The page (or open component) being edited. */
  nodes: readonly HostNode[];
  selectedId: string | undefined;
  /** Canvas breakpoint: desktop | tablet | phone. */
  device: string;
  /** Stylesheets in the project, from style:listFiles. */
  files: Array<{ rel: string; name: string; path: string; size: number }>;
  /** Component files holding a `<style is:global>` block, from
   *  style:listAstroStyles. Their rules reach the whole page, so they belong to
   *  the cascade even when the selection came from another file. */
  astroFiles: Array<{ rel: string; name: string; path: string; size: number }>;
  /** Absolute path of the file being edited — its own <style> blocks come from
   *  the model, so it must not also be read off disk. */
  openFilePath: string | undefined;
  /** Whether the open editable file is a page or a component. Style nodes have
   *  the same model shape in both, so their provenance must be carried separately. */
  openFileKind: 'page' | 'component' | undefined;
  /** While a component is open, the page the canvas shows it on. Selectors of
   *  that page's scoped `<style>` written `:global(…)` reach the component's
   *  markup (src/app/model/componentStyles.ts), so they are in its cascade. */
  contextPagePath: string | undefined;
  /**
   * Bumped by the app whenever undo or redo runs. The panel reads its rules
   * from files and from the page model, and an undo rewrites both behind its
   * back: without a nudge it kept showing what it had cached until its own
   * background refresh came round (throttled to seconds), so the canvas moved
   * and the panel followed late.
   */
  historyTick: number;
  /**
   * Classes the SELECTED element actually carries on the page, reported by the
   * preview. `class:list={[…]}` and `class={expr}` are expressions — the source
   * holds no class text — so this is the only way to know what a given instance
   * resolved to. Empty when nothing is selected or the node isn't rendered.
   */
  renderedClasses: string[];
  /** Every class name used anywhere in the project (the same list the Settings
   *  panel's class field autocompletes from), for the selector input's suggestions. */
  projectClasses: string[];
  /** Write a <style> node's CSS back into the page model. `immediate` saves the page
   *  right away (a committed edit) instead of coalescing like a typing burst. */
  /** Writes a <style> node's text into the open file's model. Returns false when
   *  that node isn't in the file currently open (a page's block while a component
   *  is being edited) — the panel then keeps the edit and flushes it on exit
   *  rather than reporting a save that never happened. */
  writeStyleNode: ((target: StyleNodeTarget, css: string, immediate?: boolean) => boolean | void) | undefined;
  /** Select a node in the app (used when navigating from a provenance chip). */
  selectNode: ((nodeId: string) => void) | undefined;
  /** Put a class on the selected element. Typing a bare class in the selector
   *  box should land it on the element, the way a class field would — a rule
   *  for a class the element doesn't carry would never apply. Resolves once the
   *  page edit reached disk or was refused: the stylesheet rule for that class
   *  is written only after it applied (step 6, plan §3.3 — outcome-gated). */
  addClass: ((className: string) => Promise<ClassOutcome>) | undefined;
  /** What the spacing box is pointing at, for the canvas to draw over the
   *  selected element: hovering `padding-top` lights the strip of the page that
   *  padding-top holds open. Undefined when the pointer leaves it. */
  onSpacingHover: ((hover: SpacingHover | undefined) => void) | undefined;
  /**
   * A node's path in the rendered page (`0.1.2`), which is how the canvas
   * addresses elements. Lets the panel ask the real DOM about the selected
   * element instead of inferring it from the source tree.
   */
  pathOf: ((nodeId: string) => string | undefined) | undefined;
  /** Record an already-applied change on the app's undo stack. Stylesheet edits
   *  don't go through the page model, so without this ⌘Z would skip straight
   *  past them to the last layout change. */
  recordUndo: ((command: UndoCommand) => void) | undefined;
  /**
   * A ::before or ::after picked in the navigator: when its element is the
   * selection, the panel picks that pseudo-element's selector. `serial` makes
   * picking it again a new request.
   */
  pseudoRequest: PseudoRequest | undefined;
};

export type PseudoRequest = { readonly nodeId: string; readonly pseudo: 'before' | 'after'; readonly serial: number };

export type UndoCommand = {
  label?: string;
  /** Edits sharing a key inside one burst collapse into a single step. */
  coalesceKey?: string;
  undo: () => void | Promise<void>;
  redo: () => void | Promise<void>;
};

const state: HostState = {
  projectPath: undefined,
  nodes: [],
  selectedId: undefined,
  pathOf: undefined,
  historyTick: 0,
  device: 'desktop',
  files: [],
  astroFiles: [],
  openFilePath: undefined,
  openFileKind: undefined,
  contextPagePath: undefined,
  renderedClasses: [],
  projectClasses: [],
  writeStyleNode: undefined,
  selectNode: undefined,
  recordUndo: undefined,
  addClass: undefined,
  pseudoRequest: undefined,
  onSpacingHover: undefined,
};

const listeners = new Set<() => void>();

// Listeners are told on a microtask, not inline: the panel sets the host DURING its
// render (see StylePanel, which has to, so children don't mount against an empty
// bridge), and calling a subscriber there updates one component while another is
// rendering — exactly what React warns about. The state itself is written
// synchronously, so anything reading getHost() still sees it at once. Coalesced, so a
// render that patches several fields wakes subscribers once.
let notifying = false;
function notifyHost() {
  if (notifying) {
    return;
  }
  notifying = true;
  queueMicrotask(() => {
    notifying = false;
    for (const listener of listeners) {
      listener();
    }
  });
}

// A writer publishes the whole host at once, so no field can be left stale by a
// partial write (AGENTS.md §4). The object is updated in place because readers
// hold what `getHost()` returned for the length of a call.
export function setHost(next: Readonly<HostState>) {
  if (hostChanged(next)) {
    Object.assign(state, next);
    notifyHost();
  }
}

function hostChanged(next: Readonly<HostState>): boolean {
  let key: keyof HostState;
  for (key in next) {
    if (state[key] !== next[key]) {
      return true;
    }
  }
  return false;
}

export function getHost(): HostState {
  return state;
}

export function onHostChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Depth-first walk of the page model. Page trees are parsed at the boundary with
// LIMITS.treeDepthMax, so a deeper walk means the model was built wrong.
export function walkNodes(nodes: readonly HostNode[] | undefined, visit: (node: HostNode, parent: HostNode | undefined) => void) {
  walkNodesFrom(nodes, undefined, 0, visit);
}

function walkNodesFrom(
  nodes: readonly HostNode[] | undefined,
  parent: HostNode | undefined,
  depth: number,
  visit: (node: HostNode, parent: HostNode | undefined) => void,
) {
  assert(depth <= LIMITS.treeDepthMax, 'walkNodes: depth limit');
  for (const node of nodes || []) {
    visit(node, parent);
    if (Array.isArray(node.children)) {
      walkNodesFrom(node.children, node, depth + 1, visit);
    }
  }
}

export function findNode(nodes: readonly HostNode[] | undefined, id: string, depth = 0): HostNode | undefined {
  assert(depth <= LIMITS.treeDepthMax, 'findNode: depth limit');
  for (const node of nodes || []) {
    if (node.id === id) {
      return node;
    }
    const found = node.children && findNode(node.children, id, depth + 1);
    if (found) {
      return found;
    }
  }
  return undefined;
}

// A prop's literal string value, or '' for expressions and bare attributes —
// the panel matches selectors against text, and `class={x}` has no text.
export function propText(node: HostNode | undefined, name: string): string {
  const attribute = node?.props?.[name];
  if (!attribute || attribute.type !== 'string') {
    return '';
  }
  return String(attribute.value ?? '');
}
