// Turning the canvas's copy of the page into a design baseline: every element of the body gets a design id
// (`data-dm-id`), and every component instance the page places is tagged with what the props panel and the
// hand-off need (`data-dm-instance`, the instance's key). Pure over a DOM document, so a test runs it in JSDOM.
//
// How an instance is found: the canvas tags every element a source node renders with that node's marker path
// (`data-avb-p`, space separated). A page node's path has no `|` (`0.1.2`); a node of another file is prefixed
// with the file (`src/components/Card.astro|0`). An element carrying a page path whose node is a component,
// and whose parent does not carry it, is a root of that instance. A loop renders one instance node several
// times, so consecutive roots are split into occurrences where the component's own root index starts again.
import type { Attr } from '../../../../shared/page/pageNode';
import type { DesignJson } from '../../../../shared/designMode/designModeContract';
import type { EditorModel, EditorNode } from '../../../editor/pageView';
import { DESIGN_LIMITS, type DesignInstanceInfo, type DesignNodeSource } from './designTypes';

export const DESIGN_ID_ATTRIBUTE = 'data-dm-id';
export const INSTANCE_ATTRIBUTE = 'data-dm-instance';
export const MARKER_ATTRIBUTE = 'data-avb-p';

/** The parts of a scanned component the baseline needs. */
export interface DesignComponentEntry {
  readonly name: string;
  readonly path: string;
}

export interface PreparedBaseline {
  readonly html: string;
  /** Instance key (`i1`) to what the page says about it. */
  readonly instances: ReadonlyMap<string, DesignInstanceInfo>;
  /** Page node path to its kind, name and line. */
  readonly sources: ReadonlyMap<string, DesignNodeSource>;
  readonly elementCount: number;
}

/** What the open page's editor state offers the baseline; absent when the page is not an editable model. */
export interface PageModelView {
  readonly model: EditorModel;
  /** The text the model's offsets index. */
  readonly text: string;
}

export function prepareBaseline(document: Document, page: PageModelView | undefined, components: readonly DesignComponentEntry[]): PreparedBaseline {
  const body = document.body;
  if (body === null) {
    throw new Error('Assertion failed: prepareBaseline: a parsed page has a body');
  }
  const elements = [body, ...body.querySelectorAll('*')];
  if (elements.length > DESIGN_LIMITS.elementsMax) {
    throw new Error('Assertion failed: prepareBaseline: the page is within the element bound');
  }
  elements.forEach((element, index) => element.setAttribute(DESIGN_ID_ATTRIBUTE, 'e' + index.toString(36)));
  const sources = page === undefined ? new Map<string, DesignNodeSource>() : pageSources(page);
  const instances = tagInstances(elements, sources, page, components);
  const html = '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
  return { html, instances, sources, elementCount: elements.length };
}

/** Every node of the page model by path, with its kind, name and line. Iterative and bounded. */
export function pageSources(page: PageModelView): Map<string, DesignNodeSource> {
  const sources = new Map<string, DesignNodeSource>();
  const pending: { readonly node: EditorNode; readonly path: string }[] = page.model.nodes.map((node, index) => ({ node, path: String(index) }));
  const lineStarts = lineStartsOf(page.text);
  for (let visited = 0; pending.length > 0; visited += 1) {
    if (visited >= DESIGN_LIMITS.elementsMax) {
      break;
    }
    const entry = pending.shift();
    if (entry === undefined) {
      break;
    }
    const { node, path } = entry;
    const kind = node.kind === 'component' || node.kind === 'element' ? node.kind : 'other';
    const start = 'start' in node && typeof node.start === 'number' ? node.start : undefined;
    sources.set(path, { path, kind, name: node.name ?? node.kind, line: start === undefined ? undefined : lineOf(lineStarts, start) });
    (node.children ?? []).forEach((child, index) => pending.push({ node: child, path: path + '.' + String(index) }));
  }
  return sources;
}

function lineStartsOf(text: string): readonly number[] {
  const starts = [0];
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

/** The 1-based line holding `offset`: a binary search over the line starts. */
function lineOf(lineStarts: readonly number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((lineStarts[middle] ?? 0) <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low + 1;
}

/** The marker paths an element carries. */
export function markerPaths(element: Element): readonly string[] {
  const value = element.getAttribute(MARKER_ATTRIBUTE);
  return value === null ? [] : value.split(/\s+/).filter((token) => token.length > 0);
}

function tagInstances(
  elements: readonly Element[],
  sources: ReadonlyMap<string, DesignNodeSource>,
  page: PageModelView | undefined,
  components: readonly DesignComponentEntry[],
): Map<string, DesignInstanceInfo> {
  const instances = new Map<string, DesignInstanceInfo>();
  if (page === undefined) {
    return instances;
  }
  // The occurrence each instance path's roots were last given, with the root index it ended on.
  const open = new Map<string, { readonly key: string; readonly element: Element; readonly rootIndex: number }>();
  let count = 0;
  for (const element of elements) {
    const parentPaths = new Set(element.parentElement === null ? [] : markerPaths(element.parentElement));
    for (const path of markerPaths(element)) {
      if (path.includes('|') || parentPaths.has(path)) {
        continue;
      }
      const source = sources.get(path);
      if (source?.kind !== 'component') {
        continue;
      }
      const component = componentFileOf(element, source.name, components);
      if (component === undefined) {
        continue;
      }
      const rootIndex = rootIndexOf(element, component);
      const previous = open.get(path);
      const continues = previous !== undefined && previous.element === element.previousElementSibling && rootIndex > previous.rootIndex;
      let key: string;
      if (continues) {
        key = previous.key;
      } else {
        count += 1;
        key = 'i' + count.toString(36);
        const node = nodeAt(page.model, path);
        instances.set(key, { path, name: source.name, component, ...instanceProps(node?.props), line: source.line, slots: slotNamesOf(node) });
      }
      open.set(path, { key, element, rootIndex });
      element.setAttribute(INSTANCE_ATTRIBUTE, key);
    }
  }
  return instances;
}

function nodeAt(model: EditorModel, path: string): EditorNode | undefined {
  let nodes: readonly EditorNode[] | undefined = model.nodes;
  let found: EditorNode | undefined;
  for (const step of path.split('.')) {
    found = nodes?.[Number(step)];
    nodes = found?.children;
  }
  return found;
}

/** The component file an instance root renders: the scanned component of that name, the root's own file marker settling a tie. */
function componentFileOf(element: Element, name: string, components: readonly DesignComponentEntry[]): string | undefined {
  const named = components.filter((entry) => entry.name === name);
  if (named.length === 1) {
    return named[0]?.path;
  }
  const files = new Set(
    markerPaths(element)
      .filter((path) => path.includes('|'))
      .map((path) => path.slice(0, path.lastIndexOf('|'))),
  );
  return named.find((entry) => files.has(entry.path))?.path;
}

/** The index of the component's own root node this element renders (`Card.astro|1` is 1), or 0 when it carries none. */
function rootIndexOf(element: Element, component: string): number {
  for (const path of markerPaths(element)) {
    if (path.startsWith(component + '|')) {
      const trail = path.slice(component.length + 1);
      if (/^\d+$/.test(trail)) {
        return Number(trail);
      }
    }
  }
  return 0;
}

/** The slots an instance's children fill: `slot="name"` on a child names one, anything else fills `default`. */
export function slotNamesOf(node: EditorNode | undefined): readonly string[] {
  const names = new Set<string>();
  for (const child of node?.children ?? []) {
    const slot = child.props?.['slot'];
    if (slot?.type === 'string' && /^[A-Za-z_$][\w$-]*$/.test(slot.value)) {
      names.add(slot.value);
    } else if (child.kind !== 'text' || (child.value ?? '').trim() !== '') {
      names.add('default');
    }
  }
  return [...names];
}

/** The literal props an instance writes, and the ones it sets with code. */
export function instanceProps(props: Readonly<Record<string, Attr>> | undefined): {
  readonly props: Readonly<Record<string, DesignJson>>;
  readonly codeProps: Readonly<Record<string, string>>;
} {
  const values: Record<string, DesignJson> = {};
  const code: Record<string, string> = {};
  for (const [name, attr] of Object.entries(props ?? {})) {
    if (name.startsWith('data-avb') || name === 'slot') {
      continue;
    }
    switch (attr.type) {
      case 'string':
        values[name] = attr.value;
        break;
      case 'bare':
        values[name] = true;
        break;
      case 'expr': {
        const literal = literalOf(attr.value);
        if (literal === undefined) {
          code[name] = attr.value;
        } else {
          values[name] = literal;
        }
        break;
      }
      case 'spread':
        code['...' + attr.value] = attr.value;
        break;
      default: {
        const exhaustive: never = attr;
        return exhaustive;
      }
    }
  }
  return { props: values, codeProps: code };
}

/** A JavaScript literal an expression prop writes (`{true}`, `{3}`, `{"a"}`), or undefined when it is code. */
export function literalOf(expression: string): DesignJson | undefined {
  const text = expression.trim();
  if (text === 'true') {
    return true;
  }
  if (text === 'false') {
    return false;
  }
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    return Number(text);
  }
  const quoted = /^(["'`])((?:(?!\1)[^\\$]|\\.)*)\1$/.exec(text);
  if (quoted !== null) {
    return (quoted[2] ?? '').replace(/\\(.)/g, '$1');
  }
  return undefined;
}
