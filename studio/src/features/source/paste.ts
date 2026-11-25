import ts from 'typescript';
import { indentUnitOf } from '../../../vendor/stacki/shared/core/indent';
import { serializeNodes } from '../../../vendor/stacki/electron/parse/astroSerialize';
import { parsePageTree } from '../../../vendor/stacki/shared/page/pageNode';
import { namesUsedIn } from '../../../vendor/stacki/src/editor/frontmatterMove';
import { frontmatterRange } from './frontmatter';
import { relativeImport, resolveImport } from './imports';
import { insertFragment } from './sourceOperations';
import { nodesOf, type TreeAction } from './source';
import { carriedBindings } from './pasteBindings';

export function pasteEdits(source: string, file: string, action: Extract<TreeAction, { kind: 'paste' }>) {
  const clip = action.clipboard;
  const nodes = parsePageTree(nodesOf(clip.fragment));
  // Printed, as Desktop prints a pasted node: the copied bytes keep the indentation
  // of the place they left, and one element per line whatever they were written as.
  const edits = [insertFragment(source, action, serializeNodes(nodes, indentUnitOf(source)), false)];
  if (file === clip.file) {
    return edits;
  }
  const range = frontmatterRange(source);
  const statements = carriedBindings(clip.frontmatter, range?.value ?? '', namesUsedIn(nodes));
  if (!statements.length) {
    return edits;
  }
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const text = statements.map((statement) => rebaseImports(statement, clip.file, file)).join(eol);
  const start = range ? range.end - 3 : source.startsWith('\uFEFF') ? 1 : 0;
  edits.push({
    start,
    end: start,
    text: range ? `${text}${eol}` : `---${eol}${text}${eol}---${eol}`,
  });
  return edits;
}

// Rebase module specifiers, including dynamic imports inside carried bindings.
// All other statement text remains untouched.
function rebaseImports(statement: string, from: string, to: string) {
  const parsed = ts.createSourceFile('clipboard.ts', statement, ts.ScriptTarget.Latest, true);
  const edits: { start: number; end: number; text: string }[] = [];
  const visit = (node: ts.Node) => {
    const module =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? node.arguments[0]
          : undefined;
    if (module && ts.isStringLiteral(module) && module.text.startsWith('.')) {
      const resolved = resolveImport(from, module.text);
      if (!resolved) {
        throw new Error('The copied import points outside the project');
      }
      edits.push({
        start: module.getStart(parsed),
        end: module.end,
        text: JSON.stringify(relativeImport(to, resolved)),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    statement = statement.slice(0, edit.start) + edit.text + statement.slice(edit.end);
  }
  return statement;
}
