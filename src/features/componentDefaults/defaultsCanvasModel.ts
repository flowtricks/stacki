import { resolveSourceImport } from '../../editor/importPaths';
import { LIMITS } from '../../../shared/core/limits';
// Temporary pages reuse ordinary editor tools without changing authored components.
import { assert } from '../../../shared/core/assert';
import { encodeText, decodeEntities } from '../../../shared/page/htmlText';
import type { Attr } from '../../../shared/page/pageNode';
import type { DefaultsCanvasSession } from '../../../shared/properties/defaultsCanvas';
import {
  componentFile,
  DEFAULT_LIMITS,
  resolveComponentRecipe,
  type ComponentRecipe,
  type DefaultValue,
  type RecipeChild,
  type ResolvedNode,
} from '../../../shared/properties/componentDefaults';

export function renderDefaultsInstance(
  component: string,
  snapshot: DefaultsCanvasSession['snapshot'],
  existing: ReadonlyMap<string, string>,
  source: string,
): { readonly body: string; readonly declarations: string } {
  const result = resolveComponentRecipe(component, snapshot.config, snapshot.catalog);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  const imports = new Map(existing);
  const additions: string[] = [];
  const binding = (file: string) => {
    const held = imports.get(file);
    if (held) {
      return held;
    }
    const base =
      file
        .split('/')
        .at(-1)
        ?.replace(/\.astro$/, '') ?? 'Component';
    let name = /^[A-Z][\w]*$/.test(base) ? base : 'Component';
    for (let index = 0; index <= DEFAULT_LIMITS.sourceCharsMax; index++) {
      if (!source.includes(name) && ![...imports.values()].includes(name)) {
        break;
      }
      name = 'DefaultsComponent' + index;
    }
    imports.set(file, name);
    const specifier = snapshot.catalog.find((entry) => entry.file === file)?.importPath ?? '../../' + componentFile(file);
    additions.push(`import ${name} from ${JSON.stringify(specifier)};`);
    return name;
  };
  const render = (node: ResolvedNode, depth: number): string => {
    assert(depth <= DEFAULT_LIMITS.depthMax, 'Canvas rendering has bounded depth');
    if ('literal' in node) {
      return encodeText(node.literal);
    }
    const name = 'component' in node ? binding(node.component) : node.element;
    const props = Object.entries(node.props)
      .map(([key, value]) => renderProp(key, value))
      .join('');
    const children =
      node.content.kind === 'empty'
        ? undefined
        : node.content.kind === 'text'
          ? encodeText(node.content.text)
          : node.content.children.map((child) => render(child, depth + 1)).join('');
    return children === undefined ? `<${name}${props} />` : `<${name}${props}>${children}</${name}>`;
  };
  const body = render(result.value, 0);
  assert(additions.length <= DEFAULT_LIMITS.nodesMax, 'Canvas imports fit the expanded tree');
  return { body, declarations: additions.join('\n') };
}

function renderProp(name: string, value: DefaultValue): string {
  return typeof value === 'string' ? ` ${name}="${encodeText(value).replaceAll('"', '&quot;')}"` : ` ${name}={${String(value)}}`;
}

// Both parser hosts expose these structural fields. Unsupported syntax is rejected below.
export interface CanvasNode {
  readonly kind: string;
  readonly id?: string;
  readonly start?: number;
  readonly end?: number;
  readonly name?: string;
  readonly value?: string;
  readonly props?: Readonly<Record<string, Attr>> | undefined;
  readonly children?: readonly CanvasNode[] | undefined;
}
export interface CanvasModel {
  readonly imports: readonly { readonly name: string; readonly path: string }[];
  readonly nodes: readonly CanvasNode[];
}
export function recipeFromCanvas(model: CanvasModel, session: DefaultsCanvasSession): ComponentRecipe {
  const imports = new Map(model.imports.map((item) => [item.name, resolveSourceImport(session.file, item.path, session.snapshot.catalog)]));
  const root = canvasNodeAt(model.nodes, session.targetPath);
  if (!root || root.kind !== 'component' || imports.get(root.name ?? '') !== session.component) {
    throw new Error('Keep the component whose defaults you are editing in its original position.');
  }
  if (canvasContext(model.nodes, session.targetPath) !== session.context) {
    throw new Error('Only edit inside the component whose defaults you are setting.');
  }
  let count = 0;
  const convert = (node: CanvasNode, depth: number): RecipeChild => {
    count += 1;
    if (depth > DEFAULT_LIMITS.depthMax || count > DEFAULT_LIMITS.nodesMax) {
      throw new Error('Default children exceed the insertion limit.');
    }
    if (node.kind === 'text') {
      return { literal: node.value ?? '' };
    }
    if (node.kind !== 'component' && node.kind !== 'element') {
      throw new Error('Defaults support components, HTML elements, and literal text.');
    }
    const recipe = canvasNodeRecipe(node, (child) => convert(child, depth + 1));
    if (node.kind === 'element') {
      return { element: node.name ?? '', ...recipe };
    }
    const file = imports.get(node.name ?? '');
    if (!file) {
      throw new Error(`Cannot resolve the default child ${node.name ?? ''}.`);
    }
    return { component: componentFile(file), inherit: false, ...recipe };
  };
  const recipe = canvasNodeRecipe(root, (child) => convert(child, 1));
  assert(count <= DEFAULT_LIMITS.nodesMax, 'Canvas conversion respects the node bound');
  assert(root.kind === 'component', 'A defaults canvas owns a component instance');
  return recipe;
}
function canvasNodeRecipe(node: CanvasNode, convert: (node: CanvasNode) => RecipeChild): ComponentRecipe {
  const props = Object.fromEntries(Object.entries(node.props ?? {}).map(([name, value]) => [name, canvasProp(value)]));
  const children = node.children;
  if (children === undefined) {
    return { props };
  }
  if (children.every((child) => child.kind === 'text')) {
    return children.length === 0 ? { props, children: [] } : { props, text: children.map((child) => child.value ?? '').join('') };
  }
  return { props, children: children.map(convert) };
}
function canvasProp(attribute: Attr): DefaultValue {
  if (attribute.type === 'bare') {
    return true;
  }
  if (attribute.type === 'string') {
    return decodeEntities(attribute.value);
  }
  if (attribute.type === 'expr') {
    const value = attribute.value.trim();
    if (value === 'true' || value === 'false') {
      return value === 'true';
    }
    if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value) && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  throw new Error('Default props must be literal text, numbers, or booleans.');
}

export function canvasNodeAt(nodes: readonly CanvasNode[], path: string): CanvasNode | undefined {
  let list = nodes;
  let result: CanvasNode | undefined;
  for (const part of path.split('.')) {
    result = list[Number(part)];
    list = result?.children ?? [];
  }
  return result;
}

// Ignore parser ranges and handles; compare all content outside the owned instance.
export function canvasContext(nodes: readonly CanvasNode[], target: string): string {
  let count = 0;
  const visit = (node: CanvasNode, path: string, depth: number): unknown => {
    count++;
    assert(count <= LIMITS.treeNodesMax, 'Context has a bounded node count');
    assert(depth <= LIMITS.treeDepthMax, 'Context has bounded depth');
    return path === target
      ? { defaults: true }
      : {
          kind: node.kind,
          name: node.name,
          value: node.value,
          props: node.props,
          children: node.children?.map((child, index) => visit(child, path + '.' + index, depth + 1)),
        };
  };
  return JSON.stringify(nodes.map((node, index) => visit(node, String(index), 0)));
}
