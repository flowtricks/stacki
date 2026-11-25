import { metadataVersionNow, readMetadata } from '../../ipc/projectMetadataBridge';
import { parseDefaultsSource } from '../../../shared/properties/componentDefaults';
import { LIMITS } from '../../../shared/core/limits';
// Insertion presets belong to page instances. Component schemas and source
// defaults stay authored by the project, so existing instances never change.
import { assert } from '../../../shared/core/assert';
import type { Attr, ImportDecl } from '../../../shared/page/pageNode';
import type { ScanComponent } from '../../../shared/properties/projectScan';
import { namesInScope } from '../../editor/dataSuggest';
import type { EditorModel, EditorNode } from '../../editor/pageView';
import type { ImportPaths } from '../../ipc/appBridge';
import { newId } from './nodeFactory';
import { WarmReads } from './componentWarm';
import { chooseImportPath } from './pageGestures';

export { INSTANCE_HEADING, INSTANCE_PARAGRAPH } from '../../../shared/properties/componentStarterDefaults';
import { starterDefaults } from '../../../shared/properties/componentStarterDefaults';
import {
  DEFAULT_LIMITS,
  resolveComponentRecipe,
  type ComponentDefaults,
  type DefaultComponent,
  type ResolvedNode,
} from '../../../shared/properties/componentDefaults';
import { assetBindingName, defaultAttributes, isFragmentTag, withoutMissingAssets } from '../../../shared/properties/componentDefaultValues';
import { missingAssetFiles } from '../../features/componentDefaults/defaultsHost';
const INSTANCE_COMPONENTS_MAX = DEFAULT_LIMITS.nodesMax;

export interface ComponentInstance {
  readonly node: EditorNode;
  readonly components: readonly ScanComponent[];
  /** The files under src/ its default values import, each once. */
  readonly assets: readonly string[];
  /** Astro's built-ins among its children, which the page imports by name. */
  readonly builtins: readonly Builtin[];
  /** Asset defaults left out because their file is gone: said to the person who inserts it. */
  readonly missing: readonly string[];
  /** The instance with each asset's import under the name the page gives its file. */
  readonly bind: (assetName: (file: string) => string) => EditorNode;
}

export interface Builtin {
  readonly tag: string;
  readonly from: string;
}
// The name a built-in's node holds until the page's import for it is chosen.
const builtinKey = (builtin: Builtin): string => `${builtin.from}#${builtin.tag}`;

export interface InstanceImport {
  readonly component: ScanComponent;
  readonly paths: ImportPaths;
}
export interface InstanceAssetImport {
  readonly asset: string;
  readonly paths: ImportPaths;
}

/** The project's component defaults, read once for a moment so a pick finds them ready (componentWarm.ts). */
export const warmDefaults = new WarmReads<Awaited<ReturnType<typeof readMetadata>>>();

export async function loadComponentInstance(component: ScanComponent, available: readonly ScanComponent[], projectPath: string): Promise<ComponentInstance> {
  const stored = await warmDefaults.read(`${projectPath}|${metadataVersionNow()}`, Date.now(), () => readMetadata(projectPath, 'components'));
  const parsed = stored.source === undefined ? undefined : parseDefaultsSource(stored.source);
  if (parsed && !parsed.ok) {
    throw new Error(parsed.error.message);
  }
  if (!parsed?.ok) {
    return componentInstance(component, available);
  }
  // A file a default imports may have been deleted since: the insert goes without it rather than with a broken import.
  const missingAssets = await missingAssetFiles(projectPath, parsed.value);
  if (missingAssets.length === 0) {
    return componentInstance(component, available, { config: parsed.value, projectPath });
  }
  // The warm read may be from before a move the app made, which rewrote the file: read it again before leaving anything out.
  const fresh = await readMetadata(projectPath, 'components');
  const again = fresh.source === undefined ? undefined : parseDefaultsSource(fresh.source);
  const config = again?.ok ? again.value : parsed.value;
  return componentInstance(component, available, { config, projectPath, missingAssets: await missingAssetFiles(projectPath, config) });
}

/** What placing `instance` on the page at `pagePath` imports, each specifier asked of the host. */
export async function resolveInstanceImports(
  instance: ComponentInstance,
  projectPath: string,
  resolve: (target: string) => Promise<ImportPaths>,
): Promise<readonly (InstanceImport | InstanceAssetImport)[]> {
  return Promise.all<InstanceImport | InstanceAssetImport>([
    ...instance.components.map(async (component) => ({ component, paths: await resolve(component.path) })),
    ...instance.assets.map(async (asset) => ({ asset, paths: await resolve(`${projectPath}/${asset}`) })),
  ]);
}

export function componentInstance(
  component: ScanComponent,
  available: readonly ScanComponent[],
  settings?: { readonly config: ComponentDefaults; readonly projectPath: string; readonly missingAssets?: readonly string[] },
): ComponentInstance {
  const definitions = [component, ...available.filter((entry) => entry.path !== component.path)];
  const fileOf = (entry: ScanComponent) =>
    settings ? entry.path.replaceAll('\\', '/').slice(settings.projectPath.replaceAll('\\', '/').replace(/\/$/, '').length + 1) : entry.path;
  const catalog: readonly DefaultComponent[] = definitions.map((entry) => ({
    file: fileOf(entry),
    name: entry.name,
    props: (entry.schema ?? []).map((field) => field.name),
    slots: entry.slots ?? [],
    slotText: entry.slotText ?? false,
  }));
  const result = resolveComponentRecipe(fileOf(component), settings?.config ?? starterDefaults(catalog), catalog);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  const gone = new Set(settings?.missingAssets);
  const pruned = withoutMissingAssets(result.value, (file) => !gone.has(file));
  const components = new Map<string, ScanComponent>();
  const assets = new Set<string>();
  const builtins = new Map<string, Builtin>();
  const build = (recipe: ResolvedNode, depth: number, assetName: (file: string) => string): EditorNode => {
    assert(depth <= DEFAULT_LIMITS.depthMax, 'Component instance preset exceeds its depth limit');
    if ('literal' in recipe) {
      if (recipe.verbatim === undefined) {
        return { id: newId(), kind: 'text', value: recipe.literal };
      }
      return recipe.verbatim.startsWith('<!--')
        ? { id: newId(), kind: 'comment', value: recipe.verbatim.slice(4, -3) }
        : { id: newId(), kind: 'expr', value: recipe.verbatim };
    }
    const props: Record<string, Attr> = Object.fromEntries(
      defaultAttributes(recipe, (file) => {
        assets.add(file);
        return assetName(file);
      }),
    );
    let name: string;
    // A Fragment or a built-in is written as a component the project does not hold; an SVG tag is an element.
    let asComponent = 'component' in recipe;
    let shorthand = false;
    if ('component' in recipe) {
      const definition = definitions.find((entry) => fileOf(entry) === recipe.component);
      assert(definition !== undefined, 'Resolved recipe has a scanned component');
      components.set(definition.path, definition);
      name = settings ? definition.path : definition.name;
    } else if (recipe.from !== undefined && recipe.tag !== undefined) {
      const builtin = { tag: recipe.tag, from: recipe.from };
      builtins.set(builtinKey(builtin), builtin);
      name = builtinKey(builtin);
      asComponent = true;
    } else if (isFragmentTag(recipe.tag)) {
      name = 'Fragment';
      asComponent = true;
      shorthand = recipe.tag === '<>' && Object.keys(props).length === 0;
    } else {
      name = recipe.tag ?? recipe.element;
    }
    return {
      id: newId(),
      kind: asComponent ? 'component' : 'element',
      name,
      ...(shorthand ? { shorthand: true } : {}),
      props,
      children:
        recipe.content.kind === 'empty'
          ? undefined
          : recipe.content.kind === 'text'
            ? [{ id: newId(), kind: 'text', value: recipe.content.text }]
            : recipe.content.children.map((child) => build(child, depth + 1, assetName)),
    };
  };
  // A first pass finds the components and assets; binding builds it again once the page has named the assets.
  const bind = (assetName: (file: string) => string): EditorNode => build(pruned.node, 0, assetName);
  const node = bind((file) => assetBindingName(file, new Set()));
  return { node, components: [...components.values()], assets: [...assets], builtins: [...builtins.values()], missing: pruned.missing, bind };
}

export function componentInstancePlacement(
  model: EditorModel,
  instance: ComponentInstance,
  resolved: readonly (InstanceImport | InstanceAssetImport)[],
): { readonly node: EditorNode; readonly imports: readonly ImportDecl[] } {
  assert(resolved.length === instance.components.length + instance.assets.length, 'Every instance dependency is resolved');
  assert(resolved.length <= INSTANCE_COMPONENTS_MAX, 'Instance imports exceed the preset limit');
  const imports = [...model.imports];
  const taken = namesInScope(model.extraFrontmatter ?? '', imports);
  const names = new Map<string, string>();
  const assetNames = new Map<string, string>();
  for (const dependency of resolved) {
    const importPath = chooseImportPath(model, dependency.paths);
    // The page's own import of the same file is used again: only a default import stands for the whole file.
    const existing = imports.find((item) => !item.named && (item.path === importPath || item.path === dependency.paths.relative));
    let name = existing?.name;
    if (name === undefined) {
      name = 'asset' in dependency ? assetBindingName(dependency.asset, taken) : componentInstanceName(dependency.component.name, taken);
      taken.add(name);
      imports.push({ name, path: importPath, quote: "'" });
    }
    if ('asset' in dependency) {
      assetNames.set(dependency.asset, name);
    } else {
      names.set(dependency.component.name, name);
      names.set(dependency.component.path, name);
    }
  }
  for (const builtin of instance.builtins) {
    const existing = imports.find((item) => item.named === true && item.path === builtin.from && (item.imported ?? item.name) === builtin.tag);
    let name = existing?.name;
    if (name === undefined) {
      name = componentInstanceName(builtin.tag, taken);
      taken.add(name);
      imports.push({ name, imported: builtin.tag, named: true, path: builtin.from, quote: "'" });
    }
    names.set(builtinKey(builtin), name);
  }
  names.set('Fragment', names.get('Fragment') ?? 'Fragment');
  const bound =
    instance.assets.length === 0
      ? instance.node
      : instance.bind((file) => {
          const name = assetNames.get(file);
          assert(name !== undefined, 'Every asset of the instance has an import binding');
          return name;
        });
  return { node: componentInstanceRename(bound, names, 0), imports };
}

function componentInstanceName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) {
    return base;
  }
  // With N occupied names, one of N + 1 numbered candidates must be free.
  for (let suffix = 2; suffix <= taken.size + 2; suffix += 1) {
    const candidate = `${base}${suffix}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  throw new Error('Unable to allocate an instance import name');
}

function componentInstanceRename(node: EditorNode, names: ReadonlyMap<string, string>, depth: number): EditorNode {
  assert(depth <= LIMITS.treeDepthMax, 'Instance rename exceeds the page tree depth');
  assert(depth <= DEFAULT_LIMITS.depthMax, 'Instance rename exceeds the preset depth');
  if (node.kind !== 'component' && node.kind !== 'element') {
    return node;
  }
  const name = node.kind === 'component' ? names.get(node.name) : node.name;
  assert(name !== undefined, 'Every inserted component has an import binding');
  return {
    ...node,
    name,
    children: node.children?.map((child) => componentInstanceRename(child, names, depth + 1)),
  };
}
