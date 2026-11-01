import type { ScanComponent } from '../../../shared/properties/projectScan';
import type { ImportDecl } from '../../../shared/page/pageNode';
import { resolveSourceImport } from '../../editor/importPaths';

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
  return context.components.find((item) => item.name === context.name);
}
