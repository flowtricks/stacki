// What a component preview renders when the project gives the component an insertion recipe.
//
// `.stacki/components.json` says what a component holds when it is inserted: its props, its text,
// or the components and elements nested in it (shared/properties/componentDefaults.ts). A preview
// of the component, in the Components panel's hover card or in an insert palette card, shows that
// same thing, so what is previewed is what the insert produces. A component without a recipe, an
// unreadable file or a recipe that does not resolve keeps the preview's own inputs (componentPreview.ts).
//
// This runs inside the project's dev server, so it imports only unpacked runtime modules
// (electron/parse and shared). It reads source; it never evaluates it.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assert } from '../../shared/core/assert';
import {
  COMPONENT_DEFAULTS_FILE,
  DEFAULT_LIMITS,
  parseDefaultsSource,
  resolveComponentRecipe,
  type ComponentDefaults,
  type DefaultComponent,
  type DefaultValue,
  type RecipeChild,
  type ResolvedContent,
  type ResolvedNode,
  type ResolvedRecipe,
} from '../../shared/properties/componentDefaults';
import { defaultSlotInline, parsePropSchema, parseSlots } from '../parse/astroParser';
import { parseAttrs } from '../parse/astroAttrs';
import { scanTag } from '../parse/astroTag';
import { literalProps, type PreviewImport } from './componentPreviewContext';

export const RECIPE_LIMITS = {
  /** The largest component source read to learn its slots; the preview route reads the same bound. */
  sourceBytesMax: 10 * 1024 * 1024,
  /**
   * Distinct slots one component's recipe children fill. Astro names a child's slot when it compiles
   * the template, so the node component has a fixed number of slot positions; a recipe that needs
   * more is previewed without it.
   */
  slotsMax: 8,
} as const satisfies Record<string, number>;

/**
 * A recipe node as the route renders it. A component's children are grouped by the slot they go
 * to, because the node component places each group in one of its fixed slot positions.
 */
export type PreviewRecipeNode =
  | { readonly literal: string }
  | { readonly element: string; readonly props: Readonly<Record<string, DefaultValue>>; readonly content: PreviewRecipeContent<readonly PreviewRecipeNode[]> }
  | {
      readonly component: string;
      readonly props: Readonly<Record<string, DefaultValue>>;
      readonly content: PreviewRecipeContent<readonly PreviewRecipeSlot[]>;
    };

export type PreviewRecipeContent<Children> =
  { readonly kind: 'empty' } | { readonly kind: 'text'; readonly text: string } | { readonly kind: 'children'; readonly children: Children };

export interface PreviewRecipeSlot {
  readonly name: string;
  readonly children: readonly PreviewRecipeNode[];
}

export interface PreviewRecipe {
  readonly recipe: ResolvedRecipe;
  /** The owner and its children as the route renders them. */
  readonly node: Extract<PreviewRecipeNode, { readonly component: string }>;
  /** Every component file the recipe renders, the owner first, each once, for the route to load. */
  readonly files: readonly string[];
}

/** The file the defaults live in, absolute, so the route can watch it. */
export function previewDefaultsPath(projectDirectory: string): string {
  assert(path.isAbsolute(projectDirectory), 'Preview defaults: the project directory is absolute');
  return path.join(projectDirectory, COMPONENT_DEFAULTS_FILE);
}

/**
 * The project's insertion recipes, or undefined when it has none. A file that does not parse is the
 * project's to fix in the defaults editor, which reports it; a preview just goes without it.
 */
export function readPreviewDefaults(projectDirectory: string): ComponentDefaults | undefined {
  const file = previewDefaultsPath(projectDirectory);
  let source: string;
  try {
    if (fs.statSync(file).size > DEFAULT_LIMITS.sourceCharsMax) {
      return undefined;
    }
    source = fs.readFileSync(file, 'utf8');
  } catch {
    // No defaults file: the project never saved a recipe.
    return undefined;
  }
  const parsed = parseDefaultsSource(source);
  return parsed.ok ? parsed.value : undefined;
}

/** The recipe `relative` (a project-relative component path) is previewed with, when the project gives it one. */
export function componentPreviewRecipe(projectDirectory: string, relative: string, config: ComponentDefaults): PreviewRecipe | undefined {
  assert(path.isAbsolute(projectDirectory), 'Preview recipe: the project directory is absolute');
  assert(!relative.startsWith('/'), 'Preview recipe: the component path is project-relative');
  if (config.components[relative] === undefined) {
    return undefined;
  }
  const catalog = recipeCatalog(projectDirectory, config, relative);
  const resolved = resolveComponentRecipe(relative, config, catalog);
  if (!resolved.ok) {
    return undefined;
  }
  const node = previewRecipeNode(resolved.value, 0);
  if (node === undefined || !('component' in node)) {
    return undefined;
  }
  const files = [relative, ...recipeFiles(resolved.value).filter((file) => file !== relative)];
  assert(files.length <= DEFAULT_LIMITS.nodesMax + 1, 'Preview recipe: rendered components are bounded by the recipe node limit');
  return { recipe: resolved.value, node, files };
}

/** The route's form of a resolved node, or undefined when a component's children fill more slots than the route has. */
export function previewRecipeNode(node: ResolvedNode, depth: number): PreviewRecipeNode | undefined {
  // The resolver refuses deeper recipes, so the recursion is bounded by the same limit.
  assert(depth <= DEFAULT_LIMITS.depthMax, 'Preview recipe: node depth is bounded');
  if ('literal' in node) {
    return node;
  }
  const children: PreviewRecipeNode[] = [];
  if (node.content.kind === 'children') {
    for (const child of node.content.children) {
      const converted = previewRecipeNode(child, depth + 1);
      if (converted === undefined) {
        return undefined;
      }
      children.push(converted);
    }
  }
  if ('element' in node) {
    if (node.content.kind === 'children') {
      return { element: node.element, props: node.props, content: { kind: 'children', children } };
    }
    return { element: node.element, props: node.props, content: node.content };
  }
  if (node.content.kind === 'children') {
    const slots = slotGroups(children);
    if (slots.length > RECIPE_LIMITS.slotsMax) {
      return undefined;
    }
    return { component: node.component, props: node.props, content: { kind: 'children', children: slots } };
  }
  return { component: node.component, props: node.props, content: node.content };
}

// Children in recipe order, grouped by the slot their `slot` prop names (`default` without one).
function slotGroups(children: readonly PreviewRecipeNode[]): readonly PreviewRecipeSlot[] {
  const groups = new Map<string, PreviewRecipeNode[]>();
  for (const child of children) {
    const name = slotOf(child);
    const group = groups.get(name);
    if (group === undefined) {
      groups.set(name, [child]);
    } else {
      group.push(child);
    }
  }
  const slots = [...groups].map(([name, nodes]) => ({ name, children: nodes }));
  assert(slots.reduce((total, slot) => total + slot.children.length, 0) === children.length, 'Preview recipe: every child is in one slot');
  return slots;
}

function slotOf(node: PreviewRecipeNode): string {
  if ('literal' in node) {
    return 'default';
  }
  const slot = node.props['slot'];
  return typeof slot === 'string' ? slot : 'default';
}

/** The components a resolved recipe renders beneath its owner, in first-use order, each once. */
export function recipeFiles(recipe: ResolvedRecipe): readonly string[] {
  const files = new Set<string>();
  const pending: ResolvedNode[] = recipe.content.kind === 'children' ? [...recipe.content.children] : [];
  // The resolver caps a recipe at nodesMax nodes, so the walk visits at most that many.
  for (let index = 0; index < pending.length; index++) {
    assert(index < DEFAULT_LIMITS.nodesMax, 'Preview recipe: the walk stays inside the node limit');
    const node = pending[index];
    assert(node !== undefined, 'Preview recipe: a pending node exists');
    if ('literal' in node) {
      continue;
    }
    if ('component' in node) {
      files.add(node.component);
    }
    if (node.content.kind === 'children') {
      pending.push(...node.content.children);
    }
  }
  return [...files];
}

// The catalog the resolver checks slots against: the owner and every component a recipe names,
// read from their own source. A file that cannot be read is left out, and the resolver then
// reports the recipe as unresolved, which leaves the preview on its own inputs.
function recipeCatalog(projectDirectory: string, config: ComponentDefaults, owner: string): readonly DefaultComponent[] {
  const files = new Set<string>([owner]);
  for (const [file, recipe] of Object.entries(config.components)) {
    files.add(file);
    for (const child of recipe.children ?? []) {
      addChildFiles(child, files, 0);
    }
  }
  assert(files.size <= DEFAULT_LIMITS.storedNodesMax + 1, 'Preview recipe: the catalog is bounded by the stored node limit');
  const catalog: DefaultComponent[] = [];
  for (const file of files) {
    const entry = catalogEntry(projectDirectory, file);
    if (entry !== undefined) {
      catalog.push(entry);
    }
  }
  return catalog;
}

function addChildFiles(child: RecipeChild, files: Set<string>, depth: number): void {
  // The parser already refused deeper recipes; this states the bound the recursion relies on.
  assert(depth <= DEFAULT_LIMITS.depthMax, 'Preview recipe: child depth is bounded');
  if ('literal' in child) {
    return;
  }
  if ('component' in child) {
    files.add(child.component);
  }
  for (const nested of child.children ?? []) {
    addChildFiles(nested, files, depth + 1);
  }
}

function catalogEntry(projectDirectory: string, file: string): DefaultComponent | undefined {
  const absolute = path.join(projectDirectory, file);
  assert(absolute.startsWith(projectDirectory), 'Preview recipe: a component path stays inside the project');
  let source: string;
  try {
    if (fs.statSync(absolute).size > RECIPE_LIMITS.sourceBytesMax) {
      return undefined;
    }
    source = fs.readFileSync(absolute, 'utf8');
  } catch {
    return undefined;
  }
  return {
    file,
    name: path.basename(file, '.astro'),
    props: parsePropSchema(source).map((field) => field.name),
    slots: parseSlots(source),
    slotText: defaultSlotInline(source),
  };
}

/** The longest instance children read into nodes; a larger body is not a sample worth the parse. */
const instanceMarkupCharsMax = 64 * 1024;

/** What an expression child (`{text}`) shows: the page's value is out of reach, so a neutral line stands in. */
export const PREVIEW_EXPRESSION_TEXT = 'Lorem ipsum dolor sit amet';

const VOID_ELEMENTS: ReadonlySet<string> = new Set(['area', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

interface MarkupFrame {
  /** Undefined for the root and for a `<Fragment>`, whose children belong to its parent. */
  readonly tag: string | undefined;
  readonly node: { readonly component: string } | { readonly element: string } | undefined;
  readonly props: Record<string, DefaultValue>;
  readonly children: ResolvedNode[];
}

/**
 * A page instance's children as nodes the route renders: what the site shows inside the component
 * when the project gives it no recipe. Components resolve through the host file's imports; literal
 * attributes are kept and the rest dropped; an expression child becomes a neutral line of text; a
 * `<Fragment slot="x">` hands its slot to each child. Anything else (an unknown component, scripts,
 * mismatched tags, a body past the bounds) answers undefined, and the preview keeps its placeholder.
 */
export function instanceMarkupNodes(markup: string, imports: ReadonlyArray<PreviewImport>): readonly ResolvedNode[] | undefined {
  if (markup.length > instanceMarkupCharsMax) {
    return undefined;
  }
  const root: MarkupFrame = { tag: undefined, node: undefined, props: {}, children: [] };
  const stack: MarkupFrame[] = [root];
  let nodes = 0;
  let position = 0;
  // Each pass consumes at least one character, so the loop ends within the markup's length.
  for (let pass = 0; position < markup.length; pass++) {
    assert(pass <= instanceMarkupCharsMax, 'Preview instance: the markup walk advances');
    const top = stack.at(-1);
    assert(top !== undefined, 'Preview instance: the root frame stays on the stack');
    if (markup.startsWith('<!--', position)) {
      const end = markup.indexOf('-->', position + 4);
      if (end < 0) {
        return undefined;
      }
      position = end + 3;
    } else if (markup.startsWith('</', position)) {
      const end = markup.indexOf('>', position);
      const name = end < 0 ? '' : markup.slice(position + 2, end).trim();
      if (stack.length < 2 || top.tag !== name) {
        return undefined;
      }
      stack.pop();
      const parent = stack.at(-1);
      assert(parent !== undefined, 'Preview instance: a closed tag has a parent');
      parent.children.push(...closeFrame(top));
      position = end + 1;
    } else if (markup.charAt(position) === '<' && /[A-Za-z]/.test(markup.charAt(position + 1))) {
      const tag = scanTag(markup, position);
      if (tag === undefined) {
        return undefined;
      }
      const frame = openFrame(tag.name, tag.attrs, imports);
      if (frame === undefined) {
        return undefined;
      }
      nodes += 1;
      if (nodes > DEFAULT_LIMITS.nodesMax) {
        return undefined;
      }
      if (tag.selfClose === '/' || VOID_ELEMENTS.has(tag.name)) {
        top.children.push(...closeFrame(frame));
      } else if (stack.length <= DEFAULT_LIMITS.depthMax) {
        stack.push(frame);
      } else {
        return undefined;
      }
      position = tag.end;
    } else if (markup.charAt(position) === '{') {
      const end = expressionEnd(markup, position);
      if (end === undefined) {
        return undefined;
      }
      const expression = markup.slice(position + 1, end).trim();
      // A plain value reads as text on the page; a map or a condition would be markup we cannot see.
      if (/^[\w$.]+$/.test(expression)) {
        top.children.push({ literal: PREVIEW_EXPRESSION_TEXT });
      }
      position = end + 1;
    } else {
      const next = nextMarkup(markup, position);
      const text = markup.slice(position, next).replace(/\s+/g, ' ');
      if (text.trim() !== '') {
        top.children.push({ literal: text.trim() });
      }
      position = next;
    }
  }
  if (stack.length !== 1) {
    return undefined;
  }
  if (root.children.length > DEFAULT_LIMITS.childrenMax) {
    return undefined;
  }
  return root.children;
}

function openFrame(name: string, attributes: string, imports: ReadonlyArray<PreviewImport>): MarkupFrame | undefined {
  if (name === 'script' || name === 'style') {
    return undefined;
  }
  const props: Record<string, DefaultValue> = { ...literalProps(attributes) };
  const slot = parseAttrs(attributes)['slot'];
  if (slot?.type === 'string') {
    props['slot'] = slot.value;
  }
  if (name === 'Fragment') {
    return { tag: name, node: undefined, props, children: [] };
  }
  if (/^[a-z][a-z0-9-]*$/.test(name)) {
    return { tag: name, node: { element: name }, props, children: [] };
  }
  const imported = imports.find((candidate) => candidate.name === name);
  if (imported === undefined) {
    return undefined;
  }
  return { tag: name, node: { component: imported.relative }, props, children: [] };
}

// A closed tag as the nodes it adds to its parent: one node, or a fragment's children with its slot.
function closeFrame(frame: MarkupFrame): readonly ResolvedNode[] {
  const content: ResolvedContent['content'] = frame.children.length === 0 ? { kind: 'empty' } : { kind: 'children', children: frame.children };
  if (frame.node === undefined) {
    const slot = frame.props['slot'];
    if (typeof slot !== 'string') {
      return frame.children;
    }
    // Text directly in a slotted fragment has no element to carry the slot, so it is left out.
    return frame.children.flatMap((child) => ('literal' in child ? [] : [{ ...child, props: { ...child.props, slot } }]));
  }
  if ('component' in frame.node) {
    return [{ component: frame.node.component, props: frame.props, content }];
  }
  return [{ element: frame.node.element, props: frame.props, content }];
}

/** The index of the `}` that closes the expression opening at `start`, counting nested braces. */
function expressionEnd(markup: string, start: number): number | undefined {
  let depth = 0;
  for (let index = start; index < markup.length; index++) {
    const character = markup.charAt(index);
    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return undefined;
}

function nextMarkup(markup: string, from: number): number {
  const tag = markup.indexOf('<', from + 1);
  const expression = markup.indexOf('{', from + 1);
  const candidates = [tag, expression].filter((index) => index >= 0);
  return candidates.length === 0 ? markup.length : Math.min(...candidates);
}

/** A page instance's children as the recipe the route renders, with the instance's literal props on the owner. */
export function instancePreviewRecipe(
  relative: string,
  props: Readonly<Record<string, DefaultValue>>,
  children: readonly ResolvedNode[],
): PreviewRecipe | undefined {
  assert(!relative.startsWith('/'), 'Preview instance: the component path is project-relative');
  assert(children.length <= DEFAULT_LIMITS.childrenMax, 'Preview instance: children are bounded');
  const recipe: ResolvedRecipe = { component: relative, props, content: children.length === 0 ? { kind: 'empty' } : { kind: 'children', children } };
  const node = previewRecipeNode(recipe, 0);
  if (node === undefined || !('component' in node)) {
    return undefined;
  }
  return { recipe, node, files: [relative, ...recipeFiles(recipe).filter((file) => file !== relative)] };
}
