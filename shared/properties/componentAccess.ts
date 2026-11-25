// Which components a role may ADD to a page: the per-role visibility rules kept in
// `.stacki/roles.json` (shared/properties/projectRoles.ts holds the file; this module
// is the pure rules inside it). Desktop's palette, Studio's palette and Studio's server
// all ask the same questions here, so they cannot disagree.
//
// The model is a deny-list: everything is visible until a rule hides it, so a component
// created, moved or renamed later is enabled for every role with no migration. A rule is
// a component or a folder, and either hides (`hide`) or re-shows (`show`) it, so a folder
// can be hidden while one component inside it stays available. The most specific rule wins:
// the component's own rule, then its folder, then the folder above that, and so on. Paths
// are project-relative with `/` separators (`src/components/interactive/Tabs.astro`), so
// they hold for configured component folders and layouts too.
//
// Hiding stops ADDING, nothing else: a hidden component already on a page stays there,
// stays editable and still shows in the Navigator, and copying, pasting or duplicating
// markup that holds one is allowed because the component is already on the page. What a
// rule takes away depends on who holds it (`componentOffer`): an admin loses the component
// from search but keeps it in the Components panel to add by hand; every other role loses
// it from every place that adds, and Studio's server refuses it. Rules never touch settings access.
//
// A rule whose path no longer exists is kept, shown as "missing" in the Roles tab and
// ignored by resolution, so restoring the component or folder restores the rule.
import { assert } from '../core/assert';
import { record, text } from '../core/boundary';
import { toArray } from '../core/record';

export const COMPONENT_ACCESS_LIMITS = {
  /** Rules one role stores. A folder rule covers any number of components, so this is generous. */
  rulesMax: 1024,
  /** A project-relative component or folder path. */
  pathCharsMax: 512,
  /** Folders deep a component can sit; resolution walks this many ancestors at most. */
  pathDepthMax: 32,
} as const satisfies Record<string, number>;

/** Thrown when an edit would leave a role with more rules than the bound: an expected refusal, not a bug. */
export class ComponentRulesBoundError extends Error {
  override readonly name = 'ComponentRulesBoundError';
}

/** What a rule does to what it names. */
export type ComponentRuleEffect = 'hide' | 'show';

/** A rule on one component's file, or on every component under a folder. */
export type ComponentRule =
  | { readonly kind: 'component'; readonly path: string; readonly effect: ComponentRuleEffect }
  | { readonly kind: 'folder'; readonly path: string; readonly effect: ComponentRuleEffect };

/** Whether a role may add a component. */
export type ComponentState = 'visible' | 'hidden';

/** Why a component is in its state: nothing says otherwise, its own rule, or the folder whose rule reaches it. */
export type ComponentDecision =
  | { readonly kind: 'default' }
  | { readonly kind: 'component'; readonly effect: ComponentRuleEffect }
  | { readonly kind: 'folder'; readonly folder: string; readonly effect: ComponentRuleEffect };

export interface ComponentResolution {
  readonly state: ComponentState;
  readonly decision: ComponentDecision;
}

/** The rules of one role, ready to answer many questions: built once, read many times. */
export interface ComponentAccessIndex {
  readonly components: ReadonlyMap<string, ComponentRuleEffect>;
  readonly folders: ReadonlyMap<string, ComponentRuleEffect>;
}

/** What a rule names, for editing: a component file or a folder. */
export type ComponentTarget = { readonly kind: 'component' | 'folder'; readonly path: string };

/** A rule that names a project path, read once at the boundary: the file's text is never trusted past this. */
export function parseComponentPath(input: unknown): string {
  const raw = text(input).replaceAll('\\', '/');
  const path = raw.replace(/^\/+/, '').replace(/\/+$/, '');
  if (path.length === 0 || path.length > COMPONENT_ACCESS_LIMITS.pathCharsMax) {
    throw new Error(`A component path is 1 to ${COMPONENT_ACCESS_LIMITS.pathCharsMax} characters`);
  }
  const segments = path.split('/');
  if (segments.length > COMPONENT_ACCESS_LIMITS.pathDepthMax) {
    throw new Error(`A component path is at most ${COMPONENT_ACCESS_LIMITS.pathDepthMax} folders deep`);
  }
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error(`"${path}" is not a project path`);
    }
    if (/[\u0000-\u001f]/.test(segment)) {
      throw new Error(`"${path}" is not a project path`);
    }
  }
  assert(!path.startsWith('/'), 'A parsed component path is project-relative');
  assert(!path.endsWith('/'), 'A parsed component path has no trailing slash');
  return path;
}

/**
 * `componentRules: [{ kind: 'component' | 'folder', path, effect?: 'hide' | 'show' }]`. Absent is none.
 * A rule with no effect hides, so the common file is short. A repeated (kind, path) keeps its last rule.
 */
export function parseComponentRules(input: unknown): readonly ComponentRule[] {
  if (input === undefined) {
    return [];
  }
  const items = toArray(input);
  if (items === undefined) {
    throw new Error('Component rules must be a list');
  }
  if (items.length > COMPONENT_ACCESS_LIMITS.rulesMax) {
    throw new Error(`A role has at most ${COMPONENT_ACCESS_LIMITS.rulesMax} component rules`);
  }
  const keyed = new Map<string, ComponentRule>();
  for (const item of items) {
    const rule = parseComponentRule(item);
    keyed.set(ruleKey(rule), rule);
  }
  const rules = [...keyed.values()];
  assert(rules.length <= items.length, 'Deduplication never adds rules');
  return rules;
}

function parseComponentRule(input: unknown): ComponentRule {
  const value = record(input);
  const kind = value['kind'];
  const path = parseComponentPath(value['path']);
  const effect = parseEffect(value['effect']);
  if (kind === 'component') {
    return { kind, path, effect };
  }
  if (kind === 'folder') {
    return { kind, path, effect };
  }
  throw new Error('A component rule is for a "component" or a "folder"');
}

function parseEffect(input: unknown): ComponentRuleEffect {
  if (input === undefined || input === 'hide') {
    return 'hide';
  }
  if (input === 'show') {
    return 'show';
  }
  throw new Error('A component rule hides or shows');
}

function ruleKey(rule: Pick<ComponentRule, 'kind' | 'path'>): string {
  return `${rule.kind}:${rule.path}`;
}

/** The rule as the file stores it: `effect` is written only for `show`, since hiding is the default. */
export function storedComponentRule(rule: ComponentRule): Readonly<Record<string, string>> {
  return rule.effect === 'show' ? { kind: rule.kind, path: rule.path, effect: 'show' } : { kind: rule.kind, path: rule.path };
}

/** Builds the lookup for `rules`. */
export function componentAccessIndex(rules: readonly ComponentRule[]): ComponentAccessIndex {
  assert(rules.length <= COMPONENT_ACCESS_LIMITS.rulesMax, 'Component rules are bounded');
  const components = new Map<string, ComponentRuleEffect>();
  const folders = new Map<string, ComponentRuleEffect>();
  for (const rule of rules) {
    (rule.kind === 'component' ? components : folders).set(rule.path, rule.effect);
  }
  assert(components.size + folders.size <= rules.length, 'The index never holds more than the rules');
  return { components, folders };
}

/** How `file` resolves: its own rule, else the nearest folder rule above it, else visible. */
export function resolveComponent(index: ComponentAccessIndex, file: string): ComponentResolution {
  assert(file.length > 0, 'A component has a file');
  assert(!file.startsWith('/'), 'A component file is project-relative');
  const own = index.components.get(file);
  if (own !== undefined) {
    return { state: stateOf(own), decision: { kind: 'component', effect: own } };
  }
  return resolveInFolders(index, file);
}

/** How `path` resolves from the folders above it alone, ignoring a rule on `path` itself. */
export function inheritedState(index: ComponentAccessIndex, path: string): ComponentResolution {
  assert(path.length > 0, 'A path is named');
  return resolveInFolders(index, path);
}

function resolveInFolders(index: ComponentAccessIndex, path: string): ComponentResolution {
  if (index.folders.size === 0) {
    return { state: 'visible', decision: { kind: 'default' } };
  }
  const segments = path.split('/');
  assert(segments.length <= COMPONENT_ACCESS_LIMITS.pathDepthMax + 1, 'A path is within the depth bound');
  // The deepest folder first: the most specific rule wins.
  for (let depth = Math.min(segments.length - 1, COMPONENT_ACCESS_LIMITS.pathDepthMax); depth >= 1; depth -= 1) {
    const folder = segments.slice(0, depth).join('/');
    const effect = index.folders.get(folder);
    if (effect !== undefined) {
      return { state: stateOf(effect), decision: { kind: 'folder', folder, effect } };
    }
  }
  return { state: 'visible', decision: { kind: 'default' } };
}

function stateOf(effect: ComponentRuleEffect): ComponentState {
  return effect === 'hide' ? 'hidden' : 'visible';
}

/** Whether `rules` leave the component in `file` shown, whoever holds them. What a role is then offered is `componentOffer`. */
export function componentVisible(rules: readonly ComponentRule[], file: string): boolean {
  if (rules.length === 0) {
    return true;
  }
  return resolveComponent(componentAccessIndex(rules), file).state === 'visible';
}

// What a hidden component means to whoever holds the rules. This is the one rule every list, search and
// add guard reads (Desktop, Studio's browser and Studio's server), so no surface can answer it for itself.

/** Who is asking: the two things about a role (shared/properties/projectRoles.ts, `RoleView`) the rule reads. */
export interface ComponentViewer {
  readonly isAdmin: boolean;
  readonly componentRules: readonly ComponentRule[];
}

/**
 * How a place offers components. `browse` is a list a person reads through and picks from by hand (the
 * Components panel and its own filter box, a layout dropdown). `search` finds something to add from what
 * is typed or asked for (the insert palette, which every canvas "+" opens, and the Tag field's suggestions).
 */
export type ComponentSurface = 'browse' | 'search';

/**
 * How one viewer is offered one component: `everywhere` when no rule hides it; `browse-only` when a rule
 * hides it from an admin, who keeps it by hand but is not shown it in search; `nowhere` when a rule hides
 * it from anyone else, who may then not add it by any route.
 */
export type ComponentOffer = 'everywhere' | 'browse-only' | 'nowhere';

/** Whether an offer reaches a surface. */
export function offeredOn(offer: ComponentOffer, surface: ComponentSurface): boolean {
  switch (offer) {
    case 'everywhere':
      return true;
    case 'browse-only':
      return surface === 'browse';
    case 'nowhere':
      return false;
    default: {
      const exhaustive: never = offer;
      return exhaustive;
    }
  }
}

/**
 * A reader of `viewer`'s offers for many components: the index is built once, and with no rules nothing is
 * looked up. A component with no file of the project's (a package's) has nothing to hide by.
 */
export function componentOffers(viewer: ComponentViewer): (file: string | undefined) => ComponentOffer {
  if (viewer.componentRules.length === 0) {
    return () => 'everywhere';
  }
  const index = componentAccessIndex(viewer.componentRules);
  const hidden: ComponentOffer = viewer.isAdmin ? 'browse-only' : 'nowhere';
  return (file) => (file === undefined || resolveComponent(index, file).state === 'visible' ? 'everywhere' : hidden);
}

/** How `viewer` is offered the component in `file`. */
export function componentOffer(viewer: ComponentViewer, file: string | undefined): ComponentOffer {
  return componentOffers(viewer)(file);
}

/** The question every add guard asks: may `viewer` add the component in `file` by any route at all? */
export function componentAddable(viewer: ComponentViewer, file: string | undefined): boolean {
  return componentOffer(viewer, file) !== 'nowhere';
}

/** The items `surface` lists for `viewer`, in their order; `fileOf` names an item's file. With no rules it is the same list. */
export function offeredComponents<T>(
  viewer: ComponentViewer,
  surface: ComponentSurface,
  items: readonly T[],
  fileOf: (item: T) => string | undefined,
): readonly T[] {
  if (viewer.componentRules.length === 0) {
    return items;
  }
  const offer = componentOffers(viewer);
  const kept = items.filter((item) => offeredOn(offer(fileOf(item)), surface));
  assert(kept.length <= items.length, 'Filtering never adds components');
  return kept;
}

/**
 * The project-relative file a scanned component lives in, the identity rules are keyed by. The scan
 * names it when the host knows it; an older host leaves it out, so the folder convention rebuilds
 * it (as the preview route does). A package component has no project file: undefined.
 */
export function componentRuleFile(component: {
  readonly file?: string | undefined;
  readonly folder?: string | undefined;
  readonly name: string;
  readonly isLayout?: boolean | undefined;
  readonly origin?: { readonly kind: string } | undefined;
}): string | undefined {
  assert(component.name.length > 0, 'A component has a name');
  if (component.origin?.kind === 'package') {
    return undefined;
  }
  if (component.file !== undefined && component.file.length > 0) {
    return component.file.replaceAll('\\', '/');
  }
  const base = component.isLayout === true ? 'src/layouts' : 'src/components';
  const folder = (component.folder ?? '').replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  return [base, folder, `${component.name}.astro`].filter((part) => part !== '').join('/');
}

/**
 * The rules after setting `target` to `state`, with the fewest rules that say so. A component keeps
 * no rule when its folders already give it that state. A folder sets everything under it: the rules
 * below it are dropped, since "hide this folder" must mean all of it; then the folder keeps a rule
 * only when the folders above it differ. Throws when the result would pass the rule bound.
 */
export function setComponentState(rules: readonly ComponentRule[], target: ComponentTarget, state: ComponentState): readonly ComponentRule[] {
  assert(target.path.length > 0, 'A target names a path');
  const kept = rules.filter((rule) => !replacedBy(rule, target));
  const inherited = inheritedState(componentAccessIndex(kept.filter((rule) => rule.kind === 'folder')), target.path).state;
  const next =
    inherited === state ? kept : [...kept, { kind: target.kind, path: target.path, effect: state === 'hidden' ? ('hide' as const) : ('show' as const) }];
  if (next.length > COMPONENT_ACCESS_LIMITS.rulesMax) {
    throw new ComponentRulesBoundError(`A role has at most ${COMPONENT_ACCESS_LIMITS.rulesMax} component rules`);
  }
  assert(resolveTarget(next, target) === state, 'The target now has the state asked for');
  return next;
}

// A target's own rule, and for a folder every rule beneath it, are dropped before the new state is written.
function replacedBy(rule: ComponentRule, target: ComponentTarget): boolean {
  if (rule.kind === target.kind && rule.path === target.path) {
    return true;
  }
  return target.kind === 'folder' && rule.path.startsWith(`${target.path}/`);
}

function resolveTarget(rules: readonly ComponentRule[], target: ComponentTarget): ComponentState {
  const index = componentAccessIndex(rules);
  if (target.kind === 'component') {
    return resolveComponent(index, target.path).state;
  }
  const own = index.folders.get(target.path);
  return own === undefined ? inheritedState(index, target.path).state : stateOf(own);
}

/**
 * The rules after a component or folder moved or was renamed from `from` to `to`: every rule on it, or
 * (for a folder) beneath it, follows. A rule already at the new path is replaced by the moved one, so
 * the path keeps the visibility its owner had set.
 */
export function moveComponentRules(rules: readonly ComponentRule[], from: ComponentTarget, to: string): readonly ComponentRule[] {
  assert(from.path.length > 0, 'A move starts somewhere');
  assert(to.length > 0, 'A move ends somewhere');
  const target = parseComponentPath(to);
  const moved: ComponentRule[] = [];
  const rest: ComponentRule[] = [];
  for (const rule of rules) {
    const renamed = renamedRule(rule, from, target);
    if (renamed === undefined) {
      rest.push(rule);
    } else {
      moved.push(renamed);
    }
  }
  const movedKeys = new Set(moved.map(ruleKey));
  const next = [...rest.filter((rule) => !movedKeys.has(ruleKey(rule))), ...moved];
  assert(next.length <= rules.length, 'A move never adds rules');
  assert(moved.length === rules.length - rest.length, 'Every rule is moved or stays');
  return next;
}

// The rule at its new path, or undefined when the move does not reach it.
function renamedRule(rule: ComponentRule, from: ComponentTarget, target: string): ComponentRule | undefined {
  if (rule.kind === from.kind && rule.path === from.path) {
    return { ...rule, path: target };
  }
  if (from.kind === 'folder' && rule.path.startsWith(`${from.path}/`)) {
    return { ...rule, path: `${target}${rule.path.slice(from.path.length)}` };
  }
  return undefined;
}

/** Rules whose path matches no scanned component: a component rule naming no file, a folder rule holding none. */
export function missingComponentRules(rules: readonly ComponentRule[], files: readonly string[]): readonly ComponentRule[] {
  assert(rules.length <= COMPONENT_ACCESS_LIMITS.rulesMax, 'Component rules are bounded');
  if (rules.length === 0) {
    return rules;
  }
  const present = new Set(files);
  const folders = new Set<string>();
  for (const file of files) {
    const segments = file.split('/');
    for (let depth = 1; depth < Math.min(segments.length, COMPONENT_ACCESS_LIMITS.pathDepthMax + 1); depth += 1) {
      folders.add(segments.slice(0, depth).join('/'));
    }
  }
  const missing = rules.filter((rule) => !(rule.kind === 'component' ? present.has(rule.path) : folders.has(rule.path)));
  assert(missing.length <= rules.length, 'Missing rules are among the rules');
  return missing;
}

/** Whether two rule lists say the same thing, whatever their order. */
export function sameComponentRules(left: readonly ComponentRule[], right: readonly ComponentRule[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const keyed = new Map(left.map((rule) => [ruleKey(rule), rule.effect] as const));
  return right.every((rule) => keyed.get(ruleKey(rule)) === rule.effect);
}
