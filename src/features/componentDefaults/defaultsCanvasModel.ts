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
import {
  assetBindingName,
  builtinModuleOf,
  defaultAttributes,
  elementMarkup,
  heldDefaults,
  isAssetDefaultFile,
  isSVGTag,
  isStaticMarkup,
  literalReferences,
  withoutMissingAssets,
  type AssetDefault,
  type LiteralDefault,
  type WrittenTag,
} from '../../../shared/properties/componentDefaultValues';

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
  const words = new Set(source.match(/[A-Za-z_$][\w$]*/g) ?? []);
  const assetBinding = (file: string) => {
    const held = imports.get(file);
    if (held) {
      return held;
    }
    const name = assetBindingName(file, new Set([...words, ...imports.values()]));
    imports.set(file, name);
    additions.push(`import ${name} from ${JSON.stringify('../../' + file)};`);
    return name;
  };
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
  // A built-in is imported under a name the page does not use: the page's own import of it may be there already.
  const builtinBinding = (tag: string, from: string) => {
    const key = `${from}#${tag}`;
    const held = imports.get(key);
    if (held) {
      return held;
    }
    const name = assetBindingName(`Defaults${tag}`, new Set([...words, ...imports.values()]));
    imports.set(key, name);
    additions.push(`import { ${tag} as ${name} } from ${JSON.stringify(from)};`);
    return name;
  };
  const render = (node: ResolvedNode, depth: number): string => {
    assert(depth <= DEFAULT_LIMITS.depthMax, 'Canvas rendering has bounded depth');
    if ('literal' in node) {
      return node.verbatim ?? encodeText(node.literal);
    }
    const name =
      'component' in node
        ? binding(node.component)
        : node.from !== undefined && node.tag !== undefined
          ? builtinBinding(node.tag, node.from)
          : (node.tag ?? node.element);
    const props = defaultAttributes(node, assetBinding)
      .map(([key, attribute]) => renderAttribute(key, attribute))
      .join('');
    const children =
      node.content.kind === 'empty'
        ? undefined
        : node.content.kind === 'text'
          ? encodeText(node.content.text)
          : node.content.children.map((child) => render(child, depth + 1)).join('');
    return elementMarkup(name, props, children);
  };
  const gone = new Set(snapshot.missingAssets);
  const body = render(withoutMissingAssets(result.value, (file) => !gone.has(file)).node, 0);
  assert(additions.length <= DEFAULT_LIMITS.nodesMax, 'Canvas imports fit the expanded tree');
  return { body, declarations: additions.join('\n') };
}

function renderAttribute(name: string, attribute: { readonly type: 'string' | 'expr'; readonly value: string }): string {
  return attribute.type === 'string' ? ` ${name}="${encodeText(attribute.value).replaceAll('"', '&quot;')}"` : ` ${name}={${attribute.value}}`;
}

// Both parser hosts expose these structural fields. Unsupported syntax is rejected below.
export interface CanvasNode {
  readonly kind: string;
  readonly id?: string;
  readonly start?: number;
  readonly end?: number;
  readonly name?: string;
  /** A loop's head and a condition's test, to name one in a refusal. */
  readonly head?: string;
  readonly test?: string;
  /** A fragment written `<>`. */
  readonly shorthand?: boolean;
  /** A comment written in braces. */
  readonly jsx?: boolean;
  readonly value?: string;
  readonly props?: Readonly<Record<string, Attr>> | undefined;
  readonly children?: readonly CanvasNode[] | undefined;
}
export interface CanvasModel {
  readonly imports: readonly { readonly name: string; readonly path: string; readonly imported?: string; readonly named?: boolean }[];
  readonly nodes: readonly CanvasNode[];
}
/** A prop of the canvas whose value a default cannot hold: code that reads something only that page has. */
export class UnsupportedDefaultError extends Error {
  constructor(
    readonly prop: string,
    readonly tag: string,
  ) {
    super(`Default props must be literal values or imported files; ${prop} on ${tag} is code.`);
  }
}

/** A child no default can hold: a framework or dynamic component, `Astro.self`, a comment or code. */
export class UnsupportedChildError extends Error {
  constructor(readonly child: string) {
    super(`Defaults hold components, elements, fragments and text; ${child} cannot be one.`);
  }
}

/** `assetFiles` maps an import's specifier to the file the host resolved it to, which an alias needs. */
export function recipeFromCanvas(model: CanvasModel, session: DefaultsCanvasSession, assetFiles?: ReadonlyMap<string, string>): ComponentRecipe {
  const imports = new Map(
    model.imports.map((item) => [item.name, assetFiles?.get(item.path) ?? resolveSourceImport(session.file, item.path, session.snapshot.catalog)]),
  );
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
    const kept = keptMarkup(node);
    if (kept !== undefined) {
      return { literal: '', verbatim: kept };
    }
    const kind = childKind(node, model, imports);
    const recipe = canvasNodeRecipe(node, imports, (child) => convert(child, depth + 1));
    return kind.kind === 'component' ? { component: kind.file, inherit: false, ...recipe } : { ...kind.element, ...recipe };
  };
  const recipe = canvasNodeRecipe(root, imports, (child) => convert(child, 1));
  assert(count <= DEFAULT_LIMITS.nodesMax, 'Canvas conversion respects the node bound');
  assert(root.kind === 'component', 'A defaults canvas owns a component instance');
  return recipe;
}
// A comment, or braces that compute nothing: kept in the recipe as written.
function keptMarkup(node: CanvasNode): string | undefined {
  const value = node.value ?? '';
  // Each comment keeps its own form: an HTML comment ships in the built page and a braces one does not.
  const comment = node.jsx === true ? `{/*${value}*/}` : `<!--${value}-->`;
  const written = node.kind === 'comment' ? comment : node.kind === 'expr' ? value : undefined;
  return written !== undefined && isStaticMarkup(written) ? written : undefined;
}

// A refused child as the person would recognise it in the code.
function namedChild(node: CanvasNode): string {
  const code =
    node.kind === 'raw'
      ? `<${node.name ?? ''}>`
      : node.kind === 'map'
        ? `{${node.head ?? '…'}`
        : node.kind === 'cond'
          ? `{${node.test ?? ''} && …}`
          : (node.value ?? '{…}');
  const flat = code.replace(/\s+/g, ' ');
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
}

type ChildKind =
  { readonly kind: 'component'; readonly file: string } | { readonly kind: 'element'; readonly element: { readonly element: string } & WrittenTag };

// What a child on the canvas is stored as. A Fragment and an Astro built-in have no component file: they are elements
// with the tag they are written as (componentDefaultValues.ts), and a child that is neither is refused by name.
function childKind(node: CanvasNode, model: CanvasModel, imports: ReadonlyMap<string, string | undefined>): ChildKind {
  const name = node.name ?? '';
  const element = (tag?: string, from?: WrittenTag['from']): ChildKind => ({
    kind: 'element',
    element: tag === undefined ? { element: name } : { element: 'div', tag, ...(from === undefined ? {} : { from }) },
  });
  if (node.kind === 'element') {
    if (/^[a-z][a-z0-9-]*$/.test(name)) {
      return element();
    }
    if (isSVGTag(name)) {
      return element(name);
    }
    throw new UnsupportedChildError(`<${name}>`);
  }
  if (node.kind !== 'component') {
    throw new UnsupportedChildError(namedChild(node));
  }
  const imported = model.imports.find((entry) => entry.name === name);
  if (imported === undefined) {
    if (name === 'Fragment') {
      return element(node.shorthand === true ? '<>' : 'Fragment');
    }
    throw new UnsupportedChildError(`<${name}>`);
  }
  const builtin = imported.named === true ? builtinModuleOf(imported.path, imported.imported ?? imported.name) : undefined;
  if (builtin !== undefined) {
    return element(imported.imported ?? imported.name, builtin);
  }
  const file = imports.get(name);
  if (file === undefined || !file.endsWith('.astro')) {
    throw new UnsupportedChildError(`<${name}>`);
  }
  return { kind: 'component', file: componentFile(file) };
}

function canvasNodeRecipe(node: CanvasNode, imports: ReadonlyMap<string, string | undefined>, convert: (node: CanvasNode) => RecipeChild): ComponentRecipe {
  const props: [string, DefaultValue][] = [];
  const assets: [string, AssetDefault][] = [];
  const literals: [string, LiteralDefault][] = [];
  for (const [name, attribute] of Object.entries(node.props ?? {})) {
    const held = canvasProp(attribute, imports);
    if (held === undefined) {
      throw new UnsupportedDefaultError(name, node.name ?? '');
    }
    if (held.kind === 'asset') {
      assets.push([name, held.asset]);
    } else if (held.kind === 'literal') {
      literals.push([name, held.literal]);
    } else {
      props.push([name, held.value]);
    }
  }
  const values = { props: Object.fromEntries(props), ...heldDefaults({ assets: Object.fromEntries(assets), literals: Object.fromEntries(literals) }) };
  const children = node.children;
  if (children === undefined) {
    return values;
  }
  if (children.every((child) => child.kind === 'text')) {
    return children.length === 0 ? { ...values, children: [] } : { ...values, text: children.map((child) => child.value ?? '').join('') };
  }
  return { ...values, children: children.map(convert) };
}
type CanvasValue =
  | { readonly kind: 'value'; readonly value: DefaultValue }
  | { readonly kind: 'asset'; readonly asset: AssetDefault }
  | { readonly kind: 'literal'; readonly literal: LiteralDefault };

// What a default can hold of one attribute, or undefined when it is code that reads something of the page's own.
function canvasProp(attribute: Attr, imports: ReadonlyMap<string, string | undefined>): CanvasValue | undefined {
  if (attribute.type === 'bare') {
    return { kind: 'value', value: true };
  }
  if (attribute.type === 'string') {
    return { kind: 'value', value: decodeEntities(attribute.value) };
  }
  if (attribute.type !== 'expr') {
    return undefined;
  }
  const value = attribute.value.trim();
  if (value === 'true' || value === 'false') {
    return { kind: 'value', value: value === 'true' };
  }
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value) && Number.isFinite(Number(value))) {
    return { kind: 'value', value: Number(value) };
  }
  // An imported file, as picking it writes it: the import's name, or its address (`name.src`).
  const named = /^([A-Za-z_$][\w$]*)(\.src)?$/.exec(value);
  const file = named === null ? undefined : imports.get(named[1] ?? '');
  if (file !== undefined && isAssetDefaultFile(file)) {
    return { kind: 'asset', asset: named?.[2] === undefined ? { file } : { file, url: true } };
  }
  const literal = canvasLiteral(value, imports);
  return literal === undefined ? undefined : { kind: 'literal', literal };
}

// A list or object of plain data, which may name files the page imports.
function canvasLiteral(source: string, imports: ReadonlyMap<string, string | undefined>): LiteralDefault | undefined {
  const files = new Map([...imports].flatMap(([name, file]) => (file !== undefined && isAssetDefaultFile(file) ? [[name, file] as const] : [])));
  const references = literalReferences(source, new Set(files.keys()));
  if (references === undefined) {
    return undefined;
  }
  const used = references.map((reference) => [reference.name, files.get(reference.name) ?? ''] as const);
  return used.length === 0 ? source : { source, imports: Object.fromEntries(used) };
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
