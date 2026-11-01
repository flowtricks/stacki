import { readMetadata } from '../../ipc/projectMetadataBridge';
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
const INSTANCE_COMPONENTS_MAX = DEFAULT_LIMITS.nodesMax;

export interface ComponentInstance {
  readonly node: EditorNode;
  readonly components: readonly ScanComponent[];
}

export interface InstanceImport {
  readonly component: ScanComponent;
  readonly paths: ImportPaths;
}

export async function loadComponentInstance(component: ScanComponent, available: readonly ScanComponent[], projectPath: string): Promise<ComponentInstance> {
  const stored = await readMetadata(projectPath, 'components');
  const parsed = stored.source === undefined ? undefined : parseDefaultsSource(stored.source);
  if (parsed && !parsed.ok) {
    throw new Error(parsed.error.message);
  }
  return componentInstance(component, available, parsed?.ok ? { config: parsed.value, projectPath } : undefined);
}

export function componentInstance(
  component: ScanComponent,
  available: readonly ScanComponent[],
  settings?: { readonly config: ComponentDefaults; readonly projectPath: string },
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
  const components = new Map<string, ScanComponent>();
  const build = (recipe: ResolvedNode, depth: number): EditorNode => {
    assert(depth <= DEFAULT_LIMITS.depthMax, 'Component instance preset exceeds its depth limit');
    if ('literal' in recipe) {
      return { id: newId(), kind: 'text', value: recipe.literal };
    }
    let name: string;
    if ('component' in recipe) {
      const definition = definitions.find((entry) => fileOf(entry) === recipe.component);
      assert(definition !== undefined, 'Resolved recipe has a scanned component');
      components.set(definition.path, definition);
      name = settings ? definition.path : definition.name;
    } else {
      name = recipe.element;
    }
    const props: Record<string, Attr> = Object.fromEntries(
      Object.entries(recipe.props).map(([name, value]) => [
        name,
        typeof value === 'string' ? { type: 'string', value } : { type: 'expr', value: String(value) },
      ]),
    );
    return {
      id: newId(),
      kind: 'component' in recipe ? 'component' : 'element',
      name,
      props,
      children:
        recipe.content.kind === 'empty'
          ? undefined
          : recipe.content.kind === 'text'
            ? [{ id: newId(), kind: 'text', value: recipe.content.text }]
            : recipe.content.children.map((child) => build(child, depth + 1)),
    };
  };
  const node = build(result.value, 0);
  return { node, components: [...components.values()] };
}

export function componentInstancePlacement(
  model: EditorModel,
  instance: ComponentInstance,
  resolved: readonly InstanceImport[],
): { readonly node: EditorNode; readonly imports: readonly ImportDecl[] } {
  assert(resolved.length === instance.components.length, 'Every instance dependency is resolved');
  assert(resolved.length <= INSTANCE_COMPONENTS_MAX, 'Instance imports exceed the preset limit');
  const imports = [...model.imports];
  const taken = namesInScope(model.extraFrontmatter ?? '', imports);
  const names = new Map<string, string>();
  for (const { component, paths } of resolved) {
    const importPath = chooseImportPath(model, paths);
    const existing = imports.find((item) => item.path === importPath || item.path === paths.relative);
    if (existing) {
      names.set(component.name, existing.name);
      names.set(component.path, existing.name);
    } else {
      const name = componentInstanceName(component.name, taken);
      taken.add(name);
      names.set(component.name, name);
      names.set(component.path, name);
      imports.push({ name, path: importPath, quote: "'" });
    }
  }
  return { node: componentInstanceRename(instance.node, names, 0), imports };
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
