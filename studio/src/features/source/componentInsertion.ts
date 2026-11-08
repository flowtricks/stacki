import { indentUnitOf } from '../../../vendor/stacki/shared/core/indent';
import { serializeNodes } from '../../../vendor/stacki/electron/parse/astroSerialize';
import { defaultInstance, type InsertionDefaults } from './instanceDefaults';
import { componentImport, resolveImport, type ComponentImport } from './imports';
import { insertFragment } from './sourceOperations';
import { parsePage, type Edit, type TreeAction } from './source';

type Insert = Extract<TreeAction, { kind: 'insert' }>;
export function componentInsertionEdits(source: string, action: Insert, file: string, settings?: InsertionDefaults): Edit[] {
  if (!/^[A-Z][\w]*$/.test(action.name) || !/^[\w./@-]+\.astro$/.test(action.importPath)) {
    throw new Error('Invalid component');
  }
  const parsed = parsePage(source);
  if (!parsed.editable) {
    throw new Error(parsed.reason);
  }
  const components = settings?.imports ?? [];
  const imports = insertionImports(parsed.model.imports, file, components);
  const resolved = resolveImport(file, action.importPath, components);
  const rootName = imports.resolve(resolved, action.name, action.importPath);
  const node = defaultInstance(resolved, settings, (child, name) =>
    imports.resolve(child, name, componentImport(file, components.find((item) => item.file === child) ?? { file: child })),
  );
  const fragment = node ? serializeNodes([node], indentUnitOf(source)) : action.paired ? `<${rootName}>Text</${rootName}>` : `<${rootName} />`;
  const edits: Edit[] = [insertFragment(source, action, fragment, parsed.model.nodes.length === 0)];
  if (imports.statements.length) {
    const eol = parsed.model.eol;
    const statements = imports.statements.join(eol) + eol;
    const start = source.startsWith('---') ? 3 + eol.length : 0;
    edits.push({ start, end: start, text: start ? statements : `---${eol}${statements}---${eol}` });
  }
  return edits;
}
function insertionImports(
  imports: readonly {
    readonly name: string;
    readonly path: string;
    readonly typeOnly?: boolean;
    readonly imported?: string;
  }[],
  file: string,
  components: readonly ComponentImport[],
) {
  const available = [...imports];
  const statements: string[] = [];
  const resolve = (resolved: string | undefined, preferred: string, specifier: string) => {
    const existing = available.find(
      (item) => !item.typeOnly && !item.imported && (item.path === specifier || (resolved && resolveImport(file, item.path, components) === resolved)),
    );
    if (existing) {
      return existing.name;
    }
    let name = preferred;
    if (available.some((item) => item.name === name)) {
      name += 'Inserted';
    }
    if (available.some((item) => item.name === name)) {
      throw new Error('Import name conflict');
    }
    statements.push(`import ${name} from ${JSON.stringify(specifier)};`);
    available.push({ name, path: specifier });
    return name;
  };
  return { resolve, statements };
}
