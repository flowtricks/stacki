// Insertion recipes are project data, independent of either editor's page model.
import { assert } from '../core/assert';
import { boolean, list, object, optional, record, text } from '../core/boundary';
import { err, ok, type Result } from '../core/result';

export const COMPONENT_DEFAULTS_FILE = '.stacki/components.json';
export const DEFAULT_LIMITS = {
  componentsMax: 512,
  childrenMax: 32,
  depthMax: 12,
  nodesMax: 256,
  propsMax: 64,
  textCharsMax: 16_384,
  sourceCharsMax: 262_144,
  storedNodesMax: 4096,
} as const;

export type DefaultValue = string | number | boolean;
export interface ComponentRecipe {
  readonly props?: Readonly<Record<string, DefaultValue>>;
  readonly text?: string;
  readonly children?: readonly RecipeChild[];
}
export interface ComponentChild extends ComponentRecipe {
  readonly component: string;
  readonly inherit?: false;
}
export interface ElementChild extends ComponentRecipe {
  readonly element: string;
}
export type RecipeChild = ComponentChild | ElementChild | { readonly literal: string };
export interface ComponentDefaults {
  readonly version: 1;
  readonly components: Readonly<Record<string, ComponentRecipe>>;
}
export interface DefaultComponent {
  readonly importPath?: string;
  readonly file: string;
  readonly name: string;
  readonly props: readonly string[];
  readonly slots: readonly string[];
  readonly slotText: boolean;
}
export interface DefaultsSnapshot {
  readonly source?: string;
  readonly config: ComponentDefaults;
  readonly catalog: readonly DefaultComponent[];
}

export function componentFile(input: unknown): string {
  const value = text(input);
  if (value.length > 500 || !/^(src\/|node_modules\/(?:@[\w.-]+\/)?[\w.-]+\/)[\w./ -]+\.astro$/.test(value)) {
    throw new Error('Component defaults: expected a project-relative component .astro path');
  }
  if (value.split('/').some((part) => part.startsWith('.') || part === '')) {
    throw new Error('Component defaults: invalid path segment');
  }
  return value;
}

export function parseComponentDefaults(input: unknown): ComponentDefaults {
  const value = record(input);
  if (value['version'] !== 1) {
    throw new Error('Component defaults: unsupported version');
  }
  const entries = Object.entries(record(value['components']));
  if (entries.length > DEFAULT_LIMITS.componentsMax) {
    throw new Error('Component defaults: too many components');
  }
  let nodes = 0;
  const takeNode = () => {
    nodes += 1;
    if (nodes > DEFAULT_LIMITS.storedNodesMax) {
      throw new Error('Component defaults exceed the stored node limit');
    }
  };
  const components = Object.fromEntries(entries.map(([file, recipe]) => [componentFile(file), parseRecipe(recipe, 0, takeNode)]));
  assert(Object.keys(components).length === entries.length, 'Recipe parsing preserves every owner');
  assert(nodes <= DEFAULT_LIMITS.storedNodesMax, 'Parsed recipes fit the total node budget');
  return { version: 1, components };
}

export function parseDefaultsSource(source: string): Result<ComponentDefaults> {
  if (source.length > DEFAULT_LIMITS.sourceCharsMax) {
    return err({ code: 'invalid-defaults', message: 'Component defaults file exceeds 256 KiB.' });
  }
  try {
    const input: unknown = JSON.parse(source);
    return ok(parseComponentDefaults(input));
  } catch (error: unknown) {
    return err({
      code: 'invalid-defaults',
      message: error instanceof Error ? error.message : 'Invalid component defaults',
    });
  }
}

export const parseDefaultComponent = object({
  importPath: optional(text),
  file: componentFile,
  name: text,
  props: list(text),
  slots: list(text),
  slotText: boolean,
});
export const parseDefaultsSnapshot = object({
  source: optional(text),
  config: parseComponentDefaults,
  catalog: list(parseDefaultComponent),
});
export const parseDefaultsSave = object({
  source: optional(text),
  config: parseComponentDefaults,
});

export function defaultValue(input: unknown): DefaultValue {
  if (typeof input === 'boolean') {
    return input;
  }
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) {
      throw new Error('Default number must be finite');
    }
    return input;
  }
  const value = text(input);
  if (value.length > DEFAULT_LIMITS.textCharsMax) {
    throw new Error('Default text exceeds 16 KiB');
  }
  return value;
}

function parseRecipe(input: unknown, depth: number, takeNode: () => void): ComponentRecipe {
  takeNode();
  if (depth > DEFAULT_LIMITS.depthMax) {
    throw new Error('Component defaults exceed the nesting limit');
  }
  const value = record(input);
  const props = value['props'];
  const content = value['text'];
  const children = value['children'];
  if (content !== undefined && children !== undefined) {
    throw new Error('Choose text or children for a recipe, not both');
  }
  return {
    ...(props === undefined ? {} : { props: parseRecipeProps(props) }),
    ...(content === undefined ? {} : { text: parseRecipeText(content) }),
    ...(children === undefined ? {} : { children: parseRecipeChildren(children, depth, takeNode) }),
  };
}

function parseRecipeText(input: unknown): string {
  const value = defaultValue(input);
  if (typeof value !== 'string') {
    throw new Error('Default text must be a string');
  }
  return value;
}

function parseRecipeProps(input: unknown): Readonly<Record<string, DefaultValue>> {
  const entries = Object.entries(record(input));
  if (entries.length > DEFAULT_LIMITS.propsMax) {
    throw new Error('Too many default props');
  }
  return Object.fromEntries(
    entries.map(([name, value]) => {
      if (!/^[A-Za-z_][\w:-]{0,99}$/.test(name)) {
        throw new Error('Invalid default prop name');
      }
      return [name, defaultValue(value)];
    }),
  );
}

function parseRecipeChildren(input: unknown, depth: number, takeNode: () => void): readonly RecipeChild[] {
  const values = list(record)(input);
  if (values.length > DEFAULT_LIMITS.childrenMax) {
    throw new Error('Too many default children');
  }
  return values.map((value) => {
    if (depth + 1 > DEFAULT_LIMITS.depthMax) {
      throw new Error('Default children exceed the depth limit');
    }
    const kinds = ['literal', 'element', 'component'].filter((key) => value[key] !== undefined);
    if (kinds.length !== 1) {
      throw new Error('A default child must name exactly one component, element, or literal');
    }
    if (value['literal'] !== undefined) {
      takeNode();
      return { literal: parseRecipeText(value['literal']) };
    }
    const recipe = parseRecipe(value, depth + 1, takeNode);
    if (value['element'] !== undefined) {
      const element = text(value['element']);
      if (!/^[a-z][a-z0-9-]{0,99}$/.test(element)) {
        throw new Error('Invalid default HTML element');
      }
      return { element, ...recipe };
    }
    if (value['inherit'] !== undefined && value['inherit'] !== false) {
      throw new Error('Captured child defaults use inherit: false');
    }
    return {
      component: componentFile(value['component']),
      ...recipe,
      ...(value['inherit'] === false ? { inherit: false as const } : {}),
    };
  });
}

export interface ResolvedContent {
  readonly props: Readonly<Record<string, DefaultValue>>;
  readonly content:
    { readonly kind: 'empty' } | { readonly kind: 'text'; readonly text: string } | { readonly kind: 'children'; readonly children: readonly ResolvedNode[] };
}
export interface ResolvedRecipe extends ResolvedContent {
  readonly component: string;
}
export type ResolvedNode = ResolvedRecipe | (ResolvedContent & { readonly element: string }) | { readonly literal: string };

export function resolveComponentRecipe(file: string, config: ComponentDefaults, catalog: readonly DefaultComponent[]): Result<ResolvedRecipe> {
  assertRecipeCatalog(config, catalog);
  // Each insertion owns its budget; expansion cannot grow exponentially without a cap.
  let remaining = DEFAULT_LIMITS.nodesMax;
  const resolveChild = (child: RecipeChild, ancestors: readonly string[], depth: number): Result<ResolvedNode> => {
    if ('component' in child) {
      return resolve(child.component, child, ancestors, depth);
    }
    if (depth > DEFAULT_LIMITS.depthMax || remaining-- <= 0) {
      return err({ code: 'recipe-limit', message: 'Default children exceed the insertion limit.' });
    }
    if ('literal' in child) {
      return ok(child);
    }
    return resolveElement(child, (nested) => resolveChild(nested, ancestors, depth + 1));
  };
  const resolve = (
    target: string,
    override: ComponentRecipe & { readonly inherit?: false },
    ancestors: readonly string[],
    depth: number,
  ): Result<ResolvedRecipe> => {
    if (depth > DEFAULT_LIMITS.depthMax || remaining-- <= 0) {
      return err({ code: 'recipe-limit', message: 'Default children exceed the insertion limit.' });
    }
    if (override.inherit !== false && ancestors.includes(target) && override.children === undefined && override.text === undefined) {
      return err({ code: 'recipe-cycle', message: `Default children form a cycle at ${target}.` });
    }
    const component = catalog.find((item) => item.file === target);
    if (!component) {
      return err({ code: 'missing-component', message: `Component defaults reference ${target}.` });
    }
    const base = override.inherit === false ? {} : (config.components[target] ?? {});
    const recipe = recipeOverride(base, override);
    const props = recipe.props ?? {};
    if (recipe.text !== undefined) {
      if (!component.slots.includes('default')) {
        return err({ code: 'missing-slot', message: `${target} has no default slot for text.` });
      }
      return ok({ component: target, props, content: { kind: 'text', text: recipe.text } });
    }
    if (recipe.children === undefined) {
      return ok({ component: target, props, content: { kind: 'empty' } });
    }
    return resolveComponentChildren(target, props, recipe.children, component.slots, (child) => resolveChild(child, [...ancestors, target], depth + 1));
  };
  return resolve(file, {}, [], 0);
}

function assertRecipeCatalog(config: ComponentDefaults, catalog: readonly DefaultComponent[]) {
  assert(catalog.length <= 10_000, 'Component catalog is bounded');
  assert(config.version === 1, 'Resolver supports recipe version 1');
  assert(new Set(catalog.map((item) => item.file)).size === catalog.length, 'Each component path has one catalog entry');
  assert(Object.keys(config.components).length <= DEFAULT_LIMITS.componentsMax, 'Parsed recipes have bounded owners');
}

function resolveComponentChildren(
  target: string,
  props: Readonly<Record<string, DefaultValue>>,
  recipes: readonly RecipeChild[],
  slots: readonly string[],
  resolve: (child: RecipeChild) => Result<ResolvedNode>,
): Result<ResolvedRecipe> {
  const children: ResolvedNode[] = [];
  for (const child of recipes) {
    const resolved = resolve(child);
    if (!resolved.ok) {
      return resolved;
    }
    const slot = 'literal' in resolved.value ? 'default' : (resolved.value.props['slot'] ?? 'default');
    if (typeof slot !== 'string' || !slots.includes(slot)) {
      return err({ code: 'missing-slot', message: `${target} has no slot "${String(slot)}".` });
    }
    children.push(resolved.value);
  }
  assert(children.length === recipes.length, 'Every requested child was resolved');
  assert(children.length <= DEFAULT_LIMITS.childrenMax, 'Resolved children respect the recipe cap');
  return ok({ component: target, props, content: { kind: 'children', children } });
}

function resolveElement(recipe: ElementChild, resolve: (child: RecipeChild) => Result<ResolvedNode>): Result<ResolvedNode> {
  const base = { element: recipe.element, props: recipe.props ?? {} };
  if (recipe.text !== undefined) {
    return ok({ ...base, content: { kind: 'text', text: recipe.text } });
  }
  if (recipe.children === undefined) {
    return ok({ ...base, content: { kind: 'empty' } });
  }
  const children: ResolvedNode[] = [];
  for (const child of recipe.children) {
    const result = resolve(child);
    if (!result.ok) {
      return result;
    }
    children.push(result.value);
  }
  assert(children.length === recipe.children.length, 'Every element child resolves');
  assert(children.length <= DEFAULT_LIMITS.childrenMax, 'Element children are bounded');
  return ok({ ...base, content: { kind: 'children', children } });
}
function recipeOverride(base: ComponentRecipe, override: ComponentRecipe): ComponentRecipe {
  const props = { ...base.props, ...override.props };
  if (override.text !== undefined) {
    return { props, text: override.text };
  }
  if (override.children !== undefined) {
    return { props, children: override.children };
  }
  return { ...base, props };
}

export function defaultsIssues(config: ComponentDefaults, catalog: readonly DefaultComponent[]): readonly string[] {
  assert(config.version === 1, 'Diagnostics use the current recipe version');
  assert(Object.keys(config.components).length <= DEFAULT_LIMITS.componentsMax, 'Diagnostics have bounded work');
  return Object.keys(config.components).flatMap((file) => {
    const result = resolveComponentRecipe(file, config, catalog);
    return result.ok ? [] : [result.error.message];
  });
}

/** Relinking after a move updates owners and every nested child reference together. */
export function relinkDefaults(config: ComponentDefaults, from: string, to: string): Result<ComponentDefaults> {
  assert(config.version === 1, 'Relink only changes the current recipe format');
  assert(Object.keys(config.components).length <= DEFAULT_LIMITS.componentsMax, 'Relink starts from bounded parsed configuration');
  if (from !== to && config.components[to] !== undefined) {
    return err({
      code: 'duplicate-defaults',
      message: 'The target already has component defaults.',
    });
  }
  const rename = (recipe: ComponentRecipe, depth: number): ComponentRecipe => {
    assert(depth <= DEFAULT_LIMITS.depthMax, 'Relink depth is bounded by the recipe parser');
    return {
      ...recipe,
      ...(recipe.children === undefined
        ? {}
        : {
            children: recipe.children.map((child) => ({
              ...('literal' in child
                ? child
                : {
                    ...rename(child, depth + 1),
                    ...('component' in child ? { component: child.component === from ? to : child.component } : { element: child.element }),
                  }),
            })),
          }),
    };
  };
  return ok({
    version: 1,
    components: Object.fromEntries(Object.entries(config.components).map(([file, recipe]) => [file === from ? to : file, rename(recipe, 0)])),
  });
}
