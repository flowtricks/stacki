// Who an element is and where it is read: its serialized id, its class tokens
// as CSS, the host bridge's api, the snapshot a selection is read from, and
// the breakpoint the canvas shows (webflow.ts).

import { isClassName } from '../../../lib/fuzzyRank';
import { assert } from '../../../../shared/core/assert';
import { findNode, getHost, onHostChange, propText, walkNodes, type HostNode } from './host';
import { componentMarkupOf, instanceMarkupOf, type ComponentMarkup } from './componentMarkup';
import { instanceClassesOf } from './instanceClasses';
import { templateRootNode } from './templateRoot';
import type { BreakpointId, ElementSnapshot } from './styleTypes';

export type AnyElement = unknown;

// ───────────────────────────── Identity helpers ─────────────────────────────

export function serializeElementId(id: unknown): string {
  if (id === undefined) {
    return '';
  }
  // An element id handed through the Designer-shaped API may spell "none" as null.
  if (id === null) {
    return '';
  }
  if (typeof id === 'string') {
    return id;
  }
  if (typeof id === 'object' && 'id' in id && typeof id.id === 'string') {
    return id.id;
  }
  try {
    return JSON.stringify(id);
  } catch {
    return String(id);
  }
}

// Kept from the Webflow build so a name typed in the class field compiles the
// same way it would there — lowercased, spaces to hyphens, digits prefixed.
export function webflowClassToCss(name: string): string {
  const compiled = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\-_\s]/g, '')
    .replace(/\s+/g, '-');
  return /^[0-9]/.test(compiled) ? `_${compiled}` : compiled;
}

// The panel drives itself off two Designer events: which element is selected
// and which breakpoint is active. Both come from the app, so this exposes just
// those — enough for the panel to run, and nothing that implies a Designer is
// present (native styling still reports unavailable further down).
export type Unsub = () => void;

export function webflowApi() {
  return {
    getSelectedElement: async (): Promise<AnyElement> => nodeById(getHost().selectedId),
    subscribe: (event: string, callback: (value: unknown) => void): Unsub => {
      if (event === 'selectedelement') {
        let last = getHost().selectedId;
        return onHostChange(() => {
          const now = getHost().selectedId;
          if (now === last) {
            return;
          }
          last = now;
          callback(nodeById(now));
        });
      }
      if (event === 'mediaquery') {
        let last = getHost().device;
        return onHostChange(() => {
          const now = getHost().device;
          if (now === last) {
            return;
          }
          last = now;
          void getCurrentBreakpoint().then(callback);
        });
      }
      return () => {};
    },
  };
}

export const nodeById = (id: string | undefined): HostNode | undefined => (id ? findNode(getHost().nodes, id) : undefined);

// A node's classes. `class="a b"` is readable straight from the source, but
// `class:list={[…]}` / `class={expr}` are expressions with no class text at
// all — for those the only truth is what the page rendered. The preview reports
// that for the selected element, so merge it in: a static class inside a
// class:list shows up, and a computed one (`gap-${gap}`) shows the value THIS
// instance resolved to. Source order first, then anything only the DOM knows.
// The string literals in an expression-valued class attribute. `class:list={[
// "container", gap !== "8" && `gap-${gap}`, ...rest ]}` yields `container` — a
// literal is a class this element always has, so it can be shown straight away
// instead of waiting on the canvas. Template literals with a `${}` hole are
// skipped: only the rendered element knows what they became. Values that aren't
// class-shaped (selectors, URLs, sentences) are dropped.
export const literalClasses = (node: HostNode | undefined, name: string): string[] => {
  const prop = node?.props?.[name];
  if (!prop || prop.type !== 'expr') {
    return [];
  }
  const out: string[] = [];
  for (const [, quote, body] of String(prop.value ?? '').matchAll(/(['"`])([^'"`]*)\1/g)) {
    const literalBody = body ?? '';
    if (quote === '`' && literalBody.includes('${')) {
      continue;
    }
    for (const tok of literalBody.split(/\s+/)) {
      if (isClassName(tok)) {
        out.push(tok);
      }
    }
  }
  return out;
};

// The classes the node's own source names: `class="a b"` and the literals of a
// `class:list` or `class={…}` expression. A class can be named in more than one
// place (`class` plus `class:list`, or twice within one list); the element still
// carries it once.
export const authoredClassTokens = (node: HostNode | undefined): string[] => [
  ...new Set([
    ...propText(node, 'class').split(/\s+/).filter(Boolean),
    // `class:list={[…]}`, and `class={…}` when it's an expression.
    ...literalClasses(node, 'class:list'),
    ...literalClasses(node, 'class'),
  ]),
];

export const classTokens = (node: HostNode | undefined): string[] => {
  const authored = authoredClassTokens(node);
  const host = getHost();
  // Rendered classes describe the selected element only — attributing them to
  // any other node (an ancestor being matched, say) would be wrong.
  if (!node || node.id !== host.selectedId) {
    return authored;
  }
  const out = [...authored];
  for (const cls of host.renderedClasses || []) {
    if (cls && !out.includes(cls)) {
      out.push(cls);
    }
  }
  return out;
};

// The classes the selected element got from the instance it is shown for, when
// a component is open on the canvas in a page's context (instanceClasses.ts).
// Outside one (a page, or a component opened on its own) there is no instance,
// and a computed class is the element's own.
export function selectedInstanceClasses(classList: readonly string[]): string[] {
  const host = getHost();
  if (host.openFileKind !== 'component') {
    return [];
  }
  if (host.contextPagePath === undefined || host.contextPagePath === host.openFilePath) {
    return [];
  }
  return instanceClassesOf({ authored: authoredClassTokens(nodeById(host.selectedId)), rendered: classList });
}

// What the selected element's node writes in the open component file: the classes
// and attributes that come with every instance (componentMarkup.ts). Undefined on a
// page, where nothing is the component's, and when nothing is selected.
export function selectedComponentMarkup(): ComponentMarkup | undefined {
  const host = getHost();
  if (host.openFileKind !== 'component') {
    return undefined;
  }
  const node = nodeById(host.selectedId);
  if (node === undefined) {
    return undefined;
  }
  const path = pathTo(host.nodes, node.id);
  assert(path === undefined || path[path.length - 1] === node, 'selectedComponentMarkup: the path ends at the selection');
  return markupInTree(path ?? [node], host.nodes);
}

// Element-like nodes render an element of the open component; a condition, loop,
// expression or text node does not, and is looked through.
const rendersElement = (node: HostNode): boolean => node.kind === 'element' || node.kind === 'component';

/** The nodes from the top of the tree down to `id`, or undefined when it is not there. */
function pathTo(nodes: readonly HostNode[], id: string): HostNode[] | undefined {
  const parents = new Map<HostNode, HostNode | undefined>();
  let target: HostNode | undefined;
  walkNodes(nodes, (node, parent) => {
    parents.set(node, parent);
    if (node.id === id) {
      target = node;
    }
  });
  if (target === undefined) {
    return undefined;
  }
  const path: HostNode[] = [];
  for (let at: HostNode | undefined = target; at !== undefined && path.length <= parents.size; at = parents.get(at)) {
    path.unshift(at);
  }
  assert(path.length <= parents.size, 'pathTo: a path is never longer than the tree');
  return path;
}

/**
 * The markup of the last node of `path` with its parent and earlier siblings in the
 * open component, so a selector's ancestor and sibling parts are checked against
 * what this component writes (componentMarkup.ts). The tree's top is the component's
 * edge: what wraps it is not this component's markup.
 */
function markupInTree(path: readonly HostNode[], top: readonly HostNode[]): ComponentMarkup {
  let parent: ComponentMarkup | undefined;
  let siblings: readonly HostNode[] = top;
  let markup: ComponentMarkup | undefined;
  const selected = path[path.length - 1];
  for (const node of path) {
    // The selection is read whatever it is, as before; above it only elements count.
    if (rendersElement(node) || node === selected) {
      let previous: ComponentMarkup | undefined;
      for (const sibling of siblings) {
        if (sibling === node) {
          break;
        }
        if (rendersElement(sibling)) {
          previous = componentMarkupOf({ classes: authoredClassTokens(sibling), props: sibling.props, parent, previous });
        }
      }
      markup = componentMarkupOf({ classes: authoredClassTokens(node), props: node.props, parent, previous });
      parent = markup;
    }
    siblings = node.children ?? [];
  }
  assert(markup !== undefined, 'markupInTree: the selection is read');
  assert(markup.parent === undefined || path.length > 1, 'markupInTree: only a nested node has a parent');
  return markup;
}

/** A component source as selectedInstanceMarkup reads it: where it lives and its text. */
export type ComponentSourceText = {
  readonly source: { readonly origin: { readonly kind: string; readonly path?: string } };
  readonly code: string;
};

// What a component instance selected on a page renders with from inside its
// component (instanceMarkupOf): every rendered class the instance tag did not pass,
// however the component computed it, and the attributes its root element writes
// (templateRoot.ts). The file is the
// one the page imports (host.selectedComponentPath, resolved by the app); its text
// is the copy already loaded for the component's styles, else `readSource` (the
// component source cache). Without a resolved path, as in a host that does not
// resolve imports, only a single loaded file of the component's name is read.
// Undefined when the selection is not an instance, inside an open component
// (selectedComponentMarkup reads the node itself there), or while nothing is known:
// no rendered classes yet and the file still being read. Classes the page passes on
// the instance tag are the page's, so they are not here.
export function selectedInstanceMarkup(
  documents: Iterable<ComponentSourceText>,
  readSource: (path: string) => string | undefined,
): ComponentMarkup | undefined {
  const host = getHost();
  if (host.openFileKind === 'component') {
    return undefined;
  }
  const node = nodeById(host.selectedId);
  if (node === undefined || node.kind !== 'component' || node.name === undefined || node.name.length === 0) {
    return undefined;
  }
  const loaded = [...documents].filter((document) => document.source.origin.kind === 'astro' && document.source.origin.path !== undefined);
  const code = host.selectedComponentPath === undefined ? namedSource(loaded, node.name) : importedSource(loaded, host.selectedComponentPath, readSource);
  const root = code === undefined ? undefined : templateRootNode(code);
  return instanceMarkupOf({
    props: node.props,
    passed: authoredClassTokens(node),
    rendered: host.renderedClasses,
    root: root === undefined ? undefined : { classes: authoredClassTokens(root), props: root.props },
  });
}

/**
 * The key the selected instance's chip colours are remembered under: its component's
 * file, else its name. Undefined when the selection is not an instance on a page.
 */
export function selectedInstanceScope(): string | undefined {
  const host = getHost();
  if (host.openFileKind === 'component') {
    return undefined;
  }
  const node = nodeById(host.selectedId);
  if (node === undefined || node.kind !== 'component') {
    return undefined;
  }
  const scope = host.selectedComponentPath ?? node.name;
  return scope === undefined || scope.length === 0 ? undefined : scope.replaceAll('\\', '/');
}

/**
 * Whether the selected instance's colours are still unknown: the canvas has not yet
 * reported the classes it renders, or its component's file is imported, not among the
 * loaded stylesheets, and still being read. The chips keep their remembered colour meanwhile
 * (chipProvenanceMemory.ts).
 */
export function selectedInstanceMarkupPending(documents: Iterable<ComponentSourceText>, pending: (path: string) => boolean): boolean {
  const host = getHost();
  if (host.openFileKind === 'component') {
    return false;
  }
  const node = nodeById(host.selectedId);
  if (node === undefined || node.kind !== 'component') {
    return false;
  }
  // The classes it renders decide its green on their own (instanceMarkupOf), and the
  // canvas has not said yet.
  if (!host.renderedClassesKnown) {
    return true;
  }
  const path = host.selectedComponentPath;
  if (path === undefined) {
    return false;
  }
  const wanted = path.replaceAll('\\', '/');
  const held = [...documents].some((document) => document.source.origin.kind === 'astro' && document.source.origin.path?.replaceAll('\\', '/') === wanted);
  return held ? false : pending(path);
}

function importedSource(loaded: readonly ComponentSourceText[], path: string, readSource: (path: string) => string | undefined): string | undefined {
  const wanted = path.replaceAll('\\', '/');
  const held = loaded.find((document) => document.source.origin.path?.replaceAll('\\', '/') === wanted);
  return held === undefined ? readSource(path) : held.code;
}

// Two loaded files of one name in different folders: which one the page imports is
// not known here, and a guess could paint the wrong chips green.
function namedSource(loaded: readonly ComponentSourceText[], name: string): string | undefined {
  const fileName = `${name}.astro`;
  const matches = loaded.filter((document) => document.source.origin.path?.split(/[\\/]/).pop() === fileName);
  return matches.length === 1 ? matches[0]?.code : undefined;
}

// Elements reach the panel through the Designer-shaped API as `unknown`; one is
// read as a node only when it carries a node's identity.
export function isHostNode(value: unknown): value is HostNode {
  if (typeof value === 'object' && value !== null) {
    if ('id' in value && 'kind' in value) {
      return typeof value.id === 'string' && typeof value.kind === 'string';
    }
  }
  return false;
}

export async function buildSnapshot(element: AnyElement): Promise<ElementSnapshot> {
  const node = typeof element === 'string' ? nodeById(element) : isHostNode(element) ? element : undefined;
  const classes = classTokens(node);
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(node?.props || {})) {
    if (value && value.type === 'string') {
      attributes[key] = String(value.value ?? '');
    } else if (value && value.type === 'bare') {
      attributes[key] = '';
    }
  }
  const id = propText(node, 'id');
  if (id) {
    attributes['id'] = id;
  }
  if (classes.length) {
    attributes['class'] = classes.join(' ');
  }
  return {
    // A component instance renders markup we can't see from here, so it has
    // no tag of its own — selectors match it by class only.
    tag: node?.kind === 'element' ? String(node.name || '').toLowerCase() : undefined,
    webflowType: node?.kind === 'component' ? 'Component' : node?.kind || 'Element',
    id: id || undefined,
    classes,
    classList: classes,
    attributes,
  };
}

export async function resolveIdentityElement(selected: AnyElement): Promise<AnyElement> {
  return selected;
}

// ───────────────────────────── Breakpoints ─────────────────────────────

// The canvas has three widths; they map onto the scale the panel already
// speaks so its breakpoint controls need no changes.
export async function getCurrentBreakpoint(): Promise<BreakpointId> {
  const device = getHost().device;
  if (device === 'tablet') {
    return 'medium';
  }
  if (device === 'phone') {
    return 'small';
  }
  return 'main';
}
