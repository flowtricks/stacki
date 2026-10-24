import ts from 'typescript';
import path from 'node:path';
import { parsePropSchema } from '../../../vendor/stacki/electron/parse/astroPropSchema';

// Resolve imported declarations per component so an unrelated Props type cannot
// shadow the component's own Props. TypeScript parses declarations; none execute.
export async function componentSchema(
  file: string,
  source: string,
  readSource: (file: string) => Promise<string>,
) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1] ?? '';
  const syntax = ts.createSourceFile(file + '.ts', frontmatter, ts.ScriptTarget.Latest);
  const prelude: string[] = [];
  for (const statement of syntax.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    if (!isDeclarationImport(specifier)) {
      continue;
    }
    const target = specifier.startsWith('@/')
      ? 'src/' + specifier.slice(2)
      : path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
    if (
      (!target.startsWith('src/') && !target.startsWith('node_modules/')) ||
      (/\.\w+$/.test(target) && !/\.(ts|js)$/.test(target))
    ) {
      continue;
    }
    let text: string | undefined;
    for (const candidate of /\.\w+$/.test(target)
      ? [target]
      : [target + '.ts', target + '/index.ts']) {
      try {
        text = await readSource(candidate);
        break;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
          throw error;
        }
      }
    }
    if (!text) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    const names =
      bindings && ts.isNamedImports(bindings)
        ? bindings.elements.map((item) => ({
            original: item.propertyName?.text ?? item.name.text,
            local: item.name.text,
          }))
        : [];
    const imported = ts.createSourceFile(target, text, ts.ScriptTarget.Latest);
    for (const declaration of imported.statements) {
      if (!ts.isTypeAliasDeclaration(declaration) && !ts.isInterfaceDeclaration(declaration)) {
        continue;
      }
      const name = names.find((item) => item.original === declaration.name.text);
      if (!name) {
        continue;
      }
      const start = declaration.getStart(imported);
      const nameStart = declaration.name.getStart(imported) - start;
      const declarationText = declaration.getText(imported);
      prelude.push(
        declarationText.slice(0, nameStart) +
          name.local +
          declarationText.slice(nameStart + declaration.name.text.length),
      );
    }
  }
  return parsePropSchema(source, prelude.join('\n'));
}

function isDeclarationImport(specifier: string): boolean {
  // Vite asset queries are not declaration modules. Resolving them as a .ts
  // path rejects valid projects that import SVG badges with ?url or ?raw.
  if (/[?#]/.test(specifier)) {
    return false;
  }
  return specifier.startsWith('.') || specifier.startsWith('@/');
}
