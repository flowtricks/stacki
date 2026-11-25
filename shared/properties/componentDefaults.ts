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
/**
 * How one field of a component is typed in, set where the field's name and tooltip are (the Properties panel): a
 * prop by its name, a slot as `slot:<name>` (`slot:default` for the content between the tags). Stored on the
 * component's own recipe under `editing`, and only while on: an absent key is off, and a field with nothing on and a
 * recipe with no field left go with it, so turning a setting on and off leaves the file as it was. Older Stacki
 * versions read a recipe key by key and skip `editing` (parseRecipe), so the file stays readable to them.
 */
export const EDITING_SETTINGS = ['lineBreaks', 'richText'] as const;
export type EditingSetting = (typeof EDITING_SETTINGS)[number];
export type EditingSettings = { readonly [Setting in EditingSetting]?: true };
/** A field's name in `editing`: a prop, or a slot. */
export type EditingField = string;
export const DEFAULT_SLOT_FIELD = 'slot:default';
export const EDITING_FIELDS_MAX = 64;
/** A component's own recipe: what it inserts with, and how its fields are typed in. Children recipes carry no editing. */
export type OwnerRecipe = ComponentRecipe & { readonly editing?: Readonly<Record<EditingField, EditingSettings>> };
export interface ComponentDefaults {
  readonly version: 1;
  readonly components: Readonly<Record<string, OwnerRecipe>>;
}
export interface DefaultComponent {
  readonly importPath?: string;
  readonly file: string;
  readonly name: string;
  readonly props: readonly string[];
  readonly slots: readonly string[];
  readonly slotText: boolean;
  /** The template sets HTML from a value (`set:html`). Absent from an older host: false. */
  readonly setHtml?: boolean;
  /** Props the template sets with `set:html`. Absent from an older host: none. */
  readonly htmlProps?: readonly string[];
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
  const components = Object.fromEntries(
    entries.map(([file, recipe]) => [componentFile(file), { ...parseRecipe(recipe, 0, takeNode), ...parseEditing(record(recipe)['editing']) }]),
  );
  assert(Object.keys(components).length === entries.length, 'Recipe parsing preserves every owner');
  assert(nodes <= DEFAULT_LIMITS.storedNodesMax, 'Parsed recipes fit the total node budget');
  return { version: 1, components };
}

/** A field name: a prop name, or `slot:` and a slot's name. */
export function editingField(input: unknown): EditingField {
  const value = text(input);
  if (!/^(?:[A-Za-z_$][\w$]{0,99}|slot:[\w-]{1,100})$/.test(value)) {
    throw new Error('Component defaults: an editing field is a prop name or slot:<name>');
  }
  return value;
}

function parseEditing(input: unknown): Pick<OwnerRecipe, 'editing'> {
  if (input === undefined) {
    return {};
  }
  const entries = Object.entries(record(input));
  if (entries.length > EDITING_FIELDS_MAX) {
    throw new Error('Component defaults: too many editing fields');
  }
  const editing = Object.fromEntries(entries.map(([field, settings]) => [editingField(field), parseEditingSettings(record(settings))]));
  assert(Object.keys(editing).length === entries.length, 'Each editing field is read once');
  return { editing };
}

// Each setting is `true` or absent; `false` is refused rather than kept, so "off" has one spelling (no key) and a
// hand-edited `false` cannot sit in the file looking like a choice the editor would show.
function parseEditingSettings(value: Readonly<Record<string, unknown>>): EditingSettings {
  const settings: { [Setting in EditingSetting]?: true } = {};
  for (const setting of EDITING_SETTINGS) {
    const stored = value[setting];
    if (stored === undefined) {
      continue;
    }
    if (stored !== true) {
      throw new Error(`Component defaults: ${setting} is true or left out`);
    }
    settings[setting] = true;
  }
  assert(Object.keys(settings).length <= EDITING_SETTINGS.length, 'Each editing setting is read once');
  return settings;
}

/**
 * Which settings a field of a component can have: rich text where the field takes several HTML children (the default
 * slot when it is not inside a line of words, a named slot, or a prop the template sets with `set:html`); line breaks
 * wherever a `<br>` renders as a break (a slot, or a `set:html` prop). A prop printed as text (`{title}`) escapes a
 * `<br>`, and one used as an attribute (href, alt, class) would hold it literally, so neither is offered there.
 */
export function editingOffered(component: Pick<DefaultComponent, 'slots' | 'slotText' | 'htmlProps'>, field: EditingField): readonly EditingSetting[] {
  if (field.startsWith('slot:')) {
    const slot = field.slice('slot:'.length);
    if (!component.slots.includes(slot)) {
      return [];
    }
    return slot === 'default' && component.slotText ? ['lineBreaks'] : ['lineBreaks', 'richText'];
  }
  return (component.htmlProps ?? []).includes(field) ? ['lineBreaks', 'richText'] : [];
}

/** The settings stored for one field, whether or not the component still offers them. */
export function fieldEditing(config: ComponentDefaults, file: string, field: EditingField): EditingSettings {
  return config.components[file]?.editing?.[field] ?? {};
}

/** The settings that apply to a field now: a stored one the field no longer offers is ignored, kept, and named by check-project. */
export function effectiveEditing(config: ComponentDefaults, component: DefaultComponent, field: EditingField): EditingSettings {
  const offered = editingOffered(component, field);
  const stored = fieldEditing(config, component.file, field);
  return Object.fromEntries(EDITING_SETTINGS.flatMap((setting) => (stored[setting] === true && offered.includes(setting) ? [[setting, true] as const] : [])));
}

/**
 * The configuration with one setting of one field turned on or off. Off removes the key, then a field left empty, then
 * `editing` left empty, then a recipe left with nothing: on and off again leaves the file as it was.
 */
export function withFieldEditing(
  config: ComponentDefaults,
  target: { readonly file: string; readonly field: EditingField },
  change: { readonly setting: EditingSetting; readonly state: 'on' | 'off' },
): ComponentDefaults {
  const owner = componentFile(target.file);
  const field = editingField(target.field);
  const existing: OwnerRecipe = config.components[owner] ?? {};
  const settings: EditingSettings = Object.fromEntries(Object.entries(existing.editing?.[field] ?? {}).filter(([key]) => key !== change.setting));
  const nextSettings: EditingSettings = change.state === 'on' ? { ...settings, [change.setting]: true } : settings;
  const fields = Object.fromEntries(Object.entries(existing.editing ?? {}).filter(([key]) => key !== field));
  const editing = Object.keys(nextSettings).length === 0 ? fields : { ...fields, [field]: nextSettings };
  const recipe: OwnerRecipe = withoutEditing(existing);
  const next: OwnerRecipe = Object.keys(editing).length === 0 ? recipe : { ...recipe, editing };
  assert(Object.keys(editing).length <= EDITING_FIELDS_MAX + 1, 'A toggle adds at most one field');
  const others = Object.entries(config.components).filter(([key]) => key !== owner);
  const dropped = Object.keys(next).length === 0 && config.components[owner] !== undefined && Object.keys(existing).every((key) => key === 'editing');
  const result: ComponentDefaults = { version: 1, components: Object.fromEntries(keepOrder(config, dropped ? others : [...others, [owner, next] as const])) };
  assert((result.components[owner]?.editing?.[field]?.[change.setting] === true) === (change.state === 'on'), 'The setting reads back as it was set');
  return result;
}

/** A field renamed (a prop renamed in the Properties panel) or removed (`to` undefined), its settings going with it. */
export function withEditingFieldMoved(config: ComponentDefaults, file: string, from: EditingField, to: EditingField | undefined): ComponentDefaults {
  const recipe = config.components[file];
  const moved = recipe?.editing?.[from];
  if (recipe?.editing === undefined || moved === undefined) {
    return config;
  }
  const rest = Object.fromEntries(Object.entries(recipe.editing).filter(([key]) => key !== from));
  const editing = to === undefined ? rest : { ...rest, [editingField(to)]: moved };
  const plain = withoutEditing(recipe);
  const next: OwnerRecipe = Object.keys(editing).length === 0 ? plain : { ...plain, editing };
  return { version: 1, components: { ...config.components, [file]: next } };
}

function withoutEditing(recipe: OwnerRecipe): OwnerRecipe {
  return Object.fromEntries(Object.entries(recipe).filter(([key]) => key !== 'editing'));
}

// Owners keep the order the file wrote them in; a new owner goes last, so a toggle's diff is the toggle.
function keepOrder(config: ComponentDefaults, entries: readonly (readonly [string, OwnerRecipe])[]): readonly (readonly [string, OwnerRecipe])[] {
  const order = Object.keys(config.components);
  const rank = (key: string) => {
    const index = order.indexOf(key);
    return index === -1 ? order.length : index;
  };
  return [...entries].sort((left, right) => rank(left[0]) - rank(right[0]));
}

export function parseDefaultsSource(source: string): Result<ComponentDefaults> {
  if (source.length > DEFAULT_LIMITS.sourceCharsMax) {
    // i18n-ignore: a refusal about a hand-edited .stacki/components.json recipe; callers throw it into the generic error path, which has no reference channel (leftover for the defaults area).
    return err({ code: 'invalid-defaults', message: 'Component defaults file exceeds 256 KiB.' });
  }
  try {
    const input: unknown = JSON.parse(source);
    return ok(parseComponentDefaults(input));
  } catch (error: unknown) {
    // i18n-ignore: a refusal about a hand-edited .stacki/components.json recipe; callers throw it into the generic error path, which has no reference channel (leftover for the defaults area).
    return err({
      code: 'invalid-defaults',
      // i18n-ignore: the fallback for a thrown value that is not an Error, reached only by a hand-edited .stacki/components.json.
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
  setHtml: optional(boolean),
  htmlProps: optional(list(text)),
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
      // i18n-ignore: a refusal about a hand-edited .stacki/components.json recipe; callers throw it into the generic error path, which has no reference channel (leftover for the defaults area).
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
      // i18n-ignore: a refusal about a hand-edited .stacki/components.json recipe; callers throw it into the generic error path, which has no reference channel (leftover for the defaults area).
      return err({ code: 'recipe-limit', message: 'Default children exceed the insertion limit.' });
    }
    if (override.inherit !== false && ancestors.includes(target) && override.children === undefined && override.text === undefined) {
      // i18n-ignore: a refusal about a hand-edited .stacki/components.json recipe; callers throw it into the generic error path, which has no reference channel (leftover for the defaults area).
      return err({ code: 'recipe-cycle', message: `Default children form a cycle at ${target}.` });
    }
    const component = catalog.find((item) => item.file === target);
    if (!component) {
      // i18n-ignore: a refusal about a hand-edited .stacki/components.json recipe; callers throw it into the generic error path, which has no reference channel (leftover for the defaults area).
      return err({ code: 'missing-component', message: `Component defaults reference ${target}.` });
    }
    const base = override.inherit === false ? {} : (config.components[target] ?? {});
    const recipe = recipeOverride(base, override);
    const props = recipe.props ?? {};
    if (recipe.text !== undefined) {
      if (!component.slots.includes('default')) {
        // i18n-ignore: a refusal about a hand-edited .stacki/components.json recipe; callers throw it into the generic error path, which has no reference channel (leftover for the defaults area).
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
      // i18n-ignore: a refusal about a hand-edited .stacki/components.json recipe; callers throw it into the generic error path, which has no reference channel (leftover for the defaults area).
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
    const component = catalog.find((entry) => entry.file === file);
    const ignored = Object.entries(config.components[file]?.editing ?? {}).flatMap(([field, settings]) =>
      EDITING_SETTINGS.filter((setting) => settings[setting] === true && component !== undefined && !editingOffered(component, field).includes(setting)).map(
        // i18n-ignore: check-project speaks to agents and scripts in English, like the recipe refusals above.
        (setting) => `${file} has ${setting} on for ${field}, which cannot take it (no such slot, or not a set:html prop); it is ignored.`,
      ),
    );
    return [...(result.ok ? [] : [result.error.message]), ...ignored];
  });
}

/** Relinking after a move updates owners and every nested child reference together. */
export function relinkDefaults(config: ComponentDefaults, from: string, to: string): Result<ComponentDefaults> {
  assert(config.version === 1, 'Relink only changes the current recipe format');
  assert(Object.keys(config.components).length <= DEFAULT_LIMITS.componentsMax, 'Relink starts from bounded parsed configuration');
  if (from !== to && config.components[to] !== undefined) {
    return err({
      code: 'duplicate-defaults',
      // i18n-ignore: no caller shows this refusal to a person yet (relinkDefaults has none outside tests); translate it with the caller that does.
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
