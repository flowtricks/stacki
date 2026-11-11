import type { ScanComponent } from '../../../shared/properties/projectScan';
import type { ImportDecl } from '../../../shared/page/pageNode';
import { resolveSourceImport } from '../../editor/importPaths';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';

interface ComponentReference {
  readonly name: string;
  readonly project: string | undefined;
  readonly file: string | undefined;
  readonly imports: readonly ImportDecl[];
  readonly components: readonly ScanComponent[];
}

// Component names are local bindings: Layout can import BaseLayout, and two folders
// can contain Heading. Match the imported file before considering a name fallback.
export function componentReference(context: ComponentReference): ScanComponent | undefined {
  return importedComponent(context) ?? context.components.find((item) => item.name === context.name);
}

/**
 * The file the page's import names for this component; else, when the import cannot
 * be resolved, the one component of that name, and undefined when two share it. For
 * readers that must not guess (the Style panel's green chips, componentMarkup.ts).
 */
export function componentFileOf(context: ComponentReference): string | undefined {
  const imported = importedComponent(context);
  if (imported !== undefined) {
    return imported.path;
  }
  const named = context.components.filter((item) => item.name === context.name);
  return named.length === 1 ? named[0]?.path : undefined;
}

function importedComponent(context: ComponentReference): ScanComponent | undefined {
  const specifier = context.imports.find((item) => item.name === context.name)?.path;
  const installed = context.components.find((item) => item.origin?.kind === 'package' && item.origin.importPath === specifier);
  if (installed) {
    return installed;
  }
  const root = context.project?.replaceAll('\\', '/').replace(/\/$/, '');
  const file = context.file?.replaceAll('\\', '/');
  if (specifier && root && file?.startsWith(root + '/')) {
    const resolved = resolveSourceImport(file.slice(root.length + 1), specifier);
    if (resolved) {
      return context.components.find((item) => item.path.replaceAll('\\', '/') === root + '/' + resolved);
    }
  }
  return undefined;
}

/** A page node as far as finding its components goes. */
interface ComponentUseNode {
  readonly kind: string;
  readonly name?: string;
  readonly dynamicTag?: boolean;
  readonly astroAsset?: boolean;
  readonly children?: readonly ComponentUseNode[] | undefined;
}

/**
 * The files of the components a page uses, each once, at most
 * `limit` of them: what the Style panel reads as the page loads, so an instance's
 * chips are drawn in their settled colours the first time (componentSourceCache.ts).
 * A name no file answers for without a guess is left out, as componentFileOf leaves it.
 */
export function pageComponentFiles(nodes: readonly ComponentUseNode[], context: Omit<ComponentReference, 'name'>, limit: number): readonly string[] {
  assert(Number.isSafeInteger(limit), 'pageComponentFiles: the limit is an integer');
  assert(limit > 0, 'pageComponentFiles: the limit is positive');
  const names = new Set<string>();
  // Iterative, bounded by the tree's own node limit: a page tree is parsed with it.
  const stack: ComponentUseNode[] = [...nodes];
  for (let visited = 0; visited < LIMITS.treeNodesMax && stack.length > 0; visited += 1) {
    const node = stack.pop();
    if (node === undefined) {
      break;
    }
    if (node.kind === 'component' && node.name !== undefined && node.dynamicTag !== true && node.astroAsset !== true && node.name !== 'Fragment') {
      names.add(node.name);
    }
    stack.push(...(node.children ?? []));
  }
  const files: string[] = [];
  for (const name of names) {
    const file = componentFileOf({ ...context, name });
    if (file !== undefined && !files.includes(file)) {
      files.push(file);
    }
    if (files.length >= limit) {
      break;
    }
  }
  assert(files.length <= limit, 'pageComponentFiles: bounded by the limit');
  return files;
}
