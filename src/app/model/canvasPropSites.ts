// Where a component shows one of its props as text, read from its template:
// printed as `{heading}` (text), rendered as HTML with `set:html={heading}`
// (inline content the canvas format bar can mark up), or handed on as
// `<Title text={heading} />` and shown by the nested component. Each component
// is read once per catalog; nesting is followed a few levels.

import type { Attr, ImportDecl } from '../../../shared/page/pageNode';
import type { ScanComponent } from '../../../shared/properties/projectScan';
import { assert } from '../../../shared/core/assert';
import { componentReference } from './componentReference';

/** One place a component shows one of its props, in its own file's canvas paths. */
export type PropTextSite =
  | {
      /** `{prop}` in an element's or nested component's content. */
      readonly kind: 'text';
      readonly prop: string;
      readonly path: string;
      readonly parent: string;
      readonly parentKind: 'element' | 'component';
      readonly tag: string;
      readonly siblings: readonly string[];
    }
  | {
      /** `set:html={prop}`: the whole content of the element at `parent`. */
      readonly kind: 'html';
      readonly prop: string;
      readonly parent: string;
      readonly tag: string;
    };

export interface PropSiteContext {
  readonly projectPath: string;
  readonly components: readonly ScanComponent[];
  /** The canvas path of a file, as the preview namespaces it (`src/components/X.astro`). */
  readonly relative: (file: string) => string;
  readonly read: (file: string) => Promise<ComponentSource | undefined>;
}

/**
 * The part of a parsed node the finder reads. The app's page nodes and
 * Studio's parser nodes both fit it, so one finder serves both editors.
 */
export interface PropNode {
  readonly id?: string | undefined;
  readonly kind: string;
  readonly name?: string | undefined;
  readonly value?: string | undefined;
  readonly props?: Readonly<Record<string, Attr>> | undefined;
  readonly children?: readonly PropNode[] | undefined;
}

export interface ComponentSource {
  readonly nodes: readonly PropNode[];
  readonly imports: readonly ImportDecl[];
}

export type InstanceNode = PropNode & {
  readonly kind: 'component';
  readonly id: string;
  readonly name: string;
};

// Components followed into, and sites kept per component.
const NESTING_MAX = 3;
export const SITES_MAX = 64;
// Nodes whose content may render many times, or as the page's code decides.
export const REPEATS: readonly string[] = ['map', 'expr'];

/** Where each component shows its props, read once per reader. */
export function propSiteReader(context: PropSiteContext) {
  const known = new Map<string, Promise<PropTextSite[]>>();
  const sites = (component: ScanComponent, depth = 0): Promise<PropTextSite[]> => {
    if (depth > NESTING_MAX) {
      return Promise.resolve([]);
    }
    const kept = known.get(component.path);
    if (kept) {
      return kept;
    }
    const reading = readSites(component, depth, context, sites).catch(() => []);
    known.set(component.path, reading);
    return reading;
  };
  return sites;
}

async function readSites(
  component: ScanComponent,
  depth: number,
  context: PropSiteContext,
  inner: (component: ScanComponent, depth: number) => Promise<PropTextSite[]>,
): Promise<PropTextSite[]> {
  const source = await context.read(component.path);
  const props = new Set(component.schema?.map((field) => field.name) ?? []);
  if (!source || props.size === 0) {
    return [];
  }
  const rel = context.relative(component.path);
  const walked = templateNodes(source.nodes);
  const paths = new Map(walked.map(({ node, path }) => [node, `${rel}|${path}`]));
  const pathOf = (node: PropNode) => paths.get(node);
  const sites: PropTextSite[] = [];
  for (const { node, parent } of walked) {
    const shown = printedSite(node, parent, props, pathOf) ?? htmlSite(node, parent, props, pathOf);
    if (shown) {
      sites.push(shown);
    }
    if (isInstance(node)) {
      sites.push(...(await handedOn(node, component, source, props, context, depth, inner)));
    }
  }
  assert(
    sites.every((site) => props.has(site.prop)),
    'Every site shows one of the props',
  );
  return sites.slice(0, SITES_MAX);
}

// `{prop}` printed straight into an element or a nested component's content.
function printedSite(
  node: PropNode,
  parent: PropNode | undefined,
  props: ReadonlySet<string>,
  pathOf: (node: PropNode) => string | undefined,
): PropTextSite | undefined {
  const prop = node.kind === 'expr' ? propName(node.value ?? '') : undefined;
  if (prop === undefined || !parent || !props.has(prop)) {
    return undefined;
  }
  if (parent.kind !== 'element' && parent.kind !== 'component') {
    return undefined;
  }
  const path = pathOf(node);
  const parentPath = pathOf(parent);
  const siblings = childrenOf(parent)
    .filter((child) => !['text', 'expr', 'comment'].includes(child.kind))
    .map(pathOf);
  if (!path || !parentPath || siblings.some((sibling) => sibling === undefined)) {
    return undefined;
  }
  return {
    kind: 'text',
    prop,
    path,
    parent: parentPath,
    parentKind: parent.kind,
    tag: parent.name ?? '',
    siblings: siblings.filter((sibling): sibling is string => sibling !== undefined),
  };
}

// `<h2 set:html={prop} />`, or `<Fragment set:html={prop} />` as the only
// content of its element: the element's whole content is the prop's HTML.
function htmlSite(
  node: PropNode,
  parent: PropNode | undefined,
  props: ReadonlySet<string>,
  pathOf: (node: PropNode) => string | undefined,
): PropTextSite | undefined {
  const attr = 'props' in node ? node.props?.['set:html'] : undefined;
  const prop = attr?.type === 'expr' ? propName(attr.value) : undefined;
  if (prop === undefined || !props.has(prop)) {
    return undefined;
  }
  const fragment = node.kind === 'component' && 'name' in node && node.name === 'Fragment';
  const host = fragment ? parent : node;
  if (host?.kind !== 'element') {
    return undefined;
  }
  if (fragment && childrenOf(host).some((child) => child !== node && child.kind !== 'text')) {
    return undefined;
  }
  const path = pathOf(host);
  return path ? { kind: 'html', prop, parent: path, tag: host.name ?? '' } : undefined;
}

// `<Heading text={prop} />`: the nested component's own sites for `text`, set
// by this component's `prop`.
async function handedOn(
  node: InstanceNode,
  component: ScanComponent,
  source: ComponentSource,
  props: ReadonlySet<string>,
  context: PropSiteContext,
  depth: number,
  inner: (component: ScanComponent, depth: number) => Promise<PropTextSite[]>,
): Promise<PropTextSite[]> {
  const handed = Object.entries(('props' in node ? node.props : undefined) ?? {}).filter(
    ([, attr]) => attr.type === 'expr' && props.has(propName(attr.value)),
  );
  if (handed.length === 0) {
    return [];
  }
  const nested = componentReference({
    name: node.name,
    project: context.projectPath,
    file: component.path,
    imports: source.imports,
    components: context.components,
  });
  if (!nested || nested.origin?.kind === 'package') {
    return [];
  }
  const sites = await inner(nested, depth + 1);
  return handed.flatMap(([name, attr]) =>
    attr.type === 'expr'
      ? sites
          .filter((site) => site.prop === name)
          .map((site) => ({ ...site, prop: propName(attr.value) }))
      : [],
  );
}

// A component's template, each node with its parent and its tree path — the
// child indexes from the root, `0.0.1`, as the canvas markers name it — outside
// loops and expressions.
function templateNodes(nodes: readonly PropNode[]) {
  type Walked = {
    readonly node: PropNode;
    readonly parent: PropNode | undefined;
    readonly path: string;
  };
  const queue: Walked[] = nodes.map((node, at) => ({ node, parent: undefined, path: String(at) }));
  const out: Walked[] = [];
  for (let index = 0; index < queue.length && index < 10_000; index++) {
    const entry = queue[index];
    if (!entry) {
      continue;
    }
    out.push(entry);
    const children = childrenOf(entry.node).map((child, at) => ({
      node: child,
      parent: entry.node,
      path: `${entry.path}.${at}`,
    }));
    // A loop's or an expression's children are named, so their siblings and
    // parents resolve, but nothing inside them is walked further.
    queue.push(...(REPEATS.includes(entry.node.kind) ? [] : children));
  }
  return out;
}

// `{headingText}` or `headingText`: the bare name an expression prints.
export function propName(expression: string): string {
  const bare = expression.trim();
  const inner = bare.startsWith('{') && bare.endsWith('}') ? bare.slice(1, -1) : bare;
  return inner.trim();
}

export function isInstance(node: PropNode): node is InstanceNode {
  return node.kind === 'component' && Boolean(node.id) && typeof node.name === 'string';
}

export function childrenOf(node: PropNode): readonly PropNode[] {
  return node.children ?? [];
}
